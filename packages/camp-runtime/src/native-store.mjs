import { spawn } from 'node:child_process';
import { open, mkdir, mkdtemp, readdir, lstat, realpath, rename, copyFile } from 'node:fs/promises';
import { dirname, join, resolve, basename, relative } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicJson, privateDirectory, WorkerJournal, stateKey } from './durable-state.mjs';
import { acquireHostManager, assertNoManagedContainers } from './host-manager.mjs';
import { openStorageIdentity } from './storage-identity.mjs';
import { restoredVolume, validateRestoreBinding } from './restore-binding.mjs';
import { regularBytes, fileDigest, sha256, toolchainLock } from './toolchain.mjs';
import { parseStoragePlan, parseStorageBackupReceipt, parseStorageRestoreReceipt, CAMP_STORAGE_LIMITS } from '../../camp-protocol/src/index.js';
import { acquireProjectLock } from './project-lock.mjs';
import { removeOwnedDirectory } from './safe-export.mjs';
import { tmpdir } from 'node:os';

const SQLITE = fileURLToPath(new URL('./store-sqlite.mjs', import.meta.url));
const fail = (message, code = 'camp_storage_unsafe') => Object.assign(new Error(message), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, path) => { const part = relative(parent, path); return !part || part === '.' || (!part.startsWith('../') && part !== '..'); };
async function syncDirectory(path) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
async function absent(path) { try { await lstat(path); throw fail('Storage maintenance target already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
async function privateFile(path, max) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw fail('Storage bundle files must be private owned ordinary files');
  return regularBytes(path, max);
}
async function writePrivate(path, bytes) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function assertSettledHome(home) {
  let folders;
  try { folders = await readdir(join(home, 'workers')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await privateDirectory(join(home, 'workers'));
  for (const folder of folders) {
    if (!/^[a-f0-9]{32}$/.test(folder)) throw fail('Unknown worker state prevents cold storage maintenance');
    const location = join(home, 'workers', folder); await privateDirectory(location);
    const metadata = JSON.parse(await privateFile(join(location, 'worker.json'), 65536));
    if (metadata.version !== 1 || typeof metadata.apiUrl !== 'string' || typeof metadata.workerId !== 'string' || stateKey(`${metadata.apiUrl}\n${metadata.workerId}`) !== folder || metadata.pendingClaim) throw fail('Unsettled worker claim prevents cold storage maintenance');
    const journal = await new WorkerJournal({ home, apiUrl: metadata.apiUrl, workerId: metadata.workerId }).ready();
    for (const record of await journal.list()) if (record.requiresInspection || !record.cleanupKnown || !['settled', 'fenced'].includes(record.phase) || record.phase === 'fenced' && !record.cleanupAck?.acknowledgedAt || record.cancellationAck && !record.cancellationAck.acknowledgedAt && record.phase !== 'settled') throw fail('Pending outbox, inspection or resources prevent cold storage maintenance');
  }
}
async function assertUnusedVolume(runtime, volume) {
  if ((await runtime.dockerCall(['ps', '-a', '-q', '--filter', `volume=${volume}`])).stdout.trim()) throw fail('A container still uses this Store volume');
}
/** Uses SQLite's backup API under LayerFS's actual directory writer flock.
 * The child has a hard deadline and only receives fixed paths, never SQL. */
export async function sqliteStoreSnapshot({ source, destination, sealedSource = false, timeoutMs = 30 * 60_000, signal }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw fail('Invalid storage maintenance deadline');
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn('flock', ['--no-fork', '--exclusive', '--nonblock', '--conflict-exit-code', '73', dirname(source), 'setpriv', '--pdeathsig', 'KILL', process.execPath, '--no-warnings', SQLITE], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8', CAMP_STORAGE_OWNER_PID: String(process.pid) } });
    let output = '', invalid = false;
    const timer = setTimeout(() => { invalid = true; child.kill('SIGKILL'); }, timeoutMs);
    const abort = () => { invalid = true; child.kill('SIGKILL'); }; signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 65536) { invalid = true; child.kill('SIGKILL'); } }); child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(fail('SQLite maintenance process could not start', 'camp_storage_sqlite')); });
    child.once('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); try { if (invalid || code !== 0) throw fail(code === 73 ? 'Store writer is active; cold maintenance refused' : 'SQLite backup or integrity verification did not complete', 'camp_storage_sqlite'); resolveResult(JSON.parse(output)); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify({ source, sealedSource, ...(destination ? { destination } : {}) }));
  });
}
async function validateCandidates(runtime, project, plan, signal) {
  for (const candidate of plan.candidates) { signal?.throwIfAborted(); await runtime.verifyCandidate(project, candidate, { signal }); }
}
function receiptFor(manifest, manifestBytes, operationId = manifest.plan.operationId) {
  return parseStorageBackupReceipt({ schemaVersion: 1, operationId, manifestDigest: sha256(manifestBytes), storeSha256: manifest.store.sha256, bytes: manifest.store.size, toolchainDigest: manifest.toolchainDigest, imageId: manifest.imageId, candidateCount: manifest.plan.candidates.length, sourceStorageId: manifest.plan.sourceStorageId, stopped: true, verified: true });
}
function samePlan(origin, current) {
  if (!current.backupOperationId) return JSON.stringify(origin) === JSON.stringify(current);
  // Explicit backup reuse freezes the same logical snapshot. Its physical
  // location may have changed since backup; the new plan retains the current
  // epoch/location for activation CAS without rewriting the old artifact.
  if (origin.operationId !== current.backupOperationId || origin.kind !== 'backup' || current.kind !== 'migration') return false;
  const { operationId: _originId, kind: _originKind, backupOperationId: _originBackup, storageEpoch: _originEpoch, sourceStorageId: _originLocation, ...left } = origin;
  const { operationId: _currentId, kind: _currentKind, backupOperationId: _currentBackup, storageEpoch: _currentEpoch, sourceStorageId: _currentLocation, ...right } = current;
  return JSON.stringify(left) === JSON.stringify(right);
}
async function loadBundle(bundlePath, plan, runtime, { verifyStore = true, signal, sourceReceipt } = {}) {
  await lstat(bundlePath);
  await privateDirectory(bundlePath);
  const names = (await readdir(bundlePath)).sort();
  if (JSON.stringify(names) !== JSON.stringify(['manifest.json', 'project.record', 'store.sqlite'])) throw fail('Storage bundle must contain exactly its manifest, Store and private authority record');
  const manifestBytes = await privateFile(join(bundlePath, 'manifest.json'), 9 * 1024 ** 2);
  let manifest; try { manifest = JSON.parse(manifestBytes); } catch { throw fail('Invalid storage bundle manifest'); }
  const origin = parseStoragePlan(manifest.plan);
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'camp-layerfs-native-store' || manifest.profile !== 'Disposable' || manifest.layerfsRevision !== toolchainLock.layerfs.revision || !samePlan(origin, plan) || manifest.toolchainDigest !== runtime.toolchain?.digest || manifest.imageId !== runtime.imageId || manifest.imageId !== plan.acceptedCandidate.imageId || !/^[a-f0-9]{64}$/.test(manifest.store?.sha256 ?? '') || !Number.isSafeInteger(manifest.store?.size) || manifest.store.size < 512 || manifest.store.size > CAMP_STORAGE_LIMITS.maxStoreBytes || !/^[a-f0-9]{64}$/.test(manifest.record?.sha256 ?? '') || !Number.isSafeInteger(manifest.record?.size) || manifest.record.size < 1 || manifest.record.size > 65536 || !/^[a-f0-9]{64}$/.test(manifest.database?.logicalDigest ?? '')) throw fail('Storage bundle identity, plan or pinned deployment differs');
  const receipt = receiptFor(manifest, manifestBytes, plan.operationId);
  if (sourceReceipt) {
    const expected = parseStorageBackupReceipt(sourceReceipt);
    if (expected.operationId !== (plan.backupOperationId ?? plan.operationId) || Object.keys(receipt).some(key => key !== 'operationId' && receipt[key] !== expected[key])) throw fail('Bundle differs from the control side immutable backup receipt');
  }
  const record = await privateFile(join(bundlePath, 'project.record'), 65536);
  if (record.length !== manifest.record.size || sha256(record) !== manifest.record.sha256) throw fail('Private project authority record hash differs');
  const storePath = join(bundlePath, 'store.sqlite');
  await privateFileStat(storePath);
  const store = await fileDigest(storePath);
  if (store.size !== manifest.store.size || store.sha256 !== manifest.store.sha256) throw fail('Store file hash or size differs from its manifest');
  if (verifyStore) {
    const database = await sqliteStoreSnapshot({ source: storePath, sealedSource: true, signal });
    if (JSON.stringify(database) !== JSON.stringify(manifest.database)) throw fail('Store schema, integrity or complete history differs');
  }
  return { manifest: { ...manifest, plan: origin }, manifestBytes, record, receipt };
}
async function privateFileStat(path) { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw fail('Store must be a private owned ordinary file'); return stat; }
async function maintenance(options, action) {
  if (typeof options.bundlePath !== 'string' || !options.bundlePath) throw fail('A private local bundle path is required');
  const { runtime, postReceipt } = options, plan = parseStoragePlan(options.plan), bundlePath = resolve(options.bundlePath);
  if (plan.projectId !== `p-${hash(`room:${plan.roomId}`).slice(0, 16)}`) throw fail('Storage plan is not the requested room project');
  if (inside(runtime.home, bundlePath) || inside(bundlePath, runtime.home)) throw fail('Storage bundle and runtime home must not contain one another');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw fail('Invalid storage maintenance deadline');
  const timer = setTimeout(() => controller.abort(fail('Storage maintenance deadline exceeded')), timeoutMs);
  let projectLock, manager;
  try {
    manager = await (options.acquireManager ?? acquireHostManager)({ runtime, onLost: error => controller.abort(error) });
    projectLock = await acquireProjectLock(runtime, plan.projectId, { signal, onLost: error => controller.abort(error) });
    await assertNoManagedContainers(runtime);
    await assertSettledHome(runtime.home);
    await runtime.ready();
    if (!runtime.toolchain?.digest) throw fail('Native Store maintenance requires a verified pinned toolchain bundle');
    if (runtime.imageId !== plan.acceptedCandidate.imageId) throw fail('Storage operation requires the candidate exact image');
    const receipt = await action({ ...options, runtime, plan, bundlePath, manager, signal });
    signal.throwIfAborted();
    if (postReceipt) await postReceipt(receipt);
    return receipt;
  } finally { clearTimeout(timer); await projectLock?.release(); await manager?.release(); }
}
/** Cold whole-Store backup. The public file exporter deliberately cannot
 * substitute for this identity- and history-preserving private artifact. */
