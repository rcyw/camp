import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CampRuntime } from './index.mjs';
import { LeaseGuard, checkedClaim, splitProgress } from './worker-core.mjs';
import { WorkerJournal, acquireWorkerLock, runTokenForClaim } from './durable-state.mjs';
import { recoverWorker, dispatchOutbox, checkedState } from './worker-recovery.mjs';
import { createModelProxy } from './model-proxy.mjs';
import { ModelBudget, RunLimitError, runLimits } from './run-limits.mjs';

const transient = error => !['camp_journal_io', 'camp_journal_invalid'].includes(error.code) && (!error.status || error.status >= 500 || [408, 429].includes(error.status));
export async function startWorker(options = {}) {
  const env = options.env ?? process.env;
  const apiUrl = (env.CAMP_API_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
  const workerToken = env.CAMP_WORKER_TOKEN;
  const workerId = env.CAMP_WORKER_ID ?? `camp-${hostname()}`;
  if (!workerToken) throw new Error('CAMP_WORKER_TOKEN is required; obtain it from the Room worker-token endpoint');
  if (!env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required before claiming tasks');
  const limits = runLimits(env);
  const runtime = options.runtime ?? await new CampRuntime().ready();
  const log = options.log ?? (entry => console.log(JSON.stringify(entry)));
  let stopping = false;
  let activeAbort;
  const stop = () => { stopping = true; activeAbort?.abort(new Error('Worker stopping')); };
  const signalSource = options.signalSource ?? process;
  for (const signal of ['SIGTERM', 'SIGINT']) signalSource.on(signal, stop);
  let lock;
  try {
    lock = await acquireWorkerLock(workerId, { onLost: error => { stopping = true; activeAbort?.abort(error); } });
    const journal = options.journal ?? await new WorkerJournal({ home: runtime.home, apiUrl, workerId }).ready();
    const request = options.request ?? (async (path, body) => {
      let response;
      try { response = await fetch(`${apiUrl}/api/camp/worker${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      }); } catch (error) { throw Object.assign(new Error(`Camp worker API transport failed at ${path.split('?')[0]}`), { code: 'camp_api_transport', cause: error }); }
      if (!response.ok) throw Object.assign(new Error(`Camp worker API ${response.status} at ${path.split('?')[0]}`), { status: response.status });
      try { return await response.json(); }
      catch (error) { throw Object.assign(new Error(`Camp worker API response was interrupted at ${path.split('?')[0]}`), { code: 'camp_api_transport', cause: error }); }
    });
    const createSession = options.createSession ?? (await import('../../daemon/src/drivers/dshAcp.ts')).createDshRuntimeSession;

    async function executeRun(claim, record) {
      const controller = new AbortController();
      activeAbort = controller;
      const timeout = setTimeout(() => controller.abort(new RunLimitError('Run wall-clock deadline exceeded')), Math.max(1, Date.parse(record.deadlineAt) - Date.now()));
      let run, session, modelProxy, heartbeat, closed = false;
      let heartbeatWork = Promise.resolve();
      let text = '', sessionId, failure;
      let progress = Promise.resolve();
      const context = { workerId: record.workerId, epoch: record.epoch };
      const emitProgress = content => {
        progress = progress.then(() => {
          if (closed || controller.signal.aborted) return;
          return request(`/runs/${claim.id}/events`, { ...context, type: 'progress', content });
        }).catch(error => { failure ??= error; controller.abort(error); });
      };
      const lease = new LeaseGuard({
        heartbeat: async () => {
          const result = await request(`/runs/${claim.id}/heartbeat`, context);
          await journal.update(record, { leaseExpiresAt: result.run.leaseExpiresAt });
          return result;
        },
        onStop: async error => { controller.abort(error); try { await session?.stop(); } catch (stopError) { failure ??= stopError; } },
      });
      const renew = () => {
        heartbeatWork = (async () => {
          await lease.refresh();
          if (!closed && lease.state === 'active') heartbeat = setTimeout(renew, 8_000);
        })();
        return heartbeatWork;
      };
      try {
        await renew();
        controller.signal.throwIfAborted();
        await journal.update(record, { phase: 'preparing' });
        const project = await runtime.prepareProject({ projectId: `room:${claim.roomId}`, name: claim.project?.name, sourcePath: claim.project?.repoPath });
        const candidates = (claim.dependencies ?? []).flatMap(task => task.artifacts ?? []).filter(artifact => artifact.type === 'layerfs' && artifact.commitId);
        const inherited = candidates.findLast(artifact => artifact.role === 'builder') ?? candidates.at(-1);
        const baseRef = inherited?.commitId ?? claim.project?.baseRef ?? 'main';
        run = await runtime.prepareRun({ project, runId: record.runtime.runId, roleId: claim.role, baseRef, owner: { apiUrl, workerId, runId: claim.id, epoch: claim.epoch } });
        await journal.update(record, { phase: 'prepared', runtime: { ...record.runtime, containerId: run.containerId } });
        controller.signal.throwIfAborted();
        await runtime.installDsh(run);
        await runtime.installPlugin(run, env.CAMP_DSH_PLUGIN ?? fileURLToPath(new URL('../../dsh-plugin', import.meta.url)));
        const sandboxApi = await runtime.sandboxApiUrl(run, apiUrl);
        modelProxy = await createModelProxy({
          apiKey: env.DEEPSEEK_API_KEY, baseUrl: env.DEEPSEEK_BASE_URL, host: new URL(sandboxApi).hostname,
          budget: new ModelBudget(limits),
          onBudget: async counters => { try { await journal.update(record, { modelUsage: counters }); } catch (error) { controller.abort(error); throw error; } },
          onLimit: error => controller.abort(error),
        });
        const launch = runtime.launchSpec(run, { env: {
          DEEPSEEK_API_KEY: modelProxy.token, DEEPSEEK_BASE_URL: modelProxy.baseUrl,
          CAMP_API_URL: sandboxApi, CAMP_ROOM_ID: claim.roomId, CAMP_RUN_ID: claim.id,
          CAMP_RUN_EPOCH: String(claim.epoch), CAMP_WORKER_ID: workerId, CAMP_RUN_TOKEN: claim.runToken,
          DSH_PERMISSION_MODE: 'danger-full-access',
        } });
        session = createSession({ ...launch, cwd: run.workspacePath, processCwd: process.cwd(), model: env.CAMP_DSH_MODEL ?? 'profile', approvePermissions: true, signal: controller.signal, handshakeTimeoutMs: 30_000 });
        const settled = new Promise((resolveTurn, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
          session.on('runtime_event', event => {
            if (event.kind === 'text') { text = (text + event.text).slice(-200_000); for (const chunk of splitProgress(event.text)) emitProgress(chunk); }
            if (event.kind === 'session_init') sessionId = event.sessionId;
            if (event.kind === 'error') failure = new Error(event.message);
            if (event.kind === 'turn_end') failure ? reject(failure) : resolveTurn();
          });
          session.on('error', reject);
          session.on('exit', () => reject(new Error('DSH exited before a completed turn')));
        });
        settled.catch(() => {});
        await journal.update(record, { phase: 'executing' });
        log({ event: 'run_started', runId: claim.id, epoch: claim.epoch, role: claim.role });
        emitProgress(`${claim.role} started in an isolated LayerFS workspace.`);
        const started = await session.start({ text: claim.prompt });
        if (!started.ok) throw new Error(`DSH did not accept the task: ${started.error ?? 'no error detail'}`);
        await settled;
        await session.stop();
        session = null;
        await modelProxy.close();
        modelProxy = null;
        await runtime.archiveSession(run);
        lease.assertActive();
        controller.signal.throwIfAborted();
        const endContext = await request(`/runs/${claim.id}/context`);
        const review = endContext.review ?? endContext.run?.review;
        const evidence = review?.evidence;
        const validEvidence = typeof evidence === 'string' ? evidence.trim() : Array.isArray(evidence) && evidence.length && evidence.every(item => typeof item === 'string' && item.trim());
        if (claim.role === 'reviewer' && (!review || !['approved', 'changes_requested'].includes(review.outcome) || !validEvidence)) throw new Error('Reviewer did not record a structured verdict with evidence through camp_review');
        const artifact = { ...await runtime.commitCandidate(run), runId: claim.id, runtimeRunId: run.runId };
        await journal.update(record, { phase: 'candidate', candidate: artifact });
        if (claim.role === 'reviewer' && review.outcome === 'approved' && (!inherited?.rootId || artifact.rootId !== inherited.rootId)) throw new Error('review_candidate_changed: approval workspace root differs from the builder candidate');
        await progress;
        controller.signal.throwIfAborted();
        const summary = text.trim().slice(0, 15000) || 'DSH completed the task and saved a LayerFS candidate.';
        const artifacts = [artifact, ...(claim.role === 'reviewer' && inherited ? [inherited] : []), ...(endContext.artifacts ?? [])].slice(0, 30);
        const completion = { ...context, status: 'completed', summary, artifacts, ...(sessionId ? { sessionId } : {}), ...(claim.role === 'reviewer' ? { outcome: review.outcome } : {}) };
        await journal.stageCompletion(record, completion);
        log({ event: 'result_staged', runId: claim.id, epoch: claim.epoch });
        await request(`/runs/${claim.id}/events`, { ...context, type: 'artifact', content: 'Saved immutable LayerFS candidate.', artifact });
        await runtime.releaseRun(run);
        run = null;
        await journal.update(record, { cleanupKnown: true, phase: 'cleaned' });
        controller.signal.throwIfAborted();
        lease.assertActive();
        await journal.prepareCompletion(record, completion);
        log({ event: 'completion_prepared', runId: claim.id, epoch: claim.epoch });
        closed = true;
        clearTimeout(heartbeat);
        const state = checkedState(await request(`/runs/${claim.id}/state`), record);
        const outcome = await dispatchOutbox({ journal, record, request, state, log });
        if (outcome === 'settled') log({ event: 'completed', runId: claim.id, epoch: claim.epoch, role: claim.role, commitId: artifact.commitId });
      } catch (error) {
        let cleanupKnown = error.cleanupKnown !== false;
        try {
          await session?.stop();
          session = null;
          if (run) await runtime.abortRun(run, lease.state);
          else if (!record.cleanupKnown) await runtime.cleanupAttempt(record.runtime.prefix);
        } catch { cleanupKnown = false; }
        await progress;
        if (record.completion) {
          await journal.update(record, { cleanupKnown, phase: cleanupKnown ? 'completion_pending' : 'result_staged' });
          log({ event: 'completion_outcome_unknown', runId: claim.id, epoch: claim.epoch });
        } else {
          const lastErrorCode = stopping ? 'worker_shutdown' : error.code === 'run_budget_exhausted' ? error.code : error.code === 'camp_api_transport' || (error.status && transient(error)) ? 'worker_interrupted' : 'dsh_execution_failed';
          const lastError = String(error.message ?? error).slice(0, 15000);
          const failureCompletion = { ...context, status: 'failed', summary: `Execution stopped: ${lastError}`.slice(0, 15000), error: lastErrorCode, ...(sessionId ? { sessionId } : {}) };
          await journal.update(record, { cleanupKnown, phase: 'interrupted', lastErrorCode, lastError, failureCompletion, ...(error.cleanupKnown === false ? { requiresInspection: true } : {}) });
          log({ event: lease.state === 'lost' ? 'lease_lost' : lease.state === 'cancelled' ? 'cancelled' : 'run_interrupted', runId: claim.id, epoch: claim.epoch, cleanupKnown, reason: error.message ?? String(error) });
          if (cleanupKnown && !record.requiresInspection) {
            try {
              const state = checkedState(await request(`/runs/${claim.id}/state`), record);
              if (state.leaseValid && !state.replaced && state.run.workerId === record.workerId && state.run.epoch === record.epoch) {
                const payload = state.run.cancelRequested ? { ...context, status: 'cancelled', summary: 'Execution stopped and its sandbox was removed.' } : failureCompletion;
                await journal.prepareCompletion(record, payload);
                log({ event: 'completion_prepared', runId: claim.id, epoch: claim.epoch });
                await dispatchOutbox({ journal, record, request, state, log });
              }
            } catch (settlementError) { log({ event: 'failure_settlement_pending', runId: claim.id, epoch: claim.epoch, reason: settlementError.message }); }
          }
        }
      } finally {
        closed = true;
        clearTimeout(heartbeat);
        clearTimeout(timeout);
        await heartbeatWork;
        activeAbort = null;
        await modelProxy?.close();
      }
    }

    log({ event: 'worker_ready', workerId, apiUrl, journalHome: journal.folder });
    let backoff = 500;
    while (!stopping) {
      try {
        const pendingClaim = await journal.pendingClaim();
        // Resolve an ambiguous claim using its original id before reconciliation;
        // otherwise reconciliation could fail a claim whose response alone was lost.
        if (!pendingClaim) await recoverWorker({ journal, runtime, request, log });
        if (stopping) break;
        const claimId = pendingClaim ?? await journal.claimIntent();
        const value = await request('/claim', { workerId, claimId, runToken: runTokenForClaim(workerToken, claimId) });
        const claim = checkedClaim(value);
        if (claim) {
          const existing = (await journal.list()).find(record => record.runId === claim.id && record.epoch === claim.epoch);
          if (existing) {
            await journal.finishClaim();
            await recoverWorker({ journal, runtime, request, log });
            continue;
          }
          const record = await journal.recordClaim(claim, { claimId, deadlineAt: new Date(Date.now() + limits.runTimeoutMs).toISOString(), runtime: runtime.runIdentity(`${claim.id}-e${claim.epoch}`) });
          await journal.finishClaim();
          await executeRun(claim, record);
        } else {
          await journal.finishClaim();
          if (env.CAMP_WORKER_ONCE === '1' && !value.closed) break;
          await delay(1500);
        }
        backoff = 500;
      } catch (error) {
        if (!transient(error)) {
          log({ event: error.code?.startsWith('camp_journal_') ? 'worker_state_failed' : error.status === 401 ? 'worker_token_rejected' : 'worker_protocol_rejected', workerId, status: error.status, reason: error.message, action: 'Inspect the journal and credential before restarting.' });
          throw error;
        }
        log({ event: 'worker_api_backoff', workerId, delayMs: backoff, reason: error.message });
        await delay(backoff);
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
  } finally {
    for (const signal of ['SIGTERM', 'SIGINT']) signalSource.off(signal, stop);
    await lock?.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startWorker().catch(error => { console.error(JSON.stringify({ event: 'worker_stopped', reason: error.message })); process.exitCode = 1; });
}
