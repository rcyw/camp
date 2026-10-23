import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { startWorker } from './worker.mjs';
import { CampRuntime } from './index.mjs';
import { WorkerJournal, acquireWorkerLock } from './durable-state.mjs';
import { recoverWorker, restoreWorkerForClaims } from './worker-recovery.mjs';
import { workerApiUrl, workerApiRequest, workerIdForEnvironment } from './worker-preflight.mjs';
import { resourcePolicy } from './resource-policy.mjs';
import { acquireHostManager, admitPoolHost, attemptContainers, PoolAdmission, poolResources, managerFailure } from './host-manager.mjs';
import { openPoolState, loadPoolState, assertPoolConfiguration, checkPoolJournals } from './pool-state.mjs';
import { parseExecutionPool } from '../../camp-protocol/src/index.js';
import { openStorageIdentity } from './storage-identity.mjs';

function barrier(count) {
  let arrived = 0, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  return { arrive: async beforeOpen => { if (++arrived === count) { try { await beforeOpen(); resolveReady(); } catch (error) { rejectReady(error); } } return ready; }, reject: error => rejectReady(error) };
}
/** Bounded local manager, not another agent scheduler. Each lane preserves the
 * serial worker's fencing, exact outbox and physical cleanup responsibilities. */
export async function startWorkerPool(options = {}) {
  const env = options.env ?? process.env;
  const apiUrl = workerApiUrl(env), baseWorkerId = workerIdForEnvironment(env);
  if (!env.CAMP_WORKER_TOKEN) throw managerFailure('A Room worker credential is required', 'camp_auth_required');
  const log = options.log ?? (entry => console.log(JSON.stringify(entry)));
  const runtime = options.runtime ?? new CampRuntime({ env });
  const request = options.request ?? workerApiRequest(env);
  const signals = options.signalSource ?? process, laneSignals = new EventEmitter();
  const ready = barrier(2), idle = new Set();
  let stopped = false, fatal, manager, baseLock, admission;
  const stop = error => {
    if (error && !fatal) fatal = error;
    if (stopped) return;
    stopped = true;
    if (admission) admission.closed = true;
    ready.reject(error ?? managerFailure('Pool stopped before recovery completed', 'camp_pool_stopped'));
    laneSignals.emit('SIGTERM');
  };
  const onSignal = () => stop();
  for (const name of ['SIGTERM', 'SIGINT']) signals.on(name, onSignal);
  try {
    manager = options.manager ?? await acquireHostManager({ runtime, onLost: stop });
    const identity = { home: runtime.home, apiUrl, baseWorkerId, dockerId: manager.facts.ID };
    let policy, metadata = await loadPoolState(identity);
    baseLock = await acquireWorkerLock(baseWorkerId, { onLost: stop });
    const baseJournal = await new WorkerJournal({ home: runtime.home, apiUrl, workerId: baseWorkerId }).ready();
    const recover = async (journal, selectedRuntime) => {
      let backoff = 250;
      for (;;) {
        if (stopped) return;
        try {
          await restoreWorkerForClaims({ journal, runtime: selectedRuntime, request, workerToken: env.CAMP_WORKER_TOKEN, log });
          await recoverWorker({ journal, runtime: selectedRuntime, request, log });
          const records = await journal.list();
          if (records.some(record => record.requiresInspection || record.phase === 'ownership_conflict' || !record.cleanupKnown)) throw managerFailure('Recovery left an unsafe attempt; no lane may claim');
          return;
        } catch (error) {
          if (!(error.code === 'camp_api_transport' || error.status >= 500 || [408, 429].includes(error.status))) throw error;
          log({ event: 'pool_recovery_backoff', workerId: journal.workerId, delayMs: backoff });
          await new Promise(resolveDelay => setTimeout(resolveDelay, backoff)); backoff = Math.min(backoff * 2, 5000);
        }
      }
    };
    // Retire an old serial worker without ever executing another old claim.
    await recover(baseJournal, runtime);
    if (stopped) return { stopped: true };
    if (await baseJournal.pendingClaim()) {
      // restoreOnly established this intent is unbound; it must not become a
      // surprise serial allocation when upgrading the home to a pool.
      await baseJournal.finishClaim();
      log({ event: 'pool_retired_unbound_serial_intent', workerId: baseWorkerId });
    }
    if (stopped) return { stopped: true };
    await checkPoolJournals({ home: runtime.home, apiUrl, workerIds: [baseWorkerId, ...metadata?.workerIds ?? []] });
    if (!metadata) {
      // First-time pool setup must not block an old serial result either.
      policy = resourcePolicy(env);
      metadata = await openPoolState({ ...identity, resources: poolResources(policy), policy });
    }
    const resources = metadata.resources;
    const executionPool = parseExecutionPool({ poolId: metadata.poolId, storageId: metadata.storageId, maxParallel: 2, workerIds: metadata.workerIds, resources });
    admission = new PoolAdmission({ runtime, resources, onFatal: stop });
    const lanes = metadata.workerIds.map((workerId, index) => ({ workerId, index, runtime: options.createRuntime ? options.createRuntime({ workerId, index, executionPool }) : new CampRuntime({ home: runtime.home, imageId: runtime.imageId, layerfsSource: runtime.source, toolchainBundle: runtime.toolchainBundle, native: runtime.native, daemon: runtime.daemon, docker: runtime.docker, dshArchive: runtime.dshArchive, resources: policy, admission }) }));
    for (const lane of lanes) {
      lane.runtime.admission = admission; lane.runtime.resourcePolicy = policy;
      lane.journal = await new WorkerJournal({ home: runtime.home, apiUrl, workerId: lane.workerId }).ready();
    }
    const checkBarrier = async () => {
      const records = (await Promise.all([baseJournal, ...lanes.map(lane => lane.journal)].map(journal => journal.list()))).flat();
      const containers = await attemptContainers(runtime);
      const knownPrefixes = new Set(records.map(record => runtime.runIdentity(`${record.runId}-e${record.epoch}`).prefix));
      if (containers.length) throw managerFailure(containers.some(item => ![...knownPrefixes].some(prefix => item.name.startsWith(prefix))) ? 'Foreign managed containers exist; automatic pool cleanup is not authorized' : 'Recovered attempt containers still exist; pool admission remains closed');
      // New execution settings cannot invalidate an old immutable outbox.
      // Check configuration only after all three journals finished recovery.
      policy = resourcePolicy(env);
      assertPoolConfiguration(metadata, { resources: poolResources(policy), policy });
      const storage = await openStorageIdentity(identity);
      if (storage.storageId !== executionPool.storageId) throw managerFailure('Pool and physical storage identities differ after recovery', 'camp_pool_identity');
      await (options.admitHost ?? admitPoolHost)({ runtime, policy, resources, facts: manager.facts, env });
      for (const lane of lanes) lane.runtime.resourcePolicy = policy;
      log({ event: 'pool_recovery_ready', poolId: executionPool.poolId, storageId: executionPool.storageId, workerIds: metadata.workerIds, resources });
    };
    const tasks = lanes.map(lane => (async () => {
      try {
        const laneEnv = { ...env, CAMP_WORKER_ID: lane.workerId };
        delete laneEnv.CAMP_WORKER_ONCE;
        const selected = typeof options.workerOptions === 'function' ? await options.workerOptions(lane) : options.workerOptions ?? {};
        if (stopped) return;
        await startWorker({ ...selected, env: laneEnv, runtime: lane.runtime, journal: lane.journal, request, signalSource: laneSignals, manager, executionPool, restoreOnlyRecovery: true, log,
          ...(options.createSession ? { createSession: options.createSession } : {}),
          onFatal: stop,
          recoveryBarrier: async ({ journal }) => {
            const records = await journal.list();
            if (records.some(record => record.requiresInspection || !record.cleanupKnown || record.phase === 'ownership_conflict')) throw managerFailure('A lane did not finish safe recovery');
            await ready.arrive(checkBarrier);
          },
          beforeClaim: async () => { await admission.beforeClaim(); idle.delete(lane.workerId); },
          beforeExecution: async ({ record }) => { if (stopped) throw managerFailure('Pool is draining', 'camp_pool_stopped'); admission.hold(record.runtime.prefix, lane.workerId); },
          afterExecution: async ({ record }) => { await admission.finish(record.runtime.prefix, record); },
          onIdle: async () => { idle.add(lane.workerId); if ((options.once || env.CAMP_POOL_ONCE === '1') && idle.size === 2 && admission.attempts.size === 0) stop(); },
        });
        if (!stopped) stop(managerFailure('A pool lane exited unexpectedly'));
      } catch (error) { if (stopped && !fatal && error.code === 'camp_pool_stopped') return; stop(error); throw error; }
    })());
    const results = await Promise.allSettled(tasks);
    if (fatal) throw fatal;
    const failed = results.find(item => item.status === 'rejected');
    if (failed) throw failed.reason;
    return { executionPool, stopped: true };
  } catch (error) { stop(error); throw error; }
  finally {
    for (const name of ['SIGTERM', 'SIGINT']) signals.off(name, onSignal);
    await baseLock?.release();
    if (manager && manager !== options.manager) await manager.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startWorkerPool({ once: process.argv.includes('--once') }).catch(error => { console.error(JSON.stringify({ event: 'pool_stopped', code: error.code, reason: error.message })); process.exitCode = 1; });
}