export async function exportNativeStore(options) {
  return maintenance(options, async ({ runtime, plan, bundlePath, manager, signal, sourceReceipt, existingOnly }) => {
    const identity = await openStorageIdentity({ home: runtime.home, dockerId: manager.facts.ID });
    if (identity.storageId !== plan.sourceStorageId) throw fail('Source physical storage differs from the frozen plan');
    const project = await runtime.loadProject(plan.projectId, { roomId: plan.roomId });
    const mountpoint = (await runtime.dockerCall(['volume', 'inspect', '--format', '{{.Mountpoint}}', project.volume])).stdout.trim();
    if (!mountpoint || project.storePath !== join(mountpoint, 'global/store.sqlite')) throw fail('Source Store differs from its controlled Docker volume');
    await assertUnusedVolume(runtime, project.volume);
    try { await lstat(bundlePath); return (await loadBundle(bundlePath, plan, runtime, { signal, sourceReceipt })).receipt; } catch (error) { if (error.code !== 'ENOENT') throw error; if (existingOnly) throw fail('The acknowledged backup must be replayed from its original existing bundle'); }
    const parent = await realpath(dirname(bundlePath));
    if (join(parent, basename(bundlePath)) !== bundlePath) throw fail('Bundle destination must have a canonical local parent');
    const working = `${bundlePath}.partial-${randomUUID()}`;
    await mkdir(working, { mode: 0o700 });
    const record = await regularBytes(join(project.home, project.projectId, 'project.record'), 65536);
    await writePrivate(join(working, 'project.record'), record);
    const database = await sqliteStoreSnapshot({ source: project.storePath, destination: join(working, 'store.sqlite'), signal });
    const validationHome = join(working, 'validation-home'); await privateDirectory(join(validationHome, project.projectId));
    await copyFile(join(working, 'project.record'), join(validationHome, project.projectId, 'project.record'));
    const copy = { ...project, home: validationHome, storePath: join(working, 'store.sqlite') };
    await validateCandidates(runtime, copy, plan, signal);
    // SDK reads can switch SQLite back to WAL. Normalize again after all SDK
    // clients have closed so only one standalone database enters the bundle.
    const normalized = join(working, 'normalized.sqlite');
    const checked = await sqliteStoreSnapshot({ source: copy.storePath, destination: normalized, signal });
    if (checked.logicalDigest !== database.logicalDigest) throw fail('Candidate validation changed Store history');
    const { rm } = await import('node:fs/promises');
    await rm(validationHome, { recursive: true });
    for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(join(working, `store.sqlite${suffix}`), { force: true });
    await rename(normalized, join(working, 'store.sqlite'));
    const store = await fileDigest(join(working, 'store.sqlite'));
    const manifest = { schemaVersion: 1, kind: 'camp-layerfs-native-store', profile: 'Disposable', layerfsRevision: toolchainLock.layerfs.revision, toolchainDigest: runtime.toolchain.digest, imageId: project.imageId, plan, database: checked, store: { sha256: store.sha256, size: store.size }, record: { sha256: sha256(record), size: record.length } };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writePrivate(join(working, 'manifest.json'), manifestBytes); await syncDirectory(working);
    signal?.throwIfAborted(); await absent(bundlePath); await rename(working, bundlePath); await syncDirectory(parent);
    return receiptFor(manifest, manifestBytes);
  });
}
/** Replay a published backup receipt after loss of the original source host.
 * Validate native candidates on an isolated copy, never reopen or invent a
 * source installation, and never mutate the immutable private bundle. */
