import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, readdir, symlink, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { CampRuntime } from '../src/index.mjs';
import { exportNativeStore, restoreNativeStore, reportNativeStore, sqliteStoreSnapshot } from '../src/native-store.mjs';
import { openStorageIdentity } from '../src/storage-identity.mjs';
import { openPoolState } from '../src/pool-state.mjs';
import { poolResources } from '../src/host-manager.mjs';
import { resourcePolicy } from '../src/resource-policy.mjs';
import { WorkerJournal, atomicJson, privateDirectory } from '../src/durable-state.mjs';
import { acquireProjectLock } from '../src/project-lock.mjs';
import { runLocalChecks } from '../src/local-doctor.mjs';
import { exportCandidate } from '../src/export.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { checkStorageCommand } from './storage.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const imageId = 'sha256:' + 'a'.repeat(64), toolchainDigest = 'b'.repeat(64);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'camp-native-store-')), roomId = randomUUID();
  const projectId = `p-${digest(`room:${roomId}`).slice(0, 16)}`, volumes = new Map(), calls = [], candidates = [
    { type: 'layerfs', projectId, refKind: 'layer', refId: '32' + '1'.repeat(64), layerId: '32' + '1'.repeat(64), rootId: '2'.repeat(64), imageId },
    { type: 'layerfs', projectId, refKind: 'commit', refId: '12' + '3'.repeat(64), commitId: '12' + '3'.repeat(64), rootId: '4'.repeat(64), imageId },
  ];
  const docker = join(root, 'docker.sock'); await writeFile(docker, 'fixture');
  let containers = [];
  function runtime(home) {
    const selected = new CampRuntime({ home, imageId, docker });
    selected.ready = async () => { await privateDirectory(home); selected.toolchain = { digest: toolchainDigest }; return selected; };
    selected.dockerCall = async args => {
      calls.push(args);
      if (args[0] === 'ps') return { stdout: args.includes('--filter') && args.some(value => value.startsWith('volume=')) ? containers.join('\n') : '' };
      if (args[0] === 'volume' && args[1] === 'ls') return { stdout: [...volumes.keys()].filter(name => args.includes(`name=^${name}$`)).join('\n') };
      if (args[0] === 'volume' && args[1] === 'create') { const name = args.at(-1), path = join(root, 'volumes', name); await mkdir(path, { recursive: true, mode: 0o700 }); volumes.set(name, path); return { stdout: name }; }
      if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: volumes.get(args.at(-1)) ?? '' };
      throw new Error(`Unexpected Docker call ${args}`);
    };
    selected.verifyCandidate = async (project, candidate) => {
      const db = new DatabaseSync(project.storePath, { readOnly: true });
      try { const row = db.prepare('SELECT root FROM refs WHERE ref=?').get(candidate.refId); assert.equal(row?.root, candidate.rootId); return candidate; }
      finally { db.close(); }
    };
    return selected;
  }
  const source = runtime(join(root, 'source')), target = runtime(join(root, 'target'));
  await source.ready(); const identity = await openStorageIdentity({ home: source.home, dockerId: 'fixture-docker' });
  const volume = `camp-mvp-${projectId}`, mount = join(root, 'volumes', volume); volumes.set(volume, mount); await mkdir(join(mount, 'global'), { recursive: true, mode: 0o700 });
  const storePath = join(mount, 'global/store.sqlite'), db = new DatabaseSync(storePath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA application_id=1279677264; PRAGMA user_version=22; CREATE TABLE refs(ref TEXT PRIMARY KEY,root TEXT); CREATE TABLE history(id INTEGER PRIMARY KEY,parent INTEGER,second_parent INTEGER,payload BLOB)');
  for (const candidate of candidates) db.prepare('INSERT INTO refs VALUES(?,?)').run(candidate.refId, candidate.rootId);
  db.prepare('INSERT INTO history VALUES(1,NULL,NULL,?)').run(Buffer.from([0, 1, 255]));
  db.prepare('INSERT INTO history VALUES(2,1,1,?)').run(Buffer.from('full private history')); db.close();
  const folder = join(source.home, 'projects', projectId), home = join(folder, 'sdk-home'); await privateDirectory(join(home, projectId));
  await writeFile(join(home, projectId, 'project.record'), 'private-binding-and-cursor', { mode: 0o600 });
  await atomicJson(join(folder, 'project.json'), { projectId, externalId: `room:${roomId}`, home, volume, storePath, imageId, native: source.native, daemon: source.daemon, docker, profile: 'Disposable', sourcePath: join(root, 'deleted-source') });
  const plan = { schemaVersion: 1, operationId: randomUUID(), roomId, kind: 'migration', storageEpoch: 1, sourceStorageId: identity.storageId, acceptedRevision: 2, acceptedCandidate: candidates[1], projectId, candidates };
  return { root, source, target, runtime, plan, calls, volumes, bundlePath: join(root, 'bundle'), options: { acquireManager: async () => ({ facts: { ID: 'fixture-docker' }, release: async () => {} }) }, setContainers(value) { containers = value; }, close: () => rm(root, { recursive: true, force: true }) };
}

