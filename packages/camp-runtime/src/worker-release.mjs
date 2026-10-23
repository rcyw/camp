import { constants } from 'node:fs';
import { lstat, open, mkdir, readdir, realpath, chmod, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const runtimeFiles = [
  'attempt-scratch', 'candidate', 'change-set', 'dsh-session-loader', 'durable-state', 'export',
  'host-manager', 'index', 'integration-ancestry', 'integration-completion', 'integration-tree',
  'integration', 'local-doctor', 'model-proxy', 'native-store', 'plugin-package', 'pool-state',
  'private-artifacts', 'project-lock', 'quiesce-agent', 'resource-policy', 'restore-binding',
  'run-limits', 'run-policy', 'safe-export', 'sdk-call', 'session-archive', 'snapshot-stream',
  'source-snapshot', 'storage-identity', 'store-sqlite', 'toolchain', 'verification', 'worker-core',
  'worker-ops', 'worker-pool', 'worker-preflight', 'worker-protocol', 'worker-recovery', 'worker',
  'worker-release',
].map(name => `packages/camp-runtime/src/${name}.mjs`);
export const WORKER_RELEASE_FILES = Object.freeze([
  'LICENSE', 'packages/camp-runtime/package.json', 'packages/camp-runtime/toolchain.lock.json',
  ...runtimeFiles,
  ...['doctor', 'worker-pool', 'worker-ops', 'storage', 'artifacts', 'export', 'verify-worker-release'].map(name => `packages/camp-runtime/scripts/${name}.mjs`),
  'packages/camp-protocol/package.json', 'packages/camp-protocol/src/index.js', 'packages/camp-protocol/src/index.d.ts',
  'packages/dsh-plugin/package.json', 'packages/dsh-plugin/protocol.json', 'packages/dsh-plugin/cordis.patch.yml',
  ...['client', 'index', 'protocol'].map(name => `packages/dsh-plugin/src/${name}.js`),
  ...['prepare-profile', 'check-installed'].map(name => `packages/dsh-plugin/scripts/${name}.mjs`),
].sort());
export const WORKER_RELEASE_ACP_SOURCE = 'packages/daemon/src/drivers/dshAcp.ts';
export const WORKER_RELEASE_ACP_OUTPUT = 'packages/camp-runtime/src/generated/dsh-acp.mjs';
export const WORKER_RELEASE_MANIFEST = 'worker-release.json';
const files = [...WORKER_RELEASE_FILES, WORKER_RELEASE_ACP_OUTPUT].sort();
const maximumFileBytes = 2 * 1024 * 1024, maximumTotalBytes = 16 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const fail = message => Object.assign(new Error(message), { code: 'camp_worker_release_invalid' });
const sourceRootDefault = fileURLToPath(new URL('../../../', import.meta.url));

function safePath(path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\') || [...path].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) || path.split('/').some(part => !part || part === '.' || part === '..')) throw fail('Release file paths must be canonical relative paths');
  return path;
}
async function canonicalDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== resolve(path)) throw fail('Release directories must not contain symbolic links');
  return stat;
}
async function readOrdinary(root, path, maximum = maximumFileBytes) {
  safePath(path);
  await canonicalDirectory(root);
  let folder = root;
  for (const component of path.split('/').slice(0, -1)) { folder = join(folder, component); await canonicalDirectory(folder); }
  const file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw fail('Release inputs must be bounded ordinary files');
    const data = Buffer.alloc(stat.size + 1); let size = 0;
    while (size < data.length) { const part = await file.read(data, size, data.length - size); if (!part.bytesRead) break; size += part.bytesRead; }
    if (size !== stat.size) throw fail('Release input changed while reading');
    return { bytes: data.subarray(0, size), mode: stat.mode & 0o7777 };
  } finally { await file.close(); }
}
async function writeOrdinary(root, path, bytes) {
  const parts = safePath(path).split('/'); let folder = root;
  for (const component of parts.slice(0, -1)) {
    folder = join(folder, component);
    try { await mkdir(folder, { mode: 0o755 }); await chmod(folder, 0o755); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await canonicalDirectory(folder); }
  }
  const file = await open(join(root, path), 'wx', 0o644);
  try { await file.writeFile(bytes); await file.chmod(0o644); await file.sync(); }
  finally { await file.close(); }
}
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
function runtimeDescriptor(bytes) {
  const source = JSON.parse(bytes.toString('utf8'));
  return {
    name: source.name, version: source.version, private: true, type: 'module', license: 'FSL-1.1-ALv2', exports: './src/index.mjs',
    scripts: {
      worker: 'node src/worker.mjs', 'worker:pool': 'node scripts/worker-pool.mjs', doctor: 'node scripts/doctor.mjs',
      'worker:ops': 'node scripts/worker-ops.mjs', storage: 'node scripts/storage.mjs', artifacts: 'node scripts/artifacts.mjs',
      export: 'node scripts/export.mjs', 'verify:release': 'node scripts/verify-worker-release.mjs',
    },
  };
}
function checkedManifest(value) {
  if (!only(value, ['schemaVersion', 'kind', 'version', 'nodeMajor', 'source', 'external', 'files']) || value.schemaVersion !== 1 || value.kind !== 'camp-worker-release' || value.nodeMajor !== 24 || !/^\d+\.\d+\.\d+$/.test(value.version ?? '')
    || !only(value.source, ['commit', 'acpPath', 'acpSha256', 'runtimePackageSha256', 'compiler', 'node']) || !commit(value.source.commit) || value.source.acpPath !== WORKER_RELEASE_ACP_SOURCE || !sha(value.source.acpSha256) || !sha(value.source.runtimePackageSha256) || value.source.compiler !== 'node:module.stripTypeScriptTypes/transform' || typeof value.source.node !== 'string' || !value.source.node.startsWith('v24.')
    || !only(value.external, ['toolchainDigest', 'imageId']) || !sha(value.external.toolchainDigest) || !/^sha256:[a-f0-9]{64}$/.test(value.external.imageId ?? '') || !Array.isArray(value.files) || value.files.length !== files.length) throw fail('Invalid Worker release manifest');
  const names = new Set(); let bytes = 0;
  for (const entry of value.files) {
    if (!only(entry, ['path', 'size', 'mode', 'sha256']) || !files.includes(safePath(entry.path)) || names.has(entry.path) || !sha(entry.sha256) || entry.mode !== 0o644 || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maximumFileBytes) throw fail('Invalid Worker release file identity');
    names.add(entry.path); bytes += entry.size;
  }
  if (bytes > maximumTotalBytes || files.some(path => !names.has(path))) throw fail('Worker release exceeds its fixed file inventory');
  return value;
}

