import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, readFile, writeFile, lstat, readdir, chmod } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { packPlugin } from './plugin-package.mjs';
import { runtimePackage, toolchainLock, sha256, fileDigest, hostAbi, artifactInventory } from './toolchain.mjs';

const execute = promisify(execFile);
const environment = () => ({ PATH: process.env.PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), '.cargo'), RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), '.rustup') });
export async function command(name, args, options = {}) {
  const result = await execute(name, args, { timeout: 110_000, maxBuffer: 16 * 1024 * 1024, env: environment(), ...options });
  return result.stdout.trim();
}
const gitEnvironment = () => ({ ...environment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
const gitArguments = (source, args) => ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', source, ...args];

/** Cargo discovers build.rs and src/bin targets even when Git ignores them.
 * Select actual native input roots, leaving the workspace's normal target and
 * documentation/evidence directories outside this source cleanliness check. */
export async function assertTrackedNativeInputs(source) {
  const extra = await command('git', gitArguments(source, ['ls-files', '--others', '-z', '--', '.cargo', 'core/Cargo.toml', 'core/Cargo.lock', 'core/crates', 'core/vendor', 'sdk/js/native']), { env: gitEnvironment() });
  if (extra) throw new Error('LayerFS native build inputs contain untracked or ignored files; use the pinned source tree');
}

/** Copy executable SDK inputs from Git objects, not a mutable worktree. Ignored
 * or untracked modules must never become part of the pinned SDK distribution. */
export async function copySdkFromGit({ source, destination, revision = toolchainLock.layerfs.revision }) {
  const git = async args => (await execute('git', gitArguments(source, args), { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer', env: gitEnvironment() })).stdout;
  const tree = await git(['ls-tree', '-r', '-z', '--full-tree', revision, '--', 'sdk/js/src', 'sdk/js/package.json']);
  const entries = tree.toString('utf8').split('\0').filter(Boolean).map(record => {
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(record);
    if (!match) throw new Error('Pinned SDK must contain only UTF-8 named regular files');
    const name = match[3];
    if (!(name === 'sdk/js/package.json' || name.startsWith('sdk/js/src/')) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Pinned SDK has an invalid file path');
    return { path: name.slice('sdk/js/'.length), oid: match[2], mode: Number.parseInt(match[1], 8) & 0o777 };
  });
  if (!tree.equals(Buffer.from(tree.toString('utf8'))) || entries.length > 1000 || !entries.some(entry => entry.path === 'src/index.js') || !entries.some(entry => entry.path === 'package.json')) throw new Error('Pinned SDK tree is incomplete or exceeds its file limit');
  let bytes = 0;
  for (const entry of entries) {
    const content = await git(['cat-file', 'blob', entry.oid]);
    bytes += content.length;
    if (bytes > 64 * 1024 * 1024) throw new Error('Pinned SDK exceeds its byte limit');
    const output = join(destination, entry.path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, content, { flag: 'wx', mode: entry.mode });
    await chmod(output, entry.mode);
  }
}
async function freshDirectory(path) {
  try { await lstat(path); throw new Error('Output already exists; choose a new bundle/build destination'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path, { recursive: true, mode: 0o700 });
}
export async function checkLayerfsSource(source) {
  if (!source) throw new Error('LAYERFS_SOURCE must explicitly name the pinned LayerFS checkout for a build');
  source = resolve(source);
  const git = args => command('git', gitArguments(source, args), { env: gitEnvironment() });
  if (await git(['rev-parse', 'HEAD']) !== toolchainLock.layerfs.revision) throw new Error('LayerFS checkout differs from the locked revision');
  if (await git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('LayerFS tracked source must be clean');
  await assertTrackedNativeInputs(source);
  for (const [name, expected] of [['core/Cargo.lock', toolchainLock.layerfs.cargoLockSha256], ['.cargo/config.toml', toolchainLock.layerfs.cargoConfigSha256]]) if ((await fileDigest(join(source, name))).sha256 !== expected) throw new Error(`LayerFS ${name} differs from the locked input`);
  return source;
}
export async function buildLayerfs({ source = process.env.LAYERFS_SOURCE, output = process.env.CAMP_LAYERFS_OUTPUT ?? join(runtimePackage, '.local/build/layerfs'), target = process.env.CAMP_LAYERFS_TARGET ?? join(runtimePackage, '.local/layerfs-target') } = {}) {
  source = await checkLayerfsSource(source);
  if (process.env.RUSTFLAGS || process.env.CARGO_ENCODED_RUSTFLAGS) throw new Error('Use the pinned LayerFS Cargo config without external RUSTFLAGS');
  const toolchain = toolchainLock.layerfs.rustToolchain;
  if (process.env.CAMP_RUST_TOOLCHAIN && process.env.CAMP_RUST_TOOLCHAIN !== toolchain) throw new Error('CAMP_RUST_TOOLCHAIN differs from the locked toolchain');
  const rust = await command('rustc', [`+${toolchain}`, '--version', '--verbose']);
  if (!rust.startsWith(`rustc ${toolchain} `)) throw new Error('Rust toolchain version differs from the lock');
  await command('cargo', [`+${toolchain}`, 'build', '--manifest-path', join(source, 'core/Cargo.toml'), '--offline', '--locked', '-p', 'layerfs-node', '--lib', '-p', 'layerfs-daemon', '--bins', '--target-dir', resolve(target), '-j', process.env.CAMP_BUILD_JOBS ?? '6'], { cwd: source });
  await freshDirectory(output);
  await copyFile(join(target, 'debug/liblayerfs_node.so'), join(output, 'layerfs.node'));
  await copyFile(join(target, 'debug/layerfs-daemon'), join(output, 'layerfs-daemon'));
  const metadata = { schemaVersion: 1, ...toolchainLock.layerfs, host: hostAbi(), rust, rustFlags: process.arch === 'arm64' ? ['--cfg aes_armv8', '--cfg polyval_armv8', '--cfg chacha20_force_neon', '-C target-feature=+aes,+sha2'] : [], artifacts: { native: await fileDigest(join(output, 'layerfs.node')), daemon: await fileDigest(join(output, 'layerfs-daemon')) } };
  await writeFile(join(output, 'build.json'), JSON.stringify(metadata, null, 2) + '\n');
  return { output: resolve(output), metadata };
}
export async function installDsh({ prefix = process.env.CAMP_DSH_PREFIX ?? join(runtimePackage, '.local/build/dsh'), offline = process.env.CAMP_NPM_OFFLINE === '1' } = {}) {
  const locked = join(runtimePackage, 'toolchain/dsh');
  if ((await fileDigest(join(locked, 'package-lock.json'))).sha256 !== toolchainLock.dsh.lockSha256) throw new Error('DSH dependency lock differs from the toolchain lock');
  await freshDirectory(prefix);
  await copyFile(join(locked, 'package.json'), join(prefix, 'package.json'));
  await copyFile(join(locked, 'package-lock.json'), join(prefix, 'package-lock.json'));
  await writeFile(join(prefix, '.user.npmrc'), '');
  await writeFile(join(prefix, '.global.npmrc'), '');
  await command('npm', ['ci', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', join(prefix, '.user.npmrc'), '--globalconfig', join(prefix, '.global.npmrc'), '--cache', join(runtimePackage, '.local/npm-cache'), ...(offline ? ['--offline'] : [])], { cwd: prefix });
  return resolve(prefix);
}
export async function packDsh({ prefix = process.env.CAMP_DSH_PREFIX ?? join(runtimePackage, '.local/build/dsh'), archive = process.env.CAMP_DSH_OUTPUT ?? join(runtimePackage, '.local/build/dsh-runtime.tar') } = {}) {
  if ((await fileDigest(join(prefix, 'package-lock.json'))).sha256 !== toolchainLock.dsh.lockSha256) throw new Error('Installed DSH dependency lock differs from the pinned lock');
  const manifest = JSON.parse(await readFile(join(prefix, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
  if (manifest.version !== toolchainLock.dsh.version) throw new Error('Installed DSH version differs from the pinned version');
  await mkdir(dirname(resolve(archive)), { recursive: true });
  await command('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', archive, '-C', prefix, 'node_modules', 'package.json', 'package-lock.json']);
  return resolve(archive);
}
async function rustNotices(source, output) {
  const metadata = JSON.parse(await command('cargo', [`+${toolchainLock.layerfs.rustToolchain}`, 'metadata', '--manifest-path', join(source, 'core/Cargo.toml'), '--offline', '--locked', '--format-version', '1'], { cwd: source }));
  const selected = new Set(), nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  function visit(id) {
    if (selected.has(id)) return;
    selected.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some(kind => kind.kind !== 'dev')) visit(dep.pkg);
  }
  for (const pkg of metadata.packages) if (['layerfs-node', 'layerfs-daemon'].includes(pkg.name)) visit(pkg.id);
  const notices = [];
  for (const pkg of metadata.packages.filter(pkg => selected.has(pkg.id) && !metadata.workspace_members.includes(pkg.id)).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
    const folder = dirname(pkg.manifest_path);
    const files = (await readdir(folder, { withFileTypes: true })).filter(entry => entry.isFile() && /^(?:licen[cs]e|notice|copying)(?:[._-]|$)/i.test(entry.name)).map(entry => join(folder, entry.name));
    if (pkg.license_file && !files.includes(pkg.license_file)) files.push(pkg.license_file);
    const item = { name: pkg.name, version: pkg.version, license: pkg.license, files: [] };
    for (const file of files) {
      const name = file.split('/').at(-1);
      const destination = join(output, 'licenses/rust', `${pkg.name}-${pkg.version}`, name);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(file, destination);
      item.files.push(`rust/${pkg.name}-${pkg.version}/${name}`);
    }
    notices.push(item);
  }
  await writeFile(join(output, 'licenses/Rust-dependencies.json'), JSON.stringify(notices, null, 2) + '\n');
}
export async function buildBundle({ source = process.env.LAYERFS_SOURCE, nativeDirectory = process.env.CAMP_LAYERFS_ARTIFACTS ?? join(runtimePackage, '.local/build/layerfs'), dshPrefix = process.env.CAMP_DSH_PREFIX ?? join(runtimePackage, '.local/build/dsh'), output = process.env.CAMP_TOOLCHAIN_OUTPUT ?? join(runtimePackage, '.local/toolchain-bundle') } = {}) {
  source = await checkLayerfsSource(source);
  const metadata = JSON.parse(await readFile(join(nativeDirectory, 'build.json'), 'utf8'));
  if (metadata.revision !== toolchainLock.layerfs.revision || metadata.rustToolchain !== toolchainLock.layerfs.rustToolchain || metadata.cargoLockSha256 !== toolchainLock.layerfs.cargoLockSha256 || metadata.cargoConfigSha256 !== toolchainLock.layerfs.cargoConfigSha256) throw new Error('Native build metadata differs from locked inputs');
  for (const [name, field] of [['layerfs.node', 'native'], ['layerfs-daemon', 'daemon']]) if ((await fileDigest(join(nativeDirectory, name))).sha256 !== metadata.artifacts[field].sha256) throw new Error('Native build artifact differs from its original build');
  await freshDirectory(output);
  await mkdir(join(output, 'layerfs/sdk'), { recursive: true });
  await mkdir(join(output, 'licenses'));
  await copySdkFromGit({ source, destination: join(output, 'layerfs/sdk') });
  await copyFile(join(nativeDirectory, 'layerfs.node'), join(output, 'layerfs/layerfs.node'));
  await copyFile(join(nativeDirectory, 'layerfs-daemon'), join(output, 'layerfs/layerfs-daemon'));
  await copyFile(join(nativeDirectory, 'build.json'), join(output, 'layerfs/build.json'));
  await copyFile(join(source, 'core/Cargo.lock'), join(output, 'layerfs/Cargo.lock'));
  await copyFile(join(source, 'LICENSE'), join(output, 'licenses/LayerFS-LICENSE'));
  await copyFile(join(dshPrefix, 'node_modules/@deepseek-ai/dsh/LICENSE'), join(output, 'licenses/DSH-LICENSE'));
  await copyFile(join(runtimePackage, '../../LICENSE'), join(output, 'licenses/Camp-LICENSE'));
  await rustNotices(source, output);
  await copyFile(join(dshPrefix, 'package-lock.json'), join(output, 'dsh-package-lock.json'));
  await packDsh({ prefix: dshPrefix, archive: join(output, 'dsh-runtime.tar') });
  await packPlugin({ plugin: resolve(runtimePackage, '../dsh-plugin'), archive: join(output, 'dsh-plugin.tar'), protocolArchive: join(output, 'camp-protocol.tar') });
  const manifest = { schemaVersion: 1, kind: 'camp-toolchain', inputs: { layerfs: toolchainLock.layerfs, dsh: toolchainLock.dsh }, host: metadata.host, files: await artifactInventory(output) };
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(output, 'manifest.json'), bytes, { mode: 0o600 });
  return { output: resolve(output), digest: sha256(bytes), files: manifest.files.length };
}
