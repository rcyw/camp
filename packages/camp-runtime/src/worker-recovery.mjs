import { createHash } from 'node:crypto';
import { settleCompletion } from './worker-core.mjs';
import { integrationCompletion } from './integration-completion.mjs';
import { recoverTrustedIntegration } from './integration.mjs';

export const terminalPhases = new Set(['settled', 'fenced']);
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'suspended']);
export function checkedState(value, record) {
  const run = value?.run;
  if (!run || run.id !== record.runId || typeof run.workerId !== 'string' || !Number.isSafeInteger(run.epoch) || typeof value.leaseValid !== 'boolean' || typeof value.replaced !== 'boolean' || !['running', ...terminalStatuses].includes(run.status)) throw new Error('Invalid Camp recovery state; no cleanup or completion is authorized');
  return value;
}

export async function dispatchOutbox({ journal, record, request, state, log = () => {}, field = record.cancellationAck ? 'cancellationAck' : 'completion' }) {
  const completion = record[field];
  if (!completion) throw new Error('No prepared completion exists');
  if (!record.cleanupKnown) throw new Error('Resource cleanup must be confirmed before outbox dispatch');
  if (completion.payload.workerId !== record.workerId || completion.payload.epoch !== record.epoch || createHash('sha256').update(JSON.stringify(completion.payload)).digest('hex') !== completion.digest) throw new Error('Completion outbox identity or digest is invalid');
  checkedState(state, record);
  const original = state.run.workerId === record.workerId && state.run.epoch === record.epoch;
  if (field === 'completion' && completion.payload.status !== 'cancelled' && original && !state.replaced && state.leaseValid && state.run.status === 'running' && state.run.cancelRequested) {
    // A separate immutable message confirms cleanup; never rewrite the staged result.
    await journal.prepareCancellation(record);
    log({ event: 'cancellation_prepared', runId: record.runId, epoch: record.epoch });
    return dispatchOutbox({ journal, record, request, state, log, field: 'cancellationAck' });
  }
  const terminalReplay = terminalStatuses.has(state.run.status) && state.run.status === completion.payload.status;
  if (!original || state.replaced || (!state.leaseValid && !terminalReplay) || (state.run.status === 'running' && state.run.cancelRequested && completion.payload.status !== 'cancelled')) {
    await journal.update(record, { phase: 'fenced', fencedReason: 'Original completion is no longer authorized', ...(field === 'cancellationAck' ? { cancellationAck: { ...record.cancellationAck, fencedAt: new Date().toISOString() } } : {}) });
    log({ event: 'completion_fenced', runId: record.runId, epoch: record.epoch });
    return 'fenced';
  }
  try {
    const result = await settleCompletion(async () => {
      await journal.update(record, current => ({ [field]: { ...current[field], attempts: current[field].attempts + 1 } }));
      log({ event: 'completion_sending', runId: record.runId, epoch: record.epoch });
      return request(`/runs/${record.runId}/complete`, completion.payload);
    });
    await journal.update(record, { phase: 'settled', settledAt: new Date().toISOString(), settlementStatus: completion.payload.status, replayed: Boolean(result.replayed), [field]: { ...record[field], acknowledgedAt: new Date().toISOString() } });
    log({ event: 'completion_acknowledged', runId: record.runId, epoch: record.epoch, replayed: Boolean(result.replayed) });
    return field === 'cancellationAck' ? 'cancelled' : 'settled';
  } catch (error) {
    if ([400, 409, 422].includes(error.status)) {
      await journal.update(record, { phase: 'fenced', fencedReason: `Server rejected original completion (${error.status})`, ...(field === 'cancellationAck' ? { cancellationAck: { ...record.cancellationAck, fencedAt: new Date().toISOString() } } : {}) });
      log({ event: 'completion_fenced', runId: record.runId, epoch: record.epoch, status: error.status });
      return 'fenced';
    }
    log({ event: 'completion_outcome_unknown', runId: record.runId, epoch: record.epoch });
    throw error;
  }
}

