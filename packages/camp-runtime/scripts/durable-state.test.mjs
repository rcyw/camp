import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, stat, writeFile, readdir, mkdir, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerJournal, acquireWorkerLock, atomicJson, runTokenForClaim } from '../src/durable-state.mjs';

test('atomic journal retains its last complete document and ignores an interrupted temporary write', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-atomic-'));
  try {
    const path = join(folder, 'state.json');
    await atomicJson(path, { value: 'before' });
    await writeFile(`${path}.interrupted.tmp`, '{"value":');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { value: 'before' });
    await atomicJson(path, { value: 'after' });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { value: 'after' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('existing public or linked runtime homes and lock directories fail closed without chmodding them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'camp-private-home-'));
  try {
    const shared = join(home, 'public'), linked = join(home, 'linked'); await mkdir(shared); await chmod(shared, 0o755); await symlink(shared, linked);
    for (const path of [shared, linked]) {
      await assert.rejects(new WorkerJournal({ home: path, apiUrl: 'http://fixture', workerId: 'fixture' }).ready(), /owned private directories/);
      await assert.rejects(acquireWorkerLock('fixture', { root: path }), /owned private directories/);
    }
    assert.equal((await stat(shared)).mode & 0o777, 0o755);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('failed atomic rename is reported as a durable state failure and retains the previous target', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-rename-failure-'));
  try {
    const target = join(folder, 'existing-directory');
    await mkdir(target);
    await writeFile(join(target, 'retained'), 'original');
    await assert.rejects(atomicJson(target, { changed: true }), error => error.code === 'camp_journal_io');
    assert.equal(await readFile(join(target, 'retained'), 'utf8'), 'original');
    assert.deepEqual(await readdir(folder), ['existing-directory']);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('claim intent and immutable completion survive reopen without credential persistence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'camp-journal-'));
  const options = { home, apiUrl: 'http://test', workerId: 'worker-original' };
  try {
    const first = await new WorkerJournal(options).ready();
    const claimId = await first.claimIntent();
    const token = runTokenForClaim('sensitive-room-token', claimId);
    const second = await new WorkerJournal(options).ready();
    assert.equal(await second.claimIntent(), claimId);
    assert.equal(runTokenForClaim('sensitive-room-token', claimId), token);
    const record = await second.recordClaim({ id: 'run', epoch: 7, roomId: 'room', role: 'builder', runToken: 'sensitive-run-token', prompt: 'model text' });
    await second.update(record, { cleanupKnown: true });
    const payload = { workerId: 'worker-original', epoch: 7, status: 'completed', summary: 'original result', artifacts: [{ type: 'layerfs', commitId: 'candidate' }] };
    await second.prepareCompletion(record, payload);
    const third = await new WorkerJournal(options).ready();
    const [restored] = await third.list();
    assert.deepEqual(restored.completion.payload, payload);
    await assert.rejects(third.prepareCompletion(restored, { ...payload, summary: 'different' }), /immutable/);
    const contents = await readFile(third.path(restored), 'utf8');
    assert.ok(!contents.includes('sensitive') && !contents.includes('model text') && !contents.includes(token));
    assert.equal((await readdir(join(third.folder, 'attempts'))).filter(path => path.endsWith('.json')).length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('workerId has one local owner and its kernel lock releases after owner SIGKILL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'camp-lock-'));
  const workerId = `lock-test-${randomUUID()}`;
  const first = await acquireWorkerLock(workerId, { root });
  await assert.rejects(acquireWorkerLock(workerId, { root }), /already running/);
  await first.release();
  const source = new URL('../src/durable-state.mjs', import.meta.url).href;
  const script = `import {acquireWorkerLock} from ${JSON.stringify(source)}; await acquireWorkerLock(${JSON.stringify(workerId)},{root:${JSON.stringify(root)}}); process.stdout.write('READY\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolveReady, reject) => { child.stdout.once('data', resolveReady); child.once('error', reject); child.once('exit', code => { if (code !== null) reject(new Error(`Lock owner exited ${code}`)); }); });
    await assert.rejects(acquireWorkerLock(workerId, { root }), /already running/);
    child.kill('SIGKILL');
    let recovered;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { recovered = await acquireWorkerLock(workerId, { root }); break; }
      catch { await delay(25); }
    }
    assert.ok(recovered, 'Kernel lock must not require deleting a stale PID file');
    await recovered.release();
  } finally { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});

test('cancelling a waiting project lock preserves its live owner and releases only the waiter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'camp-lock-abort-')), workerId = `project-wait-${randomUUID()}`;
  const owner = await acquireWorkerLock(workerId, { root });
  try {
    const controller = new AbortController(), waiting = acquireWorkerLock(workerId, { root, waitMs: 20000, signal: controller.signal });
    const rejected = assert.rejects(waiting, { name: 'AbortError' });
    await delay(25); controller.abort(); await rejected;
    await assert.rejects(acquireWorkerLock(workerId, { root }), /already running/);
  } finally { await owner.release(); const successor = await acquireWorkerLock(workerId, { root }); await successor.release(); await rm(root, { recursive: true, force: true }); }
});

for (const boundary of ['workers', 'worker', 'attempts']) for (const kind of ['shared', 'linked']) test(`journal refuses a ${kind} ${boundary} boundary without repairing or writing through it`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'camp-journal-boundary-'));
  const journal = new WorkerJournal({ home, apiUrl: 'http://fixture', workerId: 'worker' });
  const path = boundary === 'workers' ? join(home, 'workers') : boundary === 'worker' ? journal.folder : join(journal.folder, 'attempts');
  const { dirname } = await import('node:path');
  const target = join(home, 'outside');
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (kind === 'linked') { await mkdir(target, { mode: 0o700 }); await symlink(target, path); }
    else { await mkdir(path, { mode: 0o700 }); await chmod(path, 0o755); }
    await assert.rejects(journal.ready(), { code: 'camp_journal_io' });
    assert.equal((await stat(kind === 'linked' ? target : path)).mode & 0o777, kind === 'linked' ? 0o700 : 0o755);
    assert.deepEqual(await readdir(kind === 'linked' ? target : path), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

for (const document of ['metadata', 'attempt']) for (const kind of ['shared', 'linked']) test(`journal refuses ${kind} ${document} documents before trusting their contents`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'camp-journal-document-'));
  try {
    const journal = await new WorkerJournal({ home, apiUrl: 'http://fixture', workerId: 'worker' }).ready();
    const record = await journal.recordClaim({ id: 'run', epoch: 1, roomId: 'room' });
    const path = document === 'metadata' ? join(journal.folder, 'worker.json') : journal.path(record);
    const before = await readFile(path), target = join(home, 'retained.json');
    if (kind === 'shared') await chmod(path, 0o644);
    else { await writeFile(target, before, { mode: 0o600 }); await rm(path); await symlink(target, path); }
    await assert.rejects(document === 'metadata' ? new WorkerJournal({ home, apiUrl: 'http://fixture', workerId: 'worker' }).ready() : journal.list(), error => ['camp_journal_io', 'camp_journal_invalid'].includes(error.code));
    assert.deepEqual(await readFile(kind === 'linked' ? target : path), before);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('journal rejects oversized documents and an attempt saved under another identity', async () => {
  const home = await mkdtemp(join(tmpdir(), 'camp-journal-bounded-'));
  const { rename, truncate } = await import('node:fs/promises');
  try {
    const journal = await new WorkerJournal({ home, apiUrl: 'http://fixture', workerId: 'worker' }).ready();
    const record = await journal.recordClaim({ id: 'run', epoch: 1, roomId: 'room' });
    const original = journal.path(record), renamed = join(journal.folder, 'attempts', `${'f'.repeat(32)}.json`);
    await rename(original, renamed); await assert.rejects(journal.list(), { code: 'camp_journal_invalid' });
    await rename(renamed, original); await truncate(original, 16 * 1024 * 1024 + 1);
    await assert.rejects(journal.list(), { code: 'camp_journal_invalid' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('journal releases completed queue entries without losing serialized updates or failed writes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'camp-journal-queue-'));
  let failNext = false;
  try {
    const journal = await new WorkerJournal({ home, apiUrl: 'http://fixture', workerId: 'worker', persist: async (path, value) => {
      if (failNext) { failNext = false; throw Object.assign(new Error('Injected durable IO error'), { code: 'camp_journal_io' }); }
      await atomicJson(path, value);
    } }).ready();
    for (let index = 0; index < 20; index++) {
      const record = await journal.recordClaim({ id: `run-${index}`, epoch: 1, roomId: 'room' });
      await Promise.all([journal.update(record, value => ({ count: (value.count ?? 0) + 1 })), journal.update(record, value => ({ count: (value.count ?? 0) + 1 }))]);
      assert.equal(record.count, 2); assert.equal(journal.pending.size, 0);
    }
    const [record] = await journal.list(); failNext = true;
    const failed = journal.update(record, { count: 99 }), queued = journal.update(record, value => ({ count: value.count + 1 }));
    await assert.rejects(failed, { code: 'camp_journal_io' }); await queued;
    assert.equal(record.count, 3); assert.equal(journal.pending.size, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a linked ancestor is rejected before creating a previously missing runtime home through it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'camp-journal-ancestor-'));
  try {
    const target = join(home, 'target'), link = join(home, 'link'); await mkdir(target, { mode: 0o700 }); await symlink(target, link);
    await assert.rejects(new WorkerJournal({ home: join(link, 'missing'), apiUrl: 'http://fixture', workerId: 'worker' }).ready(), { code: 'camp_journal_io' });
    assert.deepEqual(await readdir(target), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});