/** Verify bytes without importing any packaged code. Expected digest comes
 * from the reviewed publisher; an unsigned self-manifest is not attestation. */
export async function verifyWorkerRelease(directory, { expectedDigest, expectedSourceCommit, expectedToolchainDigest, expectedImageId } = {}) {
  const root = resolve(directory), manifestFile = await readOrdinary(root, WORKER_RELEASE_MANIFEST, 65536);
  if (expectedDigest !== undefined && (!sha(expectedDigest) || hash(manifestFile.bytes) !== expectedDigest)) throw fail('Worker release manifest digest differs');
  const manifest = checkedManifest(JSON.parse(manifestFile.bytes.toString('utf8')));
  if (expectedSourceCommit !== undefined && manifest.source.commit !== expectedSourceCommit || expectedToolchainDigest !== undefined && manifest.external.toolchainDigest !== expectedToolchainDigest || expectedImageId !== undefined && manifest.external.imageId !== expectedImageId) throw fail('Worker release provenance or external deployment differs');
  const allowedFiles = new Set([...files, WORKER_RELEASE_MANIFEST]), allowedDirectories = new Set(['']);
  for (const path of files) { let parent = dirname(path); while (parent !== '.') { allowedDirectories.add(parent); parent = dirname(parent); } }
  let visited = 0; const seen = new Set();
  async function walk(path) {
    const folder = path ? join(root, path) : root, stat = await canonicalDirectory(folder);
    if ((stat.mode & 0o7777) !== 0o755) throw fail('Worker release directory permissions differ');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++visited > 256) throw fail('Worker release has too many entries');
      const name = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory() && allowedDirectories.has(name)) await walk(name);
      else if (entry.isFile() && allowedFiles.has(name)) seen.add(name);
      else throw fail('Worker release contains an unexpected file, directory, link or special file');
    }
  }
  await walk('');
  if (seen.size !== allowedFiles.size || manifestFile.mode !== 0o644) throw fail('Worker release inventory or manifest permissions differ');
  for (const entry of manifest.files) {
    const { bytes, mode } = await readOrdinary(root, entry.path);
    if (mode !== entry.mode || bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw fail('Worker release file hash, size or permissions differ');
  }
  return { directory: root, digest: hash(manifestFile.bytes), manifest };
}