/** A cleanup receipt never alters an expired run's result or renews its lease. */
export async function acknowledgeCleanup({ journal, record, request, state, log = () => {} }) {
  if (!record.cleanupKnown || state.run.workerId !== record.workerId || state.run.epoch !== record.epoch) throw new Error('Cleanup acknowledgement requires this original attempt and confirmed resource removal');
  const eligible = state.run.status !== 'running' || !state.leaseValid || state.run.cancelRequested;
  if (!eligible) return;
  const serverConfirmed = (state.cleanupState ?? state.run.cleanupState) === 'confirmed';
  if (record.cleanupAck?.acknowledgedAt || serverConfirmed) {
    if (!record.cleanupAck?.acknowledgedAt) await journal.update(record, { cleanupAck: { payload: { workerId: record.workerId, epoch: record.epoch }, ...record.cleanupAck, acknowledgedAt: new Date().toISOString() } });
    return;
  }
  const payload = { workerId: record.workerId, epoch: record.epoch };
  if (!record.cleanupAck) await journal.update(record, { cleanupAck: { payload, preparedAt: new Date().toISOString() } });
  await settleCompletion(() => request(`/runs/${record.runId}/cleanup`, record.cleanupAck.payload));
  await journal.update(record, { cleanupAck: { ...record.cleanupAck, acknowledgedAt: new Date().toISOString() } });
  log({ event: 'cleanup_acknowledged', runId: record.runId, epoch: record.epoch });
}

