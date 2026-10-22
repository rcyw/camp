import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CampRuntime } from '../src/index.mjs';
import { WorkerJournal, acquireWorkerLock } from '../src/durable-state.mjs';
import { recoverWorker } from '../src/worker-recovery.mjs';

const source = fileURLToPath(import.meta.url);
if (process.argv[2] === '--child') {
  const { project, workerId, runId, apiUrl } = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const runtime = await new CampRuntime().ready();
  await acquireWorkerLock(workerId);
  const journal = await new WorkerJournal({ home: runtime.home, apiUrl, workerId }).ready();
  const record = await journal.recordClaim({ id: runId, roomId: 'local-proof', role: 'builder', epoch: 1 }, { runtime: runtime.runIdentity(`${runId}-e1`) });
  const run = await runtime.prepareRun({ project, runId: record.runtime.runId, roleId: 'builder', owner: { workerId, apiUrl, runId, epoch: 1 } });
  await journal.update(record, { phase: 'executing', runtime: { ...record.runtime, containerId: run.containerId } });
  await runtime.dockerCall(['exec', '-d', '--user', '501:20', run.containerId, 'sh', '-c', 'while :; do sleep 1; done']);
  process.stdout.write(`${JSON.stringify({ event: 'sandbox_ready', containerId: run.containerId })}\n`);
  setInterval(() => {}, 1000);
} else {
  const runtime = await new CampRuntime().ready();
  const stamp = Date.now();
  const project = await runtime.prepareProject({ projectId: `sigkill-recovery-proof-${stamp}` });
  const workerId = `recovery-proof-${randomUUID()}`;
  const runId = randomUUID();
  const apiUrl = 'http://local-recovery-proof.invalid';
  const input = new URL('../.local/recovery-proof-input.json', import.meta.url);
  await writeFile(input, JSON.stringify({ project, workerId, runId, apiUrl }), { mode: 0o600 });
  const foreign = await runtime.prepareRun({ project, runId: `foreign-${stamp}-e1`, roleId: 'reviewer', owner: { workerId: 'different-worker', apiUrl, runId: `foreign-${stamp}`, epoch: 1 } });
  const child = spawn(process.execPath, [source, '--child', fileURLToPath(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let lock;
  try {
    const ready = await new Promise((resolveReady, reject) => {
      let pending = '', stderr = '';
      const timer = setTimeout(() => reject(new Error('Recovery child did not mount within 30 seconds')), 30_000);
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
      child.stdout.on('data', chunk => { pending += chunk; const at = pending.indexOf('\n'); if (at >= 0) { clearTimeout(timer); resolveReady(JSON.parse(pending.slice(0, at))); } });
      child.once('error', reject);
      child.once('exit', code => { if (code !== null) { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${stderr}`)); } });
    });
    assert.equal(ready.event, 'sandbox_ready');
    const exited = new Promise(resolveExit => child.once('exit', resolveExit));
    child.kill('SIGKILL');
    await exited;
    const stillRunning = (await runtime.dockerCall(['inspect', '--format', '{{.State.Running}}', ready.containerId])).stdout.trim();
    assert.equal(stillRunning, 'true', 'SIGKILL must leave a real orphan before recovery');
    for (let attempt = 0; attempt < 20; attempt++) {
      try { lock = await acquireWorkerLock(workerId); break; } catch { await delay(25); }
    }
    assert.ok(lock);
    const journal = await new WorkerJournal({ home: runtime.home, apiUrl, workerId }).ready();
    const state = { run: { id: runId, roomId: 'local-proof', workerId, epoch: 1, status: 'running', cancelRequested: false }, leaseValid: false, replaced: true };
    let completionPosts = 0;
    await recoverWorker({ journal, runtime, request: async (path, body) => { if (path.endsWith('/complete')) completionPosts++; return path.startsWith('/reconcile') ? { runs: [state] } : state; } });
    assert.equal(completionPosts, 0, 'An expired or replaced epoch must never be submitted');
    assert.equal((await runtime.dockerCall(['ps', '-a', '-q', '--filter', `name=^/${runtime.runIdentity(`${runId}-e1`).prefix}`])).stdout.trim(), '');
    assert.equal((await runtime.dockerCall(['inspect', '--format', '{{.State.Running}}', foreign.containerId])).stdout.trim(), 'true', 'A different active worker must survive');
    const [record] = await journal.list();
    assert.equal(record.phase, 'fenced');
    assert.equal(record.cleanupKnown, true);
    const receipt = { at: new Date().toISOString(), runId, workerId, signal: 'SIGKILL', realOrphanContainer: ready.containerId, orphanRemoved: true, expiredCompletionPosts: completionPosts, foreignContainerSurvived: foreign.containerId, modelCalled: false };
    await writeFile(new URL('../.local/worker-sigkill-recovery.json', import.meta.url), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
  } finally {
    child.kill('SIGKILL');
    await lock?.release();
    await runtime.cleanupAttempt(runtime.runIdentity(`${runId}-e1`).prefix);
    await runtime.releaseRun(foreign, { discard: true });
  }
}
