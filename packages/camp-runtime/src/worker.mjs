import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CampRuntime } from './index.mjs';
import { LeaseGuard, checkedClaim, splitProgress } from './worker-core.mjs';
import { WorkerJournal, acquireWorkerLock, runTokenForClaim } from './durable-state.mjs';
import { recoverWorker, dispatchOutbox, checkedState, restoreWorkerForClaims } from './worker-recovery.mjs';
import { createModelProxy } from './model-proxy.mjs';
import { ModelBudget, RunLimitError, runLimits } from './run-limits.mjs';
import { checkedRunPolicy, completionPolicy, controlledTurnResult, completionSummary } from './run-policy.mjs';
import { negotiateWorker, assertClaimCompatibility, protocolFailure, unmatchedTaskKind } from './worker-protocol.mjs';
import { parseCandidate, parseIntegrationInput, parseIntegrationReport, CAMP_DAG_INTEGRATION_ALGORITHM } from '../../camp-protocol/src/index.js';
import { createChangeSet } from './change-set.mjs';
import { runTrustedVerification } from './verification.mjs';
import { inspectWorker, workerApiRequest, workerApiUrl, workerIdForEnvironment } from './worker-preflight.mjs';
import { resourcePolicy, storageCapacity } from './resource-policy.mjs';
import { runTrustedIntegration } from './integration.mjs';
import { integrationCompletion } from './integration-completion.mjs';
import { acquireHostManager, assertNoManagedContainers } from './host-manager.mjs';
import { loadDshRuntimeSession } from './dsh-session-loader.mjs';
import { installSandboxTrust } from './sandbox-trust.mjs';
import { managedWorkerCredential } from './worker-credentials.mjs';