/** Only this worker's recorded attempts are eligible; active foreign owners survive. */
export async function recoverWorker({ journal, runtime, request, log = () => {}, inspectIntegration = recoverTrustedIntegration }) {
  const snapshot = await request(`/reconcile?workerId=${encodeURIComponent(journal.workerId)}`);
  if (!Array.isArray(snapshot.runs)) throw new Error('Camp reconcile returned invalid state');
  let records = await journal.list();
  for (const state of snapshot.runs) {
    const run = state.run;
    if (!run || run.workerId !== journal.workerId || records.some(record => record.runId === run.id && record.epoch === run.epoch) || run.status !== 'running') continue;
    // Includes a claim whose response arrived after the worker disappeared.
    const record = await journal.recordClaim({ ...run, role: run.role ?? 'unknown' }, { runtime: runtime.runIdentity(`${run.id}-e${run.epoch}`) });
    records.push(record);
  }
  for (const record of records) {
    const pendingCancellation = record.cancellationAck && !record.cancellationAck.acknowledgedAt && !record.cancellationAck.fencedAt;
    if (record.requiresInspection) {
      // Native uncertainty blocks mutation and new claims, not an identical
      // failed/cancelled message which was safely recorded after physical
      // cleanup. Its HTTP response can be lost just like any other outbox.
      const failed = record.cancellationAck ?? record.completion;
      const recoverableFailure = failed?.payload ?? record.failureCompletion;
      if (record.executor === 'integration' && record.cleanupKnown && recoverableFailure && ['failed', 'cancelled'].includes(recoverableFailure.status)) {
        const state = checkedState(await request(`/runs/${record.runId}/state`), record);
        const identity = runtime.runIdentity(`${record.runId}-e${record.epoch}`);
        if (state.run.workerId !== record.workerId || state.run.epoch !== record.epoch || !record.runtime || record.runtime.prefix !== identity.prefix || record.runtime.runId !== identity.runId) throw new Error('Inspected integration failure differs from its original owner');
        await acknowledgeCleanup({ journal, record, request, state, log });
        if (!failed) await journal.prepareCompletion(record, recoverableFailure);
        if (record.phase !== 'settled') await dispatchOutbox({ journal, record, request, state, log });
      }
      throw Object.assign(new Error('An uncertain LayerFS operation requires inspection before recovery'), { code: record.executor === 'integration' ? 'camp_integration_inspection_required' : 'camp_inspection_required', status: 409 });
    }
    // A fenced result says nothing about the server's cleanup projection. A
    // live execution may have cleaned just as its lease expired; retain one
    // recovery inspection until its original resources are acknowledged.
    if (terminalPhases.has(record.phase) && record.cleanupKnown && !pendingCancellation && (record.phase === 'settled' || record.cleanupAck?.acknowledgedAt)) continue;
    const state = checkedState(await request(`/runs/${record.runId}/state`), record);
    if (state.run.workerId !== record.workerId || state.run.epoch !== record.epoch) {
      // Never turn a mismatched server identity into permission to kill it.
      await journal.update(record, { phase: 'ownership_conflict' });
      log({ event: 'recovery_foreign_owner', runId: record.runId });
      continue;
    }
    const identity = runtime.runIdentity(`${record.runId}-e${record.epoch}`);
    if (record.runtime && (record.runtime.prefix !== identity.prefix || record.runtime.runId !== identity.runId)) throw new Error('Journal runtime identity does not match its fenced attempt');
    let integrationInspection = record.executor === 'integration' && !record.completion && !record.integrationInput;
    if (record.executor === 'integration' && !record.completion && record.integrationInput) {
      try {
        const recovered = await inspectIntegration({ runtime, ownerRun: identity, integrationInput: record.integrationInput });
        if (recovered.status === 'validated') {
          // Derived Diff and raw result were committed together before staging
          // the outbox. Recover only that complete original payload; never
          // perform another merge or fabricate missing verification evidence.
          if (!record.integrationReport || JSON.stringify(record.integrationReport) !== JSON.stringify(recovered.report)) integrationInspection = true;
          else await journal.stageCompletion(record, integrationCompletion(record));
        } else if (recovered.status === 'requires_inspection' || (recovered.status === 'missing' && record.phase === 'integrating')) integrationInspection = true;
      } catch { integrationInspection = true; }
    }
    if (!record.cleanupKnown) {
      await runtime.cleanupAttempt(identity.prefix);
      await journal.update(record, { cleanupKnown: true, phase: record.completion ? 'completion_pending' : 'interrupted', runtime: identity });
      log({ event: 'recovery_cleanup_confirmed', runId: record.runId, epoch: record.epoch });
    }
    await acknowledgeCleanup({ journal, record, request, state, log });
    if (integrationInspection) {
      const failureCompletion = { workerId: record.workerId, epoch: record.epoch, status: 'failed', summary: 'Integration was interrupted before a complete validated result was staged; inspect the retained native operation before continuing.', error: 'camp_integration_inspection_required' };
      await journal.update(record, { requiresInspection: true, lastErrorCode: failureCompletion.error, failureCompletion });
      if (state.leaseValid && !state.replaced && state.run.status === 'running') {
        await journal.prepareCompletion(record, failureCompletion);
        await dispatchOutbox({ journal, record, request, state, log });
      }
      throw Object.assign(new Error('An uncertain integration requires inspection; no merge was retried'), { code: 'camp_integration_inspection_required', status: 409 });
    }
    if (record.phase === 'fenced') continue;
    if (record.cancellationAck || record.completion) {
      await dispatchOutbox({ journal, record, request, state, log });
    } else if (state.leaseValid && !state.replaced && state.run.status === 'running') {
      const cancelled = state.run.cancelRequested === true;
      const payload = cancelled
        ? { workerId: record.workerId, epoch: record.epoch, status: 'cancelled', summary: 'Execution stopped and its sandbox was removed.' }
        : record.failureCompletion ?? { workerId: record.workerId, epoch: record.epoch, status: 'failed', summary: 'Worker restarted; interrupted execution was stopped and its sandbox was removed.', error: 'worker_interrupted' };
      await journal.prepareCompletion(record, payload);
      log({ event: 'completion_prepared', runId: record.runId, epoch: record.epoch });
      await dispatchOutbox({ journal, record, request, state, log });
    } else {
      await journal.update(record, { phase: 'fenced', fencedReason: 'Interrupted attempt is expired, replaced or already terminal' });
      log({ event: 'recovery_fenced', runId: record.runId, epoch: record.epoch });
    }
  }
}