export async function reportNativeStore(options) {
  return maintenance(options, async ({ runtime, plan, bundlePath, signal, sourceReceipt }) => {
    if (plan.backupOperationId) throw fail('Report the original backup operation rather than creating a new source receipt');
    const loaded = await loadBundle(bundlePath, plan, runtime, { signal, sourceReceipt });
    const scratch = await mkdtemp(join(tmpdir(), 'camp-storage-report-')), identity = await lstat(scratch);
    try {
      const storePath = join(scratch, 'store.sqlite');
      const copied = await sqliteStoreSnapshot({ source: join(bundlePath, 'store.sqlite'), destination: storePath, sealedSource: true, signal });
      if (JSON.stringify(copied) !== JSON.stringify(loaded.manifest.database)) throw fail('Backup report copy changed its database history');
      const home = join(scratch, 'sdk-home'); await privateDirectory(join(home, plan.projectId));
      await writePrivate(join(home, plan.projectId, 'project.record'), loaded.record);
      const project = { projectId: plan.projectId, externalId: `room:${plan.roomId}`, home, native: runtime.native, daemon: runtime.daemon, docker: runtime.docker, imageId: runtime.imageId, volume: `camp-backup-validation-${plan.operationId}`, storePath, prefix: `camp-mvp-project-${hash(`room:${plan.roomId}`).slice(0, 16)}-`, profile: 'Disposable' };
      await validateCandidates(runtime, project, plan, signal);
      const checked = await sqliteStoreSnapshot({ source: storePath, signal });
      if (checked.logicalDigest !== loaded.manifest.database.logicalDigest) throw fail('Backup report validation changed history');
      return loaded.receipt;
    } finally { await removeOwnedDirectory(scratch, identity); }
  });
}
/** Installs into a new physical volume and home. It never activates a Room,
 * overwrites a Store, copies journals or impersonates the source storage ID. */