const transient = error => !['camp_journal_io', 'camp_journal_invalid'].includes(error.code) && (!error.status || error.status >= 500 || [408, 429].includes(error.status));
export async function startWorker(options = {}) {
  const env = options.env ?? process.env;
  const apiConfiguration = { CAMP_API_URL: env.CAMP_API_URL, CAMP_WORKER_TOKEN: env.CAMP_WORKER_TOKEN };
  const apiUrl = workerApiUrl(apiConfiguration);
  const workerToken = apiConfiguration.CAMP_WORKER_TOKEN;
  const workerId = workerIdForEnvironment(env);
  if (!workerToken) throw new Error('CAMP_WORKER_TOKEN is required; obtain it from the Room worker-token endpoint');
  let limits;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 8000;
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0 || heartbeatIntervalMs > 10000) throw new Error('Heartbeat interval must be a positive integer at most 10000ms');
  const runtime = options.runtime ?? new CampRuntime({ env });
  const standalone = runtime instanceof CampRuntime && !options.executionPool;
  const restoreOnlyRecovery = options.restoreOnlyRecovery || standalone;
  const pluginPath = env.CAMP_DSH_PLUGIN ?? fileURLToPath(new URL('../../dsh-plugin', import.meta.url));
  const log = options.log ?? (entry => console.log(JSON.stringify(entry)));
  let stopping = false;
  let activeAbort;
  const stop = () => { stopping = true; activeAbort?.abort(new Error('Worker stopping')); };
  const signalSource = options.signalSource ?? process;
  for (const signal of ['SIGTERM', 'SIGINT']) signalSource.on(signal, stop);
  let lock, hostManager;
  try {
    // Only a plain-object runtime is a test seam. An explicitly supplied real
    // Runtime obeys the same manager lock as the CLI's default instance.
    hostManager = options.manager ?? (runtime instanceof CampRuntime ? await (options.acquireManager ?? acquireHostManager)({ runtime, onLost: error => { stop(); options.onFatal?.(error); } }) : null);
    lock = await acquireWorkerLock(workerId, { onLost: error => { stopping = true; activeAbort?.abort(error); options.onFatal?.(error); } });
    const journal = options.journal ?? await new WorkerJournal({ home: runtime.home, apiUrl, workerId }).ready();
    const request = options.request ?? workerApiRequest(apiConfiguration);
    let createSession = options.createSession;
    const computeChangeSet = options.createChangeSet ?? createChangeSet;
    const verifyCandidate = options.verifyCandidate ?? runTrustedVerification;
    const integrateCandidates = options.integrateCandidates ?? runTrustedIntegration;
    const checkCapacity = options.checkCapacity ?? (() => storageCapacity(runtime, runtime.resourcePolicy ?? resourcePolicy(env)));
    let checkedProjectDigest;
    const admitExecution = options.admitExecution ?? (async () => {
      const setup = await request('/setup');
      if (!checkedProjectDigest || setup.projectDigest !== checkedProjectDigest) {
        const checked = await inspectWorker({ runtime, env: { ...env, CAMP_WORKER_ID: workerId }, request, report: true, setup, localChecks: options.preflightChecks, capacity: checkCapacity, executionPool: options.executionPool });
        log({ event: 'worker_preflight', workerId, ready: checked.ready, report: checked.report });
        if (!checked.ready) {
          if (checked.apiFailure) throw Object.assign(new Error(checked.apiFailure.retryable ? 'Worker preflight API is temporarily unavailable; no task was allocated' : 'Worker preflight API authentication or compatibility failed; no task was allocated'), checked.apiFailure);
          throw Object.assign(new Error('Worker prerequisites failed before task allocation; run doctor and correct the reported checks'), { code: 'camp_preflight_failed', status: 409 });
        }
        checkedProjectDigest = setup.projectDigest;
      }
    });

    async function executeRun(claim, record, harnesses) {
      const controller = new AbortController();
      activeAbort = controller;
      const timeout = setTimeout(() => controller.abort(new RunLimitError('Run wall-clock deadline exceeded')), Math.max(1, Date.parse(record.deadlineAt) - Date.now()));
      let run, session, modelProxy, heartbeat, closed = false;
      let promptActive = false, turnFinished = false, controlledYield, finishTurn, sessionStop;
      const stopSession = async () => {
        if (!session) return;
        sessionStop ??= Promise.resolve().then(() => session.stop());
        await sessionStop;
      };
      let heartbeatWork = Promise.resolve();
      let text = '', sessionId, failure;
      let progress = Promise.resolve();
      const context = { workerId: record.workerId, epoch: record.epoch };
      const emitProgress = content => {
        progress = progress.then(() => {
          if (closed || controlledYield || controller.signal.aborted) return;
          return request(`/runs/${claim.id}/events`, { ...context, type: 'progress', content });
        }).catch(error => { failure ??= error; controller.abort(error); });
      };
      const lease = new LeaseGuard({
        heartbeat: async () => {
          await checkCapacity();
          const result = await request(`/runs/${claim.id}/heartbeat`, context);
          await journal.update(record, { leaseExpiresAt: result.run.leaseExpiresAt });
          return result;
        },
        onStop: async error => { controller.abort(error); try { await stopSession(); } catch (stopError) { failure ??= stopError; } },
      });
      const renew = () => {
        heartbeatWork = (async () => {
          await lease.refresh();
          if (!closed && lease.state === 'active' && promptActive && !turnFinished && claim.workflow === 'serial') {
            const liveContext = await request(`/runs/${claim.id}/context`);
            if (!closed && promptActive && !turnFinished) {
              const result = controlledTurnResult(claim, liveContext);
              if (result) {
                controller.signal.throwIfAborted();
                if (failure) throw failure;
                controlledYield = result;
                promptActive = false;
                log({ event: 'controlled_yield', runId: claim.id, epoch: claim.epoch, reason: result.kind, questionId: result.question.id });
                // The model does not own this scheduling decision. Wait for ACP
                // and its process to be quiescent before taking any snapshot.
                await stopSession();
                await lease.refresh();
                lease.assertActive();
                controller.signal.throwIfAborted();
                turnFinished = true;
                finishTurn();
              }
            }
          }
          if (!closed && lease.state === 'active') heartbeat = setTimeout(renew, heartbeatIntervalMs);
        })().catch(error => { controller.abort(error); });
        return heartbeatWork;
      };
      const finishCleaned = async completion => {
        await journal.update(record, { cleanupKnown: true, phase: 'cleaned' });
        controller.signal.throwIfAborted();
        lease.assertActive();
        await journal.prepareCompletion(record, completion);
        log({ event: 'completion_prepared', runId: claim.id, epoch: claim.epoch });
        closed = true;
        clearTimeout(heartbeat);
        const state = checkedState(await request(`/runs/${claim.id}/state`), record);
        return dispatchOutbox({ journal, record, request, state, log });
      };
      try {
        await renew();
        controller.signal.throwIfAborted();
        await journal.update(record, { phase: 'preparing' });
        const project = await runtime.prepareProject({ projectId: `room:${claim.roomId}`, name: claim.project?.name, sourcePath: claim.project?.repoPath, signal: controller.signal });
        if (claim.executor === 'integration') {
          const integrationInput = parseIntegrationInput(claim.integrationInput);
          parseCandidate(integrationInput.base, { projectId: project.projectId, imageId: project.imageId });
          if (['projectId', 'imageId', 'refKind', 'refId', 'rootId'].some(key => integrationInput.base[key] !== claim.inputCandidate?.[key])) throw new Error('Integration claim changed its frozen baseline');
          // A DAG join can use an intermediate ancestor as its native merge
          // base. Display changes still describe the complete Goal baseline.
          const integrationGoalBaseline = integrationInput.algorithm === CAMP_DAG_INTEGRATION_ALGORITHM
            ? parseCandidate(claim.goalBaseline, { projectId: project.projectId, imageId: project.imageId })
            : integrationInput.base;
          await journal.update(record, { phase: 'integration_preparing', integrationInput, integrationGoalBaseline });
          const stage = async value => {
            controller.signal.throwIfAborted(); lease.assertActive();
            const integrationReport = parseIntegrationReport(value);
            const integrationChangeSet = integrationReport.status === 'merged' ? await computeChangeSet({ runtime, ownerRun: record.runtime, base: integrationGoalBaseline, target: integrationReport.candidate, signal: controller.signal }) : undefined;
            controller.signal.throwIfAborted(); lease.assertActive();
            await journal.update(record, { phase: 'integration_result_recorded', integrationReport, ...(integrationChangeSet ? { integrationChangeSet } : {}) });
            await journal.stageCompletion(record, integrationCompletion(record));
            log({ event: 'result_staged', runId: claim.id, epoch: claim.epoch, executor: 'integration', result: integrationReport.status });
          };
          log({ event: 'run_started', runId: claim.id, epoch: claim.epoch, executor: 'integration', operationId: claim.operationId });
          const report = await integrateCandidates({ runtime, ownerRun: record.runtime, integrationInput, signal: controller.signal, onIntent: async () => { controller.signal.throwIfAborted(); lease.assertActive(); await journal.update(record, { phase: 'integrating' }); }, onResult: stage });
          if (!record.completion) await stage(report);
          await runtime.cleanupAttempt(record.runtime.prefix);
          const outcome = await finishCleaned(record.completion.payload);
          if (outcome === 'settled') log({ event: 'completed', runId: claim.id, epoch: claim.epoch, executor: 'integration', result: record.integrationReport.status });
          return;
        }
        if (claim.executor === 'verification') {
          const inputCandidate = parseCandidate(claim.inputCandidate, { projectId: project.projectId, imageId: project.imageId });
          let completion;
          const stage = async verification => {
            controller.signal.throwIfAborted(); lease.assertActive();
            completion = { ...context, status: 'completed', summary: `Trusted verification finished: ${verification.checks.map(check => check.id).join(', ')}. The server determines the policy result.`, inputCandidate, verification };
            await journal.stageCompletion(record, completion);
            log({ event: 'result_staged', runId: claim.id, epoch: claim.epoch, executor: 'verification' });
          };
          await journal.update(record, { phase: 'verifying', inputCandidate });
          log({ event: 'run_started', runId: claim.id, epoch: claim.epoch, executor: 'verification', operationId: claim.operationId });
          const report = await verifyCandidate({ runtime, ownerRun: record.runtime, candidate: inputCandidate, verificationPolicy: claim.verificationPolicy, harnesses, signal: controller.signal, onResult: stage });
          if (!completion) await stage(report);
          await runtime.cleanupAttempt(record.runtime.prefix);
          const outcome = await finishCleaned(completion);
          if (outcome === 'settled') log({ event: 'completed', runId: claim.id, epoch: claim.epoch, executor: 'verification' });
          return;
        }
        if (!env.DEEPSEEK_API_KEY) throw new Error('Agent execution requires a configured model key');
        const requestedInput = checkedRunPolicy(claim, project);
        run = await runtime.prepareRun({ project, runId: record.runtime.runId, roleId: claim.role, baseRef: claim.baseRef, owner: { apiUrl, workerId, runId: claim.id, epoch: claim.epoch }, signal: controller.signal });
        const inputCandidate = await runtime.pinInputCandidate(run, requestedInput, { signal: controller.signal });
        await journal.update(record, { phase: 'prepared', inputCandidate, runtime: { ...record.runtime, containerId: run.containerId } });
        controller.signal.throwIfAborted();
        await runtime.installDsh(run);
        await runtime.installPlugin(run, pluginPath);
        const trust = await installSandboxTrust({ runtime, run, caFile: env.CAMP_CONTROL_CA_FILE });
        const sandboxApi = await runtime.sandboxApiUrl(run, apiUrl);
        modelProxy = await createModelProxy({
          apiKey: env.DEEPSEEK_API_KEY, baseUrl: env.DEEPSEEK_BASE_URL, host: await runtime.sandboxHostAddress(run),
          budget: new ModelBudget(limits),
          onBudget: async counters => { try { await journal.update(record, { modelUsage: counters }); } catch (error) { controller.abort(error); throw error; } },
          onLimit: error => controller.abort(error),
        });
        const launch = runtime.launchSpec(run, { env: {
          ...trust,
          DEEPSEEK_API_KEY: modelProxy.token, DEEPSEEK_BASE_URL: modelProxy.baseUrl,
          CAMP_API_URL: sandboxApi, CAMP_ROOM_ID: claim.roomId, CAMP_RUN_ID: claim.id,
          CAMP_RUN_EPOCH: String(claim.epoch), CAMP_WORKER_ID: workerId, CAMP_RUN_TOKEN: claim.runToken,
          CAMP_PROTOCOL_VERSION: String(claim.protocolVersion ?? 1),
          DSH_PERMISSION_MODE: 'danger-full-access',
        } });
        createSession ??= await loadDshRuntimeSession();
        session = createSession({ ...launch, cwd: run.workspacePath, processCwd: process.cwd(), model: env.CAMP_DSH_MODEL ?? 'profile', approvePermissions: true, signal: controller.signal, handshakeTimeoutMs: 30_000 });
        const settled = new Promise((resolveTurn, reject) => {
          finishTurn = resolveTurn;
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
          session.on('runtime_event', event => {
            if (event.kind === 'text') { text = (text + event.text).slice(-200_000); for (const chunk of splitProgress(event.text)) emitProgress(chunk); }
            if (event.kind === 'session_init') sessionId = event.sessionId;
            if (event.kind === 'error') failure = new Error(event.message);
            if (event.kind === 'turn_end' && !controlledYield) { turnFinished = true; promptActive = false; if (failure) reject(failure); else resolveTurn(); }
          });
          session.on('error', error => { if (!sessionStop) reject(error); });
          session.on('exit', () => { if (!sessionStop) reject(new Error('DSH exited before a completed turn')); });
        });
        settled.catch(() => {});
        await journal.update(record, { phase: 'executing' });
        log({ event: 'run_started', runId: claim.id, epoch: claim.epoch, role: claim.role });
        emitProgress(`${claim.role} started in an isolated LayerFS workspace.`);
        const started = await session.start({ text: claim.prompt });
        if (!started.ok) throw new Error(`DSH did not accept the task: ${started.error ?? 'no error detail'}`);
        promptActive = !turnFinished;
        await settled;
        promptActive = false;
        await heartbeatWork;
        await stopSession();
        session = null;
        controller.signal.throwIfAborted();
        await runtime.quiesceAgent(run, { signal: controller.signal });
        await modelProxy.close();
        modelProxy = null;
        const archive = await runtime.archiveSession(run, { signal: controller.signal });
        if (archive) log({ event: 'session_archived', runId: claim.id, status: archive.status, retained: archive.retained, reason: archive.reason });
        lease.assertActive();
        controller.signal.throwIfAborted();
        const endContext = await request(`/runs/${claim.id}/context`);
        const artifact = { ...await runtime.commitCandidate(run, { signal: controller.signal }), runId: claim.id, runtimeRunId: run.runId };
        await journal.update(record, { phase: 'candidate', candidate: artifact });
        const result = completionPolicy(claim, endContext, inputCandidate, artifact);
        await progress;
        controller.signal.throwIfAborted();
        const summary = completionSummary(claim, endContext, text);
        const artifacts = [artifact, ...(endContext.artifacts ?? [])].slice(0, 30);
        const completion = { ...context, ...result, inputCandidate, candidate: artifact, summary, artifacts, ...(sessionId ? { sessionId } : {}) };
        if (claim.protocolVersion >= 2 && claim.taskKind === 'build') {
          const base = parseCandidate(claim.goalBaseline ?? inputCandidate, { projectId: project.projectId, imageId: project.imageId });
          completion.changeSet = await computeChangeSet({ runtime, ownerRun: record.runtime, base, target: artifact, signal: controller.signal });
        }
        await journal.stageCompletion(record, completion);
        log({ event: 'result_staged', runId: claim.id, epoch: claim.epoch });
        await request(`/runs/${claim.id}/events`, { ...context, type: 'artifact', content: 'Saved immutable LayerFS candidate.', artifact });
        await runtime.releaseRun(run);
        run = null;
        const outcome = await finishCleaned(completion);
        if (outcome === 'settled') log({ event: result.status, runId: claim.id, epoch: claim.epoch, role: claim.role, taskKind: claim.taskKind, refKind: artifact.refKind, refId: artifact.refId, ...(artifact.commitId ? { commitId: artifact.commitId } : {}) });
      } catch (error) {
        let cleanupKnown = error.cleanupKnown !== false;
        // ACP transport/process teardown and physical sandbox removal are
        // independent obligations. An unconfirmed client exit must never skip
        // stopping agent background processes in the owned container.
        try {
          await stopSession();
          session = null;
        } catch { cleanupKnown = false; }
        try {
          if (run) await runtime.abortRun(run, lease.state);
          else if (!record.cleanupKnown) await runtime.cleanupAttempt(record.runtime.prefix);
        } catch { cleanupKnown = false; }
        await progress;
        if (record.completion) {
          await journal.update(record, { cleanupKnown, phase: cleanupKnown ? 'completion_pending' : 'result_staged' });
          if (!cleanupKnown) options.onFatal?.(Object.assign(new Error('Attempt cleanup was not confirmed; stop all execution lanes'), { code: 'camp_pool_unsafe', status: 409 }));
          log({ event: 'completion_outcome_unknown', runId: claim.id, epoch: claim.epoch });
        } else {
          const executionPolicyFailure = ['camp_capacity_low', 'camp_capacity_unavailable', 'camp_resource_policy', 'camp_resource_enforcement_failed'].includes(error.code);
          const inspectionRequired = error.requiresInspection === true || error.code === 'camp_integration_inspection_required' || (claim.executor === 'integration' && record.phase === 'integrating');
          if (!cleanupKnown || inspectionRequired) options.onFatal?.(Object.assign(new Error(inspectionRequired ? 'An operation requires inspection; stop all execution lanes' : 'Attempt cleanup was not confirmed; stop all execution lanes'), { code: inspectionRequired ? 'camp_integration_inspection_required' : 'camp_pool_unsafe', status: 409 }));
          const lastErrorCode = inspectionRequired && claim.executor === 'integration' ? 'camp_integration_inspection_required' : stopping ? 'worker_shutdown' : error.code === 'run_budget_exhausted' || executionPolicyFailure ? error.code : error.code === 'camp_api_transport' || (error.status && transient(error)) ? 'worker_interrupted' : claim.executor === 'verification' ? 'verification_execution_failed' : claim.executor === 'integration' ? 'camp_integration_failed' : 'dsh_execution_failed';
          const lastError = String(error.message ?? error).slice(0, 15000);
          const failureCompletion = { ...context, status: 'failed', summary: `Execution stopped: ${lastError}`.slice(0, 15000), error: lastErrorCode, ...(sessionId ? { sessionId } : {}) };
          await journal.update(record, { cleanupKnown, phase: 'interrupted', lastErrorCode, lastError, failureCompletion, ...(inspectionRequired || error.cleanupKnown === false ? { requiresInspection: true } : {}) });
          log({ event: lease.state === 'lost' ? 'lease_lost' : lease.state === 'cancelled' ? 'cancelled' : 'run_interrupted', runId: claim.id, epoch: claim.epoch, cleanupKnown, reason: error.message ?? String(error) });
          if (cleanupKnown && (!record.requiresInspection || (claim.executor === 'integration' && inspectionRequired))) {
            try {
              const state = checkedState(await request(`/runs/${claim.id}/state`), record);
              if (state.leaseValid && !state.replaced && state.run.workerId === record.workerId && state.run.epoch === record.epoch) {
                const payload = state.run.cancelRequested ? { ...context, status: 'cancelled', summary: 'Execution stopped and its sandbox was removed.', ...(claim.executor === 'integration' && inspectionRequired ? { error: 'camp_integration_inspection_required' } : {}) } : failureCompletion;
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
    let recoveryBarrierPassed = false;
    while (!stopping) {
      try {
        if (restoreOnlyRecovery) await restoreWorkerForClaims({ journal, runtime, request, workerToken, log });
        const pendingClaim = await journal.pendingClaim();
        // Resolve an ambiguous claim using its original id before reconciliation;
        // otherwise reconciliation could fail a claim whose response alone was lost.
        if (!pendingClaim || restoreOnlyRecovery) await recoverWorker({ journal, runtime, request, log });
        if (!recoveryBarrierPassed && options.recoveryBarrier) {
          await options.recoveryBarrier({ journal, runtime, workerId });
          recoveryBarrierPassed = true;
        }
        if (stopping) break;
        let negotiated;
        try {
          try { limits = runLimits(env.DEEPSEEK_API_KEY ? env : { CAMP_RUN_TIMEOUT_MS: env.CAMP_RUN_TIMEOUT_MS }); if (!options.runtime) await runtime.ready(); }
          catch (error) { throw protocolFailure(`New execution configuration is invalid: ${error.message}`, 'worker_execution_configuration_required'); }
          runtime.resourcePolicy ??= resourcePolicy(env);
          await admitExecution();
          await checkCapacity();
          negotiated = await negotiateWorker({ request, pluginPath, env, executionPool: options.executionPool });
        }
        catch (error) {
          // A pending intent might already own a run. Read-only state and exact
          // old outboxes remain usable even when new execution is unsupported.
          if (pendingClaim) await recoverWorker({ journal, runtime, request, log });
          throw error;
        }
        if (stopping) break;
        await options.beforeClaim?.({ journal, runtime, workerId });
        if (standalone) await assertNoManagedContainers(runtime);
        if (stopping) break;
        const claimId = pendingClaim ?? await journal.claimIntent();
        const value = await request('/claim', { workerId, claimId, runToken: runTokenForClaim(workerToken, claimId), protocol: negotiated.protocol });
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
          if (stopping) { await recoverWorker({ journal, runtime, request, log }); break; }
          try { assertClaimCompatibility(value, claim, negotiated.protocol); }
          catch (error) {
            await recoverWorker({ journal, runtime, request, log });
            throw protocolFailure(`Claim retained for safe recovery: ${error.message}`, error.code ?? 'protocol_required');
          }
          await options.beforeExecution?.({ claim, record, journal, runtime, workerId });
          await executeRun(claim, record, negotiated.harnesses);
          await options.afterExecution?.({ claim, record, journal, runtime, workerId });
        } else {
          await journal.finishClaim();
          const unmatched = unmatchedTaskKind(value, negotiated.protocol);
          if (value.compatibility?.status === 'incompatible' && !unmatched) throw protocolFailure(`Camp cannot assign compatible work (${value.compatibility.code ?? 'capability_missing'})`, value.compatibility.code ?? 'capability_missing');
          if (unmatched) log({ event: 'worker_waiting_for_task_kind', workerId, requiredTaskKind: value.requirements.taskKind, offeredTaskKinds: negotiated.protocol.taskKinds });
          if (!unmatched && !value.closed && !['compatible', 'legacy'].includes(value.compatibility?.status) && !(value.compatibility === null && value.requirements === null)) throw protocolFailure('Camp claim omitted its compatibility result', 'protocol_required');
          if (!value.closed) await options.onIdle?.({ journal, runtime, workerId });
          if (env.CAMP_WORKER_ONCE === '1' && !value.closed) break;
          await delay(1500);
        }
        backoff = 500;
      } catch (error) {
        if (stopping && error.code === 'camp_pool_stopped') break;
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
    if (hostManager && hostManager !== options.manager) await hostManager.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await managedWorkerCredential().then(credential => startWorker({ env: credential.env, request: credential.request })).catch(error => { console.error(JSON.stringify({ event: 'worker_stopped', reason: error.message })); process.exitCode = 1; });
}
