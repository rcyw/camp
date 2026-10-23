import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { superviseOwnedChild } from './owned-child.mjs';

function removeTestGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

test('a signal-terminated worker fails promptly even when exitCode is null', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const owned = superviseOwnedChild(child);
  await once(child, 'spawn');
  try {
    process.kill(child.pid, 'SIGKILL');
    const result = await owned.exited;
    assert.equal(result.signal, 'SIGKILL'); assert.equal(child.exitCode, null);
    assert.throws(() => owned.assertRunning('Worker stopped'), /Worker stopped/);
  } finally { await owned.stop(); }
});

test('cleanup escalates an unresponsive owned group and waits for its exit', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const owned = superviseOwnedChild(child);
  try {
    await once(child.stdout, 'data');
    const result = await owned.stop({ graceMs: 30, killMs: 2000 });
    assert.equal(result.signal, 'SIGKILL');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    assert.deepEqual(await owned.stop(), result);
  } finally { await owned.stop({ graceMs: 30 }); }
});

test('spawn failures are observed without an unhandled error or invalid group signal', async () => {
  const child = spawn('/camp-test-no-such-worker-command', [], { detached: true, stdio: 'ignore' });
  const owned = superviseOwnedChild(child);
  const result = await owned.exited;
  assert.equal(result.error.code, 'ENOENT');
  assert.throws(() => owned.assertRunning('Could not start worker'), /Could not start worker/);
  assert.deepEqual(await owned.stop(), result);
});

for (const group of [true, false]) test(`interrupting a smoke script stops its worker before exit with group=${group}`, async () => {
  const helper = JSON.stringify(new URL('./owned-child.mjs', import.meta.url).href);
  const script = `import { spawn } from 'node:child_process'; import { once } from 'node:events'; import { superviseOwnedChild } from ${helper};
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: ${group}, stdio: 'ignore' });
    const owned = superviseOwnedChild(worker, { group: ${group}, handleSignals: true });
    await once(worker, 'spawn'); process.stdout.write(String(worker.pid) + '\\n'); await owned.exited;`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const owned = superviseOwnedChild(child);
  let workerPid;
  try {
    const [output] = await once(child.stdout, 'data'); workerPid = Number(String(output).trim());
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0);
    process.kill(child.pid, 'SIGTERM');
    const result = await owned.exited; assert.equal(result.code, 143);
    assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' });
  } finally {
    await owned.stop({ graceMs: 30 });
    if (workerPid && group) removeTestGroup(workerPid);
  }
});