test('SQLite backup includes committed WAL, preserves blobs and parent history, and produces a standalone database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'camp-sqlite-backup-'));
  const db = new DatabaseSync(join(root, 'source.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE history(id INTEGER PRIMARY KEY,parent INTEGER,payload BLOB); INSERT INTO history VALUES(1,NULL,x\'00ff\')');
    const info = await sqliteStoreSnapshot({ source: join(root, 'source.sqlite'), destination: join(root, 'backup.sqlite') });
    assert.equal(info.rows, 1); assert.equal(info.tables, 1);
    const copy = new DatabaseSync(join(root, 'backup.sqlite'));
    try { assert.equal(copy.prepare('PRAGMA journal_mode').get().journal_mode, 'wal'); assert.deepEqual(Buffer.from(copy.prepare('SELECT payload FROM history').get().payload), Buffer.from([0, 255])); }
    finally { copy.close(); }
    for (const suffix of ['-wal', '-shm', '-journal']) await assert.rejects(access(join(root, 'backup.sqlite' + suffix)), { code: 'ENOENT' });
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test('whole Store roundtrip preserves original Layer/Commit roots and exact authority record, with a new physical identity', async () => {
  const f = await fixture(), posted = [];
  try {
    const backup = await exportNativeStore({ ...f.options, runtime: f.source, plan: f.plan, bundlePath: f.bundlePath, postReceipt: receipt => posted.push(receipt) });
    const restore = await restoreNativeStore({ ...f.options, runtime: f.target, plan: f.plan, bundlePath: f.bundlePath, postReceipt: receipt => posted.push(receipt) });
    assert.equal(restore.manifestDigest, backup.manifestDigest); assert.notEqual(restore.targetStorageId, f.plan.sourceStorageId); assert.equal(restore.verifiedCandidates, 2);
    const project = await f.target.prepareProject({ projectId: `room:${f.plan.roomId}`, sourcePath: '/original/checkout/no-longer-exists' });
    assert.equal(project.sourcePath, undefined); assert.match(project.volume, /^camp-restore-/);
    assert.equal(await readFile(join(project.home, project.projectId, 'project.record'), 'utf8'), 'private-binding-and-cursor');
    assert.deepEqual(await readdir(f.bundlePath), ['manifest.json', 'project.record', 'store.sqlite']);
    assert.deepEqual(await restoreNativeStore({ ...f.options, runtime: f.target, plan: f.plan, bundlePath: f.bundlePath }), restore);
    assert.equal(posted.length, 2);
    const db = new DatabaseSync(project.storePath); db.exec('INSERT INTO history VALUES(3,2,NULL,x\'01\')'); db.close();
    const original = await f.source.loadProject(f.plan.projectId), sourceDb = new DatabaseSync(original.storePath, { readOnly: true });
    try { assert.equal(sourceDb.prepare('SELECT COUNT(*) AS count FROM history').get().count, 2); } finally { sourceDb.close(); }
  } finally { await f.close(); }
});

test('a completed backup is reused only by a migration explicitly bound to that exact immutable origin', async () => {
  const f = await fixture();
  try {
    const origin = { ...f.plan, kind: 'backup' };
    const backup = await exportNativeStore({ ...f.options, runtime: f.source, plan: origin, bundlePath: f.bundlePath });
    const migration = { ...f.plan, operationId: randomUUID(), backupOperationId: origin.operationId };
    const restored = await restoreNativeStore({ ...f.options, runtime: f.target, plan: migration, bundlePath: f.bundlePath });
    assert.equal(restored.operationId, migration.operationId); assert.equal(restored.manifestDigest, backup.manifestDigest);
    assert.equal(JSON.parse(await readFile(join(f.bundlePath, 'manifest.json'))).plan.operationId, origin.operationId);
    await assert.rejects(restoreNativeStore({ ...f.options, runtime: f.runtime(join(f.root, 'bad-target')), plan: { ...migration, acceptedRevision: migration.acceptedRevision + 1 }, bundlePath: f.bundlePath }), /differs/);
  } finally { await f.close(); }
});

test('explicit backup reuse survives a placement-only migration while retaining original artifact authority and strict snapshot facts', async () => {
  const f = await fixture();
  try {
    const origin = { ...f.plan, kind: 'backup' };
    const backup = await exportNativeStore({ ...f.options, runtime: f.source, plan: origin, bundlePath: f.bundlePath });
    const originalManifest = await readFile(join(f.bundlePath, 'manifest.json'));
    const firstPlan = { ...f.plan, operationId: randomUUID(), backupOperationId: origin.operationId };
    const first = await restoreNativeStore({ ...f.options, runtime: f.target, plan: firstPlan, bundlePath: f.bundlePath, sourceReceipt: backup });
    const nextPlan = { ...firstPlan, operationId: randomUUID(), storageEpoch: 2, sourceStorageId: first.targetStorageId };
    const next = await restoreNativeStore({ ...f.options, runtime: f.runtime(join(f.root, 'second-destination')), plan: nextPlan, bundlePath: f.bundlePath, sourceReceipt: backup });
    assert.equal(next.operationId, nextPlan.operationId); assert.equal(next.sourceStorageId, origin.sourceStorageId);
    assert.notEqual(next.targetStorageId, first.targetStorageId); assert.notEqual(next.targetStorageId, origin.sourceStorageId);
    assert.equal(next.manifestDigest, backup.manifestDigest); assert.deepEqual(await readFile(join(f.bundlePath, 'manifest.json')), originalManifest);
    for (const changed of [{ ...nextPlan, acceptedRevision: nextPlan.acceptedRevision + 1 }, { ...nextPlan, candidates: [nextPlan.acceptedCandidate] }, { ...origin, storageEpoch: 2, sourceStorageId: first.targetStorageId }]) {
      const before = f.calls.filter(args => args[0] === 'volume' && args[1] === 'create').length;
      await assert.rejects(restoreNativeStore({ ...f.options, runtime: f.runtime(join(f.root, randomUUID())), plan: changed, bundlePath: f.bundlePath }), /differs/);
      assert.equal(f.calls.filter(args => args[0] === 'volume' && args[1] === 'create').length, before);
    }
  } finally { await f.close(); }
});

test('corrupt Store, linked bundle members and mismatched authority hashes fail before any target volume is created', async () => {
  for (const corruption of ['store', 'record', 'link']) {
    const f = await fixture();
    try {
      await exportNativeStore({ ...f.options, runtime: f.source, plan: f.plan, bundlePath: f.bundlePath });
      if (corruption === 'store') await writeFile(join(f.bundlePath, 'store.sqlite'), 'corrupt', { mode: 0o600 });
      if (corruption === 'record') await writeFile(join(f.bundlePath, 'project.record'), 'tampered', { mode: 0o600 });
      if (corruption === 'link') { await rm(join(f.bundlePath, 'project.record')); await symlink('/etc/passwd', join(f.bundlePath, 'project.record')); }
      const creates = f.calls.filter(args => args[0] === 'volume' && args[1] === 'create').length;
      await assert.rejects(restoreNativeStore({ ...f.options, runtime: f.target, plan: f.plan, bundlePath: f.bundlePath }));
      assert.equal(f.calls.filter(args => args[0] === 'volume' && args[1] === 'create').length, creates);
    } finally { await f.close(); }
  }
});

test('cold maintenance refuses live volume users, an unsettled journal, a held project lock and a nonempty restore home', async () => {
  const f = await fixture(); let lock;
  try {
    f.setContainers(['active-or-stopped-container']);
    await assert.rejects(exportNativeStore({ ...f.options, runtime: f.source, plan: f.plan, bundlePath: f.bundlePath }), /container still uses/);
    f.setContainers([]);
    lock = await acquireProjectLock(f.source, f.plan.projectId);
    await assert.rejects(exportNativeStore({ ...f.options, runtime: f.source, plan: f.plan, bundlePath: f.bundlePath }), /already running/);
    await lock.release(); lock = null;
    const journal = await new WorkerJournal({ home: f.source.home, apiUrl: 'http://fixture', workerId: 'worker' }).ready(); await journal.claimIntent();
    await assert.rejects(exportNativeStore({ ...f.options, runtime: f.source, plan: f.plan, bundlePath: f.bundlePath }), /Unsettled/);
    await journal.finishClaim(); await exportNativeStore({ ...f.options, runtime: f.source, plan: f.plan, bundlePath: f.bundlePath });
    await privateDirectory(f.target.home); await writeFile(join(f.target.home, 'must-not-overwrite'), 'retain');
    await assert.rejects(restoreNativeStore({ ...f.options, runtime: f.target, plan: f.plan, bundlePath: f.bundlePath }), /entirely fresh/);
    assert.equal(await readFile(join(f.target.home, 'must-not-overwrite'), 'utf8'), 'retain');
  } finally { await lock?.release(); await f.close(); }
});

test('physical storage identity is seeded from an existing pool and shared by a newly created target pool', async () => {
  const f = await fixture();
  try {
    const policy = resourcePolicy({}), resources = poolResources(policy);
    const pool = await openPoolState({ home: f.source.home, dockerId: 'fixture-docker', apiUrl: 'http://fixture', baseWorkerId: 'base', policy, resources });
    assert.equal(pool.storageId, f.plan.sourceStorageId);
    await rm(join(f.source.home, 'storage-identity.json'));
    await openPoolState({ home: f.source.home, dockerId: 'fixture-docker', apiUrl: 'http://fixture', baseWorkerId: 'base', policy, resources });
    const seeded = JSON.parse(await readFile(join(f.source.home, 'storage-identity.json')));
    assert.equal(seeded.storageId, pool.storageId); assert.equal(seeded.storeId, pool.storeId);
    await assert.rejects(openStorageIdentity({ home: f.source.home, dockerId: 'another-host' }), { code: 'camp_storage_identity' });
  } finally { await f.close(); }
});

test('registered source receipt pins the exact private bundle before target allocation', async () => {
  const f = await fixture();
  try {
    const receipt = await exportNativeStore({ ...f.options, runtime: f.source, plan: f.plan, bundlePath: f.bundlePath });
    await assert.rejects(restoreNativeStore({ ...f.options, runtime: f.target, plan: f.plan, bundlePath: f.bundlePath, sourceReceipt: { ...receipt, manifestDigest: 'f'.repeat(64) } }), /immutable backup receipt/);
    assert.equal(f.calls.filter(args => args[0] === 'volume' && args[1] === 'create').length, 0);
    const restored = await restoreNativeStore({ ...f.options, runtime: f.target, plan: f.plan, bundlePath: f.bundlePath, sourceReceipt: receipt });
    const policy = resourcePolicy({});
    const pool = await openPoolState({ home: f.target.home, dockerId: 'fixture-docker', apiUrl: 'http://target', baseWorkerId: 'target', policy, resources: poolResources(policy) });
    assert.equal(pool.storageId, restored.targetStorageId);
  } finally { await f.close(); }
});

test('restored project preflight does not require the deleted source checkout and rejects a tampered volume binding', async () => {
  const f = await fixture();
  try {
    await exportNativeStore({ ...f.options, runtime: f.source, plan: f.plan, bundlePath: f.bundlePath });
    await restoreNativeStore({ ...f.options, runtime: f.target, plan: f.plan, bundlePath: f.bundlePath });
    const local = await runLocalChecks({ runtime: f.target, env: { PATH: process.env.PATH, CAMP_ROOM_ID: f.plan.roomId }, sourcePath: '/deleted/source/checkout' });
    assert.deepEqual(local.checks.find(check => check.id === 'source'), { id: 'source', status: 'passed', code: 'restored_store_verified' });
    const path = join(f.target.home, 'projects', f.plan.projectId, 'project.json'), project = JSON.parse(await readFile(path));
    await atomicJson(path, { ...project, volume: 'unrelated-operator-volume' });
    await assert.rejects(f.target.loadProject(project.projectId), /installation binding/);
  } finally { await f.close(); }
});

test('public export cannot fork or mount while cold project maintenance holds its fence', async () => {
  const f = await fixture(); let lock, reads = 0;
  try {
    lock = await acquireProjectLock(f.source, f.plan.projectId);
    f.source.loadProject = async () => { reads++; throw new Error('Export must not reach the Store'); };
    await assert.rejects(exportCandidate({ runtime: f.source, candidate: f.plan.acceptedCandidate, output: join(f.root, 'export') }), /already running/);
    assert.equal(reads, 0);
  } finally { await lock?.release(); await f.close(); }
});

test('restore refuses overlapping or missing bundle paths without creating or changing the input bundle', async () => {
  const f = await fixture();
  try {
    await exportNativeStore({ ...f.options, runtime: f.source, plan: f.plan, bundlePath: f.bundlePath });
    const names = await readdir(f.bundlePath);
    await assert.rejects(restoreNativeStore({ ...f.options, runtime: f.runtime(join(f.bundlePath, 'nested-target')), plan: f.plan, bundlePath: f.bundlePath }), /must not contain/);
    assert.deepEqual(await readdir(f.bundlePath), names);
    const missing = join(f.root, 'missing-bundle');
    await assert.rejects(restoreNativeStore({ ...f.options, runtime: f.target, plan: f.plan, bundlePath: missing }), { code: 'ENOENT' });
    await assert.rejects(access(missing), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('SQLite maintenance timeout kills its actual child, preserves source bytes and never publishes a destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'camp-sqlite-deadline-'));
  const source = join(root, 'source.sqlite'), target = join(root, 'target.sqlite');
  const db = new DatabaseSync(source); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(value BLOB); INSERT INTO t VALUES(randomblob(65536))'); db.close();
  try {
    const before = await readFile(source), started = Date.now();
    await assert.rejects(sqliteStoreSnapshot({ source, destination: target, timeoutMs: 1 }), { code: 'camp_storage_sqlite' });
    assert(Date.now() - started < 3000);
    assert.deepEqual(await readFile(source), before);
    await assert.rejects(access(target), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('no successful receipt or project mapping is published when restored candidate verification fails', async () => {
  const f = await fixture(); let posted = false;
  try {
    await exportNativeStore({ ...f.options, runtime: f.source, plan: f.plan, bundlePath: f.bundlePath });
    f.target.verifyCandidate = async () => { throw new Error('Candidate verification rejected'); };
    await assert.rejects(restoreNativeStore({ ...f.options, runtime: f.target, plan: f.plan, bundlePath: f.bundlePath, postReceipt: () => { posted = true; } }), /Candidate verification/);
    assert.equal(posted, false);
    await access(join(f.target.home, 'restore-intent.json'));
    await assert.rejects(access(join(f.target.home, 'projects', f.plan.projectId, 'project.json')), { code: 'ENOENT' });
    const creates = f.calls.filter(args => args[0] === 'volume' && args[1] === 'create').length;
    await assert.rejects(f.target.prepareProject({ projectId: `room:${f.plan.roomId}`, sourcePath: '/missing/source' }), /installation is incomplete/);
    assert.equal(f.calls.filter(args => args[0] === 'volume' && args[1] === 'create').length, creates);
  } finally { await f.close(); }
});

test('restore replay rejects another Docker host, missing identity and loss of unlisted history', async () => {
  for (const changed of ['docker', 'identity', 'history']) {
    const f = await fixture();
    try {
      await exportNativeStore({ ...f.options, runtime: f.source, plan: f.plan, bundlePath: f.bundlePath });
      await restoreNativeStore({ ...f.options, runtime: f.target, plan: f.plan, bundlePath: f.bundlePath });
      const selected = { ...f.options, runtime: f.target, plan: f.plan, bundlePath: f.bundlePath };
      if (changed === 'docker') selected.acquireManager = async () => ({ facts: { ID: 'another-docker' }, release: async () => {} });
      if (changed === 'identity') await rm(join(f.target.home, 'storage-identity.json'));
      if (changed === 'history') { const project = await f.target.loadProject(f.plan.projectId), db = new DatabaseSync(project.storePath); db.exec('DELETE FROM history WHERE id=2'); db.close(); }
      await assert.rejects(restoreNativeStore(selected), /storage|identity|history/i);
      if (changed === 'identity') await assert.rejects(access(join(f.target.home, 'storage-identity.json')), { code: 'ENOENT' });
    } finally { await f.close(); }
  }
});

test('a published backup receipt can be recovered with native validation after losing the source host and its ACK', async () => {
  const f = await fixture();
  try {
    await assert.rejects(exportNativeStore({ ...f.options, runtime: f.source, plan: f.plan, bundlePath: f.bundlePath, postReceipt: () => { throw new Error('Lost source receipt response'); } }), /Lost source/);
    const before = await readFile(join(f.bundlePath, 'manifest.json'));
    await rm(f.source.home, { recursive: true });
    await rm(f.volumes.get(`camp-mvp-${f.plan.projectId}`), { recursive: true });
    const operator = f.runtime(join(f.root, 'replacement-operator'));
    operator.loadProject = async () => assert.fail('Report must not access the lost source installation');
    const posted = [];
    const reported = await reportNativeStore({ ...f.options, runtime: operator, plan: f.plan, bundlePath: f.bundlePath, postReceipt: receipt => posted.push(receipt) });
    assert.equal(reported.manifestDigest, digest(before)); assert.equal(reported.sourceStorageId, f.plan.sourceStorageId); assert.equal(posted.length, 1);
    assert.deepEqual(await readFile(join(f.bundlePath, 'manifest.json')), before);
    assert.deepEqual(await readdir(f.bundlePath), ['manifest.json', 'project.record', 'store.sqlite']);
    assert.deepEqual(await readdir(operator.home), []);
  } finally { await f.close(); }
});

test('the actual storage CLI executes from repository paths containing spaces and Unicode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'camp-cli-path-')), base = join(root, 'camp path 中文'), pkg = join(base, 'packages/camp-runtime');
  try {
    const current = fileURLToPath(new URL('..', import.meta.url));
    await mkdir(join(pkg, 'scripts'), { recursive: true });
    await cp(join(current, 'src'), join(pkg, 'src'), { recursive: true });
    for (const name of ['package.json', 'toolchain.lock.json']) await cp(join(current, name), join(pkg, name));
    await cp(join(current, 'scripts/storage.mjs'), join(pkg, 'scripts/storage.mjs'));
    await cp(join(current, '../camp-protocol'), join(base, 'packages/camp-protocol'), { recursive: true });
    await assert.rejects(promisify(execFile)(process.execPath, [join(pkg, 'scripts/storage.mjs'), '--bad-arguments'], { timeout: 5000, env: { PATH: process.env.PATH } }), error => error.code === 1 && error.stderr.includes('camp_storage_usage'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI admission rejects known closed phases before allocation and restricts acknowledged operations to exact replay', async () => {
  const f = await fixture();
  try {
    const operation = { id: f.plan.operationId, roomId: f.plan.roomId, kind: f.plan.kind, phase: 'prepared', backupReceipt: null, restoreReceipt: null };
    assert.deepEqual(checkStorageCommand('backup', operation, f.plan), {});
    for (const command of ['backup', 'report-backup', 'restore']) assert.throws(() => checkStorageCommand(command, { ...operation, phase: 'cancelled' }, f.plan), { code: 'camp_storage_phase' });
    const receipt = await exportNativeStore({ ...f.options, runtime: f.source, plan: f.plan, bundlePath: f.bundlePath });
    assert.equal(checkStorageCommand('backup', { ...operation, phase: 'backup_ready', backupReceipt: receipt }, f.plan).existingOnly, true);
    assert.equal(checkStorageCommand('report-backup', { ...operation, phase: 'cancelled', backupReceipt: receipt }, f.plan).sourceReceipt.manifestDigest, receipt.manifestDigest);
    assert.throws(() => checkStorageCommand('restore', { ...operation, phase: 'activated', backupReceipt: receipt }, f.plan), { code: 'camp_storage_phase' });
    const replay = { ...f.options, runtime: f.runtime(join(f.root, 'missing-backup-source')), plan: f.plan, bundlePath: join(f.root, 'absent'), existingOnly: true };
    // A historical backup command cannot invent a new artifact even with a
    // fresh valid source; report-backup handles missing-source receipt replay.
    await assert.rejects(exportNativeStore({ ...replay, runtime: f.source }), /original existing bundle/);
    const restored = await restoreNativeStore({ ...f.options, runtime: f.target, plan: f.plan, bundlePath: f.bundlePath });
    const before = f.calls.filter(args => args[0] === 'volume' && args[1] === 'create').length;
    await assert.rejects(restoreNativeStore({ ...f.options, runtime: f.runtime(join(f.root, 'other-target')), plan: f.plan, bundlePath: f.bundlePath, existingRestoreReceipt: restored }), /original existing target/);
    assert.equal(f.calls.filter(args => args[0] === 'volume' && args[1] === 'create').length, before);
  } finally { await f.close(); }
});
