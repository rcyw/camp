import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const runtimePackage = fileURLToPath(new URL('..', import.meta.url));
export const defaultBundle = join(runtimePackage, '.local/toolchain-bundle');
export const toolchainLock = JSON.parse(await readFile(new URL('../toolchain.lock.json', import.meta.url), 'utf8'));
const hex = /^[a-f0-9]{64}$/;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const failure = message => Object.assign(new Error(message), { code: 'camp_toolchain_invalid' });

/** Read a regular file without following a final symlink or waiting on a FIFO. */
export async function regularBytes(path, maximum = 1024 * 1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw failure('Toolchain metadata must be a bounded regular file');
    const result = await file.readFile();
    if (result.length > maximum) throw failure('Toolchain metadata exceeded its byte limit');
    return result;
  } finally { await file.close(); }
}

export async function fileDigest(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw failure('Toolchain artifacts must be regular files');
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    return { sha256: hash.digest('hex'), size: stat.size, mode: stat.mode & 0o777 };
  } finally { await file.close(); }
}

export function hostAbi() {
  return { platform: process.platform, arch: process.arch, nodeMajor: Number(process.versions.node.split('.')[0]), nodeModules: process.versions.modules, napi: process.versions.napi, glibc: process.report.getReport().header.glibcVersionRuntime ?? null };
}
export function assertHostAbi(required, actual = hostAbi()) {
  if (!required || ['platform', 'arch', 'nodeMajor', 'nodeModules'].some(key => required[key] !== actual[key])) throw failure('Toolchain does not match this host platform, architecture or Node ABI');
  if (required.platform !== 'linux' || !required.glibc || !actual.glibc) throw failure('This toolchain requires a Linux glibc host');
  const version = value => value.split('.').map(Number);
  const [needMajor, needMinor] = version(required.glibc), [major, minor] = version(actual.glibc);
  if (major < needMajor || (major === needMajor && minor < needMinor)) throw failure('Host glibc is older than the toolchain build host');
}

/** The bundle is an operator artifact. It contains no credentials or project state. */
export async function artifactInventory(root) {
  const result = [];
  async function walk(folder) {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const name = relative(root, path).split('\\').join('/');
        if (name !== 'manifest.json') result.push({ path: name, ...await fileDigest(path) });
      } else throw failure('Toolchain bundles cannot contain links or special files');
      if (result.length > 1000) throw failure('Toolchain bundle has too many files');
    }
  }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('Toolchain bundle must be an ordinary directory');
  await walk(root);
  return result;
}
export function bundlePaths(root) {
  root = resolve(root);
  return { root, sdkEntry: join(root, 'layerfs/sdk/src/index.js'), native: join(root, 'layerfs/layerfs.node'), daemon: join(root, 'layerfs/layerfs-daemon'), dshArchive: join(root, 'dsh-runtime.tar') };
}
export async function loadToolchain(root = defaultBundle, { checkAbi = true } = {}) {
  root = resolve(root);
  const bytes = await regularBytes(join(root, 'manifest.json'));
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { throw failure('Invalid toolchain manifest JSON'); }
  if (manifest?.schemaVersion !== 1 || manifest.kind !== 'camp-toolchain' || manifest.inputs?.layerfs?.revision !== toolchainLock.layerfs.revision || manifest.inputs?.layerfs?.cargoLockSha256 !== toolchainLock.layerfs.cargoLockSha256 || manifest.inputs?.layerfs?.cargoConfigSha256 !== toolchainLock.layerfs.cargoConfigSha256 || manifest.inputs?.dsh?.version !== toolchainLock.dsh.version || manifest.inputs?.dsh?.lockSha256 !== toolchainLock.dsh.lockSha256 || !Array.isArray(manifest.files) || manifest.files.length > 1000) throw failure('Toolchain inputs differ from the locked versions');
  const names = new Set();
  for (const item of manifest.files) {
    if (!item || typeof item.path !== 'string' || isAbsolute(item.path) || item.path.split('/').some(part => !part || part === '.' || part === '..') || item.path.includes('\\') || item.path === 'manifest.json' || names.has(item.path) || !hex.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 || !Number.isSafeInteger(item.mode) || item.mode < 0 || item.mode > 0o777) throw failure('Invalid toolchain artifact identity');
    names.add(item.path);
  }
  for (const name of ['layerfs/sdk/src/index.js', 'layerfs/layerfs.node', 'layerfs/layerfs-daemon', 'layerfs/Cargo.lock', 'licenses/LayerFS-LICENSE', 'licenses/DSH-LICENSE', 'licenses/Camp-LICENSE', 'licenses/Rust-dependencies.json', 'dsh-runtime.tar', 'dsh-package-lock.json', 'dsh-plugin.tar', 'camp-protocol.tar']) if (!names.has(name)) throw failure('Toolchain bundle is incomplete');
  const inventory = await artifactInventory(root);
  if (inventory.length !== manifest.files.length || inventory.some(item => !manifest.files.some(expected => expected.path === item.path && expected.sha256 === item.sha256 && expected.size === item.size && expected.mode === item.mode))) throw failure('Toolchain artifact hash, size, mode or inventory differs from its manifest');
  for (const [path, expected] of [['layerfs/Cargo.lock', toolchainLock.layerfs.cargoLockSha256], ['dsh-package-lock.json', toolchainLock.dsh.lockSha256]]) if (inventory.find(item => item.path === path).sha256 !== expected) throw failure('Bundled dependency locks differ from the locked inputs');
  if (checkAbi) assertHostAbi(manifest.host);
  return { ...bundlePaths(root), manifest, digest: sha256(bytes) };
}
