import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CampRuntime } from '../src/index.mjs';
import { WorkerJournal, acquireWorkerLock, atomicJson } from '../src/durable-state.mjs';
import { acquireHostManager, poolResources, PoolAdmission, dockerHostFacts, attemptContainers } from '../src/host-manager.mjs';
import { openPoolState, loadPoolState } from '../src/pool-state.mjs';
import { resourcePolicy } from '../src/resource-policy.mjs';
import { startWorkerPool } from '../src/worker-pool.mjs';
import { serverProtocol } from '../../camp-protocol/src/index.js';
import { superviseOwnedChild } from '../../../scripts/mvp/owned-child.mjs';

const script = fileURLToPath(import.meta.url);
if (process.argv[2] === '--child') {
  const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const runtime = new CampRuntime({ home: config.home, imageId: config.imageId });
  const manager = await acquireHostManager({ runtime });
  const policy = resourcePolicy(config.env), resources = poolResources(policy);
  const metadata = await openPoolState({ home: config.home, apiUrl: config.apiUrl, baseWorkerId: config.workerId, dockerId: manager.facts.ID, resources, policy });
  const admission = new PoolAdmission({ runtime, resources });
  const results = []; let createdCount = 0;
  for (const workerId of metadata.workerIds) {
    await acquireWorkerLock(workerId);
    const journal = await new WorkerJournal({ home: config.home, apiUrl: config.apiUrl, workerId }).ready();
    const runId = randomUUID(), identity = runtime.runIdentity(`${runId}-e1`);
    const record = await journal.recordClaim({ id: runId, roomId: config.roomId, executor: 'agent', role: 'builder', epoch: 1 }, { runtime: identity });
    admission.hold(identity.prefix, workerId);
    const ids = [];
    for (const suffix of ['main', 'aux-proof']) {
      // If the daemon outcome becomes unknown after killing a Docker client,
      // retain that fact instead of claiming an empty prefix can never appear.
      await journal.update(record, { phase: 'proof_creating', proofPendingContainer: identity.prefix + suffix });
      const id = await admission.withContainer(identity.prefix, async () => {
        const answer = await runtime.dockerCall(['run', '-d', '--name', identity.prefix + suffix, '--label', 'camp.pool-proof=true', '--network', 'none', '--user', '501:20', '--cap-drop', 'ALL', '--pids-limit', String(policy.pidsLimit), '--cpus', String(policy.cpuMillis / 1000), '--memory', String(policy.memoryBytes), '--memory-swap', String(policy.memoryBytes), '--entrypoint', '/bin/sleep', config.imageId, 'infinity']);
        return answer.stdout.trim();
      });
      ids.push(id);
      await journal.update(record, { phase: 'proof_created', proofPendingContainer: null, proofCreatedContainers: [...ids] });
      if (++createdCount === config.failAfter) {
        await atomicJson(join(config.home, 'proof-injected.json'), { code: 'camp_pool_proof_injected', createdCount });
        throw new Error('camp_pool_proof_injected');
      }
    }
    await journal.update(record, { phase: 'executing' });
    results.push({ runId, workerId, identity, ids });
  }
  process.stdout.write(JSON.stringify({ event: 'pool_orphans_ready', attempts: results }) + '\n');
  setInterval(() => {}, 1000);
} else {
  if (!process.argv.includes('--real')) throw new Error('Use --real after stopping the production manager; this proof uses only new named Docker containers, no model or control-side database');
  const stamp = randomUUID(), home = resolve('.camp', 'pool-proof-' + stamp);
  await mkdir(home, { mode: 0o700 });
  const runtime = await new CampRuntime({ home }).ready();
  const env = { CAMP_AGENT_CPU_MILLIS: '250', CAMP_AGENT_MEMORY_MIB: '512', CAMP_AGENT_PIDS_LIMIT: '64', CAMP_MIN_FREE_MIB: '64', CAMP_POOL_HOST_MEMORY_RESERVE_MIB: '512' };
  const rawFailure = process.argv.find(arg => arg.startsWith('--fail-after='))?.slice('--fail-after='.length);
  if (rawFailure !== undefined && !/^[1-4]$/.test(rawFailure)) throw new Error('--fail-after must be 1, 2, 3 or 4');
  const config = { home, imageId: runtime.imageId, env, apiUrl: 'http://local-pool-proof.invalid', workerId: 'pool-proof-' + stamp, roomId: randomUUID(), ...(rawFailure ? { failAfter: Number(rawFailure) } : {}) };
  const input = join(home, 'proof-input.json'); await writeFile(input, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, [script, '--child', input], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const owned = superviseOwnedChild(child), interrupted = new AbortController();
  const onSignal = () => { interrupted.abort(new Error('Pool proof interrupted')); void owned.stop({ graceMs: 0 }).catch(() => {}); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, onSignal);
  let attempts = [], receipt, failure, cleanup;
  try {
    const ready = await new Promise((resolveReady, reject) => {
      let stdout = '', stderr = '';
      const abort = () => finish(reject)(interrupted.signal.reason);
      interrupted.signal.addEventListener('abort', abort, { once: true });
      const finish = action => value => { clearTimeout(timer); interrupted.signal.removeEventListener('abort', abort); action(value); };
      const timer = setTimeout(() => reject(new Error('Pool proof child startup timed out')), 45000);
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.once('error', finish(reject));
      child.once('exit', code => finish(reject)(new Error(`Pool proof child exited ${code}: ${stderr}`)));
      child.stdout.on('data', chunk => { stdout += chunk; const end = stdout.indexOf('\n'); if (end >= 0) { try { finish(resolveReady)(JSON.parse(stdout.slice(0, end))); } catch (error) { finish(reject)(error); } } });
    });
    attempts = ready.attempts; assert.equal(attempts.length, 2); assert.equal(attempts.flatMap(item => item.ids).length, 4);
    owned.assertRunning('Pool proof child exited before the intended SIGKILL');
    process.kill(-child.pid, 'SIGKILL'); await owned.exited;
    interrupted.signal.throwIfAborted();
    for (const id of attempts.flatMap(item => item.ids)) assert.equal((await runtime.dockerCall(['inspect', '--format', '{{.State.Running}}', id])).stdout.trim(), 'true');
    const states = new Map(attempts.map(item => [item.runId, { run: { id: item.runId, roomId: config.roomId, workerId: item.workerId, epoch: 1, executor: 'agent', taskKind: 'build', status: 'running', cleanupState: 'unknown' }, leaseValid: false, replaced: true, cleanupState: 'unknown' }]));
    let normalClaims = 0, completionPosts = 0;
    const request = async (path, body) => {
      if (path.startsWith('/reconcile?')) { const workerId = new URLSearchParams(path.split('?')[1]).get('workerId'); return { runs: [...states.values()].filter(state => state.run.workerId === workerId) }; }
      if (path.endsWith('/state')) return states.get(path.split('/')[2]);
      if (path.endsWith('/cleanup')) { const state = states.get(path.split('/')[2]); state.cleanupState = state.run.cleanupState = 'confirmed'; return state; }
      if (path.endsWith('/complete')) { completionPosts++; throw new Error('An expired epoch cannot submit a completion'); }
      if (path === '/protocol') return serverProtocol();
      if (path === '/claim') {
        assert.notEqual(body.restoreOnly, true); normalClaims++;
        for (const item of attempts) assert.equal((await runtime.dockerCall(['ps', '-a', '-q', '--filter', `name=^/${item.identity.prefix}`])).stdout.trim(), '', 'Every old orphan must disappear before either lane allocates');
        return { run: null, compatibility: null, requirements: null };
      }
      throw new Error('Unexpected local proof API request');
    };
    // flock helpers observe pipe closure after SIGKILL; wait for their release.
    for (let retry = 0; ; retry++) {
      let manager;
      try { manager = await acquireHostManager({ runtime }); await manager.release(); break; }
      catch (error) { if (retry === 20) throw error; await delay(25); }
    }
    await startWorkerPool({ env: { ...env, CAMP_API_URL: config.apiUrl, CAMP_WORKER_ID: config.workerId, CAMP_WORKER_TOKEN: 'local-proof-not-a-server-credential' }, runtime, request, once: true,
      workerOptions: { admitExecution: async () => {}, checkCapacity: async () => {} }, log: () => {},
    });
    assert.equal(completionPosts, 0); assert(normalClaims >= 2); assert([...states.values()].every(state => state.cleanupState === 'confirmed'));
    receipt = { schemaVersion: 1, at: new Date().toISOString(), modelCalls: 0, signal: 'SIGKILL', laneCount: 2, realOrphanCount: 4, allOrphansRemovedBeforeAnyNewClaim: true, expiredCompletionPosts: completionPosts, cleanupConfirmed: true, normalIdleClaims: normalClaims, imageId: runtime.imageId, home };
    interrupted.signal.throwIfAborted();
  } catch (error) { failure = error;
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, onSignal);
    // Stop the whole owned group, including Docker clients, and confirm exit
    // before reading any cleanup authority. Ready/stdout is not the journal.
    await owned.stop({ graceMs: 0, killMs: 5000 });
    let cleanupManager;
    for (let retry = 0; ; retry++) {
      try { cleanupManager = await acquireHostManager({ runtime }); break; }
      catch (error) { if (retry === 20) throw error; await delay(25); }
    }
    try {
      const metadata = await loadPoolState({ home, apiUrl: config.apiUrl, baseWorkerId: config.workerId, dockerId: (await dockerHostFacts(runtime)).ID });
      const records = [];
      for (const workerId of metadata?.workerIds ?? []) {
        const journal = new WorkerJournal({ home, apiUrl: config.apiUrl, workerId });
        try { await access(join(journal.folder, 'worker.json')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const lock = await acquireWorkerLock(workerId);
        try {
          await journal.ready();
          for (const record of await journal.list()) {
            const identity = runtime.runIdentity(`${record.runId}-e${record.epoch}`);
            if (!record.runtime || ['runId', 'prefix', 'folder'].some(key => record.runtime[key] !== identity[key])) throw new Error('Pool proof journal has an invalid owned attempt identity');
            records.push({ record, identity, journal });
          }
        } finally { await lock.release(); }
      }
      const before = (await attemptContainers(runtime)).filter(item => records.some(({ identity }) => item.name.startsWith(identity.prefix)));
      const unknown = records.some(({ record }) => record.proofPendingContainer);
      for (const { identity } of records) await runtime.cleanupAttempt(identity.prefix);
      const after = (await attemptContainers(runtime)).filter(item => records.some(({ identity }) => item.name.startsWith(identity.prefix)));
      cleanup = { ownedAttemptCount: records.length, containersBeforeCleanup: before.length, containersAfterCleanup: after.length, confirmed: !unknown && after.length === 0, requiresInspection: unknown };
      await atomicJson(join(home, 'proof-cleanup.json'), cleanup);
      for (const { record, journal } of records) {
        const lock = await acquireWorkerLock(journal.workerId);
        try { await journal.update(record, { cleanupKnown: !record.proofPendingContainer && after.length === 0, phase: ['settled', 'fenced'].includes(record.phase) ? record.phase : 'interrupted', ...(record.proofPendingContainer ? { requiresInspection: true } : {}), proofCleanupAt: new Date().toISOString() }); }
        finally { await lock.release(); }
      }
      if (!cleanup.confirmed) throw new Error('Pool proof cleanup could not exclude a late Docker creation; retained journal evidence requires inspection');
    } finally { await cleanupManager.release(); }
  }
  if (failure) {
    const injected = await readFile(join(home, 'proof-injected.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!interrupted.signal.aborted && config.failAfter && injected?.code === 'camp_pool_proof_injected' && injected.createdCount === config.failAfter && cleanup.containersBeforeCleanup === config.failAfter && cleanup.confirmed) receipt = { schemaVersion: 1, at: new Date().toISOString(), modelCalls: 0, partialStartupFailure: true, injectedAfterContainers: config.failAfter, cleanup, imageId: runtime.imageId, home };
    else throw failure;
  }
  await atomicJson(join(home, 'receipt.json'), { ...receipt, finalCleanup: cleanup });
  console.log(JSON.stringify({ ...receipt, finalCleanup: cleanup }));
}