/** Build an explicit source snapshot, never Git or host dependency contents.
 * sourceCommit is supplied by the caller; per-file hashes describe the actual
 * built snapshot even if the caller builds before committing it. */
export async function buildWorkerRelease({ output, sourceRoot = sourceRootDefault, sourceCommit, toolchainDigest, imageId } = {}) {
  if (Number(process.versions.node.split('.')[0]) !== 24 || !commit(sourceCommit) || !sha(toolchainDigest) || !/^sha256:[a-f0-9]{64}$/.test(imageId ?? '') || typeof output !== 'string' || !output) throw fail('Use Node 24 and explicit output, source commit, toolchain digest and exact image ID');
  const root = resolve(output), source = resolve(sourceRoot); await canonicalDirectory(source); await canonicalDirectory(dirname(root));
  if (root === source) throw fail('Worker release output must not replace its source');
  // Exclusive mkdir reserves the final name. An incomplete output has no
  // manifest and cannot verify; failures remove only our newly created tree.
  await mkdir(root, { mode: 0o700 }); const created = await lstat(root);
  try {
    await chmod(root, 0o700);
    const packageSource = (await readOrdinary(source, 'packages/camp-runtime/package.json')).bytes;
    const runtimePackage = runtimeDescriptor(packageSource);
    const inventory = []; let total = 0;
    for (const path of WORKER_RELEASE_FILES) {
      const bytes = path === 'packages/camp-runtime/package.json' ? Buffer.from(JSON.stringify(runtimePackage, null, 2) + '\n') : (await readOrdinary(source, path)).bytes;
      total += bytes.length;
      if (total > maximumTotalBytes) throw fail('Worker release input exceeds its total byte budget');
      await writeOrdinary(root, path, bytes); inventory.push({ path, size: bytes.length, mode: 0o644, sha256: hash(bytes) });
    }
    const acp = (await readOrdinary(source, WORKER_RELEASE_ACP_SOURCE)).bytes;
    const compiled = Buffer.from(stripTypeScriptTypes(acp.toString('utf8'), { mode: 'transform', sourceMap: false }) + '\n');
    await writeOrdinary(root, WORKER_RELEASE_ACP_OUTPUT, compiled); inventory.push({ path: WORKER_RELEASE_ACP_OUTPUT, size: compiled.length, mode: 0o644, sha256: hash(compiled) });
    const manifest = checkedManifest({ schemaVersion: 1, kind: 'camp-worker-release', version: runtimePackage.version, nodeMajor: 24, source: { commit: sourceCommit, acpPath: WORKER_RELEASE_ACP_SOURCE, acpSha256: hash(acp), runtimePackageSha256: hash(packageSource), compiler: 'node:module.stripTypeScriptTypes/transform', node: process.version }, external: { toolchainDigest, imageId }, files: inventory.sort((a, b) => a.path.localeCompare(b.path, 'en')) });
    await writeOrdinary(root, WORKER_RELEASE_MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    await chmod(root, 0o755);
    return await verifyWorkerRelease(root, { expectedSourceCommit: sourceCommit, expectedToolchainDigest: toolchainDigest, expectedImageId: imageId });
  } catch (error) {
    const current = await lstat(root).catch(() => null);
    if (current?.isDirectory() && current.dev === created.dev && current.ino === created.ino) await rm(root, { recursive: true });
    throw error;
  }
}