export async function restoreNativeStore(options) {
  return maintenance(options, async ({ runtime, plan, bundlePath, manager, signal, sourceReceipt, existingRestoreReceipt }) => {
    const loaded = await loadBundle(bundlePath, plan, runtime, { signal, sourceReceipt }), { manifest, record } = loaded;
    const folder = join(runtime.home, 'projects', plan.projectId);
    try {
      const project = await runtime.loadProject(plan.projectId, { roomId: plan.roomId });
      const binding = await validateRestoreBinding(project, runtime.home);
      if (binding.receipt.operationId !== plan.operationId || binding.receipt.manifestDigest !== loaded.receipt.manifestDigest) throw fail('Target home already belongs to another restore');
      if (existingRestoreReceipt && JSON.stringify(binding.receipt) !== JSON.stringify(parseStorageRestoreReceipt(existingRestoreReceipt))) throw fail('Target differs from the control side original restore receipt');
      const existingIdentity = await openStorageIdentity({ home: runtime.home, dockerId: manager.facts.ID, create: false });
      if (!existingIdentity || existingIdentity.storageId !== binding.receipt.targetStorageId) throw fail('Restore replay physical storage identity differs from its verified installation');
      if ([plan.sourceStorageId, manifest.plan.sourceStorageId].includes(existingIdentity.storageId)) throw fail('Restore target must differ from both current placement and original backup source');
      await assertUnusedVolume(runtime, project.volume); await validateCandidates(runtime, project, plan, signal);
      const restoredHistory = await sqliteStoreSnapshot({ source: project.storePath, signal });
      if (JSON.stringify(restoredHistory) !== JSON.stringify(manifest.database)) throw fail('Restore replay history differs from the original verified installation');
      return binding.receipt;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existingRestoreReceipt) throw fail('An acknowledged restore can only replay its original existing target installation');
    if ((await readdir(runtime.home)).length) throw fail('Restore requires an entirely fresh runtime home');
    const identity = await openStorageIdentity({ home: runtime.home, dockerId: manager.facts.ID });
    if ([plan.sourceStorageId, manifest.plan.sourceStorageId].includes(identity.storageId)) throw fail('Restore must create a distinct physical storage identity');
    const volume = restoredVolume(plan.projectId, plan.operationId);
    if ((await runtime.dockerCall(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}'])).stdout.trim()) throw fail('Restore volume already exists; interrupted restoration requires inspection');
    await atomicJson(join(runtime.home, 'restore-intent.json'), { schemaVersion: 1, operationId: plan.operationId, projectId: plan.projectId, volume, manifestDigest: loaded.receipt.manifestDigest });
    await runtime.dockerCall(['volume', 'create', '--label', 'camp.mvp=true', '--label', `camp.restore=${plan.operationId}`, volume]);
    const mountpoint = (await runtime.dockerCall(['volume', 'inspect', '--format', '{{.Mountpoint}}', volume])).stdout.trim();
    if (!mountpoint || await realpath(mountpoint) !== mountpoint) throw fail('Docker restore volume has an invalid local mountpoint');
    const storeFolder = join(mountpoint, 'global'); await mkdir(storeFolder, { mode: 0o700 });
    const storePath = join(storeFolder, 'store.sqlite');
    const database = await sqliteStoreSnapshot({ source: join(bundlePath, 'store.sqlite'), destination: storePath, sealedSource: true, signal });
    if (JSON.stringify(database) !== JSON.stringify(manifest.database)) throw fail('Restored Store does not retain its original history');
    const home = join(folder, 'sdk-home'); await privateDirectory(join(home, plan.projectId)); await writePrivate(join(home, plan.projectId, 'project.record'), record);
    const project = { projectId: plan.projectId, externalId: `room:${plan.roomId}`, home, native: runtime.native, daemon: runtime.daemon, docker: runtime.docker, imageId: runtime.imageId, volume, storePath, prefix: `camp-mvp-project-${hash(`room:${plan.roomId}`).slice(0, 16)}-`, profile: 'Disposable', restore: { operationId: plan.operationId, manifestDigest: loaded.receipt.manifestDigest } };
    await validateCandidates(runtime, project, plan, signal);
    const after = await sqliteStoreSnapshot({ source: storePath, signal });
    if (after.logicalDigest !== manifest.database.logicalDigest) throw fail('Restore candidate validation changed the Store history');
    const receipt = parseStorageRestoreReceipt({ ...loaded.receipt, targetStorageId: identity.storageId, verifiedCandidates: plan.candidates.length, historyVerified: true });
    signal?.throwIfAborted();
    await atomicJson(join(folder, 'restore-binding.json'), { schemaVersion: 1, projectId: project.projectId, externalId: project.externalId, volume, storePath, recordSha256: sha256(record), receipt });
    // Persist every newly created parent before publishing project.json. That
    // final mapping is the only admission path for ordinary runtime execution.
    const storeFile = await open(storePath, 'r'); try { await storeFile.sync(); } finally { await storeFile.close(); }
    for (const path of [storeFolder, mountpoint, join(home, plan.projectId), home, folder, dirname(folder), runtime.home]) await syncDirectory(path);
    signal?.throwIfAborted();
    await atomicJson(join(folder, 'project.json'), project);
    await syncDirectory(dirname(folder)); await syncDirectory(runtime.home);
    return receipt;
  });
}
