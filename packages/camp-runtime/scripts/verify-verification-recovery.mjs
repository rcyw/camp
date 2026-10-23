import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CampRuntime } from '../src/index.mjs';
import { WorkerJournal } from '../src/durable-state.mjs';
import { recoverWorker } from '../src/worker-recovery.mjs';
import { runTrustedVerification } from '../src/verification.mjs';
import { serializeVerificationPolicy } from '../../camp-protocol/src/index.js';

const script = fileURLToPath(import.meta.url), root = fileURLToPath(new URL('..', import.meta.url));
if (process.argv[2] === '--child') {
  const { candidate, workerId, runId, apiUrl } = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const runtime = await new CampRuntime({ imageId: candidate.imageId }).ready();
  const journal = await new WorkerJournal({ home: runtime.home, apiUrl, workerId }).ready();
  const record = await journal.recordClaim({ id: runId, executor: 'verification', operationId: 'proof', taskKind: 'verification', roomId: 'local-proof', epoch: 1 }, { runtime: runtime.runIdentity(`${runId}-e1`) });
  const project = JSON.parse(await readFile(`${runtime.home}/projects/${candidate.projectId}/project.json`, 'utf8'));
  const auxiliary = await runtime.prepareRun({ project, runId: `${runId}-aux`, roleId: 'snapshot', baseRef: candidate.refId, ownerPrefix: record.runtime.prefix });
  await journal.update(record, { phase: 'verifying' });
  const policy = { id: 'recovery', revision: 1, name: 'Recovery ownership', maxRepairAttempts: 0, checks: [{ id: 'hold', label: 'Hold for SIGKILL', argv: ['node', '-e', 'setInterval(()=>{},1000)'], timeoutMs: 120000 }] };
  await runTrustedVerification({ runtime, ownerRun: record.runtime, candidate, verificationPolicy: { policy, digest: createHash('sha256').update(serializeVerificationPolicy(policy)).digest('hex') }, onPrepared: async containerId => {
    // Hold after materialization, with a representative private harness copy.
    await writeFile(`${record.runtime.folder}/harness-recovery`, 'private pinned source');
    console.log(JSON.stringify({ containerId, auxiliaryContainerId: auxiliary.containerId }));
    await new Promise(() => {});
  } });
} else {
  const { candidate } = JSON.parse(await readFile(`${root}/.local/trusted-verification.json`, 'utf8'));
  const runtime = await new CampRuntime({ imageId: candidate.imageId }).ready();
  const project = JSON.parse(await readFile(`${runtime.home}/projects/${candidate.projectId}/project.json`, 'utf8'));
  const workerId = `verify-recovery-${randomUUID()}`, runId = randomUUID(), apiUrl = 'http://local-verification-proof.invalid';
  const input = `${root}/.local/verification-recovery-input.json`;
  await writeFile(input, JSON.stringify({ candidate, workerId, runId, apiUrl }), { mode: 0o600 });
  const foreign = await runtime.prepareRun({ project, runId: `verify-foreign-${Date.now()}`, roleId: 'reviewer', baseRef: candidate.refId });
  const child = spawn(process.execPath, [script, '--child', input], { stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = runtime.runIdentity(`${runId}-e1`).prefix;
  try {
    const ready = await new Promise((resolve, reject) => {
      let pending = '', stderr = '';
      const timer = setTimeout(() => reject(new Error('Verification child setup exceeded 40 seconds')), 40000);
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
      child.stdout.on('data', chunk => { pending += chunk; const at = pending.indexOf('\n'); if (at >= 0) { clearTimeout(timer); resolve(JSON.parse(pending.slice(0, at))); } });
      child.once('error', reject); child.once('exit', code => { if (code !== null) { clearTimeout(timer); reject(new Error(`Verification child exited ${code}: ${stderr}`)); } });
    });
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
    for (const id of [ready.containerId, ready.auxiliaryContainerId]) assert.equal((await runtime.dockerCall(['inspect', '--format', '{{.State.Running}}', id])).stdout.trim(), 'true');
    const journal = await new WorkerJournal({ home: runtime.home, apiUrl, workerId }).ready();
    const state = { run: { id: runId, roomId: 'local-proof', workerId, epoch: 1, status: 'running', cancelRequested: false }, leaseValid: false, replaced: true };
    let completions = 0;
    await recoverWorker({ journal, runtime, request: async path => { if (path.endsWith('/complete')) completions++; return path.startsWith('/reconcile') ? { runs: [state] } : state; } });
    assert.equal(completions, 0);
    assert.equal((await runtime.dockerCall(['ps', '-a', '-q', '--filter', `name=^/${prefix}`])).stdout.trim(), '');
    assert.equal((await runtime.dockerCall(['inspect', '--format', '{{.State.Running}}', foreign.containerId])).stdout.trim(), 'true');
    const [record] = await journal.list(); assert.equal(record.cleanupKnown, true); assert.equal(record.phase, 'fenced');
    for (const name of ['verification-snapshot', 'verification-snapshot.manifest.json', 'harness-recovery']) await assert.rejects(lstat(`${record.runtime.folder}/${name}`), { code: 'ENOENT' });
    assert.equal((await lstat(`${record.runtime.folder}/verification-intent.json`)).isFile(), true);
    const receipt = { at: new Date().toISOString(), runId, signal: 'SIGKILL', verificationContainerRemoved: ready.containerId, auxiliarySnapshotContainerRemoved: ready.auxiliaryContainerId, privateScratchRemoved: true, auditIntentRetained: true, foreignWorkerSurvived: true, staleEpochCompletionPosts: completions, modelCalled: false };
    await writeFile(`${root}/.local/verification-sigkill-recovery.json`, JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
  } finally { child.kill('SIGKILL'); await runtime.cleanupAttempt(prefix); await runtime.releaseRun(foreign, { discard: true }); }
}
