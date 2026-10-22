import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, stat, writeFile, readdir, mkdir } from 'node:fs/promises';
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
