import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkerJournal, acquireWorkerLock, stateKey } from './durable-state.mjs';

const fail = () => Object.assign(new Error('Offline recovery requires a private existing journal with this exact worker, API and attempt identity'), { code: 'camp_reap_identity' });
async function privateExisting(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || await realpath(path) !== resolve(path)) throw fail();
}
function optionsIdentity({ runtime, apiUrl, workerId }) {
  if (typeof workerId !== 'string' || !workerId.trim() || workerId.length > 200) throw fail();
  const url = new URL(apiUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail();
  const api = apiUrl.replace(/\/$/, '');
  return { home: resolve(runtime.home), apiUrl: api, workerId };
}
async function existingJournal(options) {
  const identity = optionsIdentity(options);
  await privateExisting(identity.home);
  const folder = join(identity.home, 'workers', stateKey(`${identity.apiUrl}\n${identity.workerId}`));
  try { await privateExisting(folder); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const file = await open(join(folder, 'worker.json'), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536 || stat.uid !== process.getuid() || stat.mode & 0o077) throw fail();
    const metadata = JSON.parse(await file.readFile('utf8'));
    if (metadata.version !== 1 || metadata.apiUrl !== identity.apiUrl || metadata.workerId !== identity.workerId) throw fail();
  } finally { await file.close(); }
  await privateExisting(join(folder, 'attempts'));
  return new WorkerJournal(identity);
}
function attemptIdentity(runtime, record) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.runId) || !Number.isSafeInteger(record.epoch) || record.epoch < 1) throw fail();
  const identity = runtime.runIdentity(`${record.runId}-e${record.epoch}`);
  if (!/^camp-mvp-run-[a-f0-9]{16}-$/.test(identity.prefix) || record.runtime && ['runId', 'prefix', 'folder'].some(key => record.runtime[key] !== identity[key])) throw fail();
  return identity;
}
async function containers(runtime) {
  const answer = await runtime.dockerCall(['ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}}', '--filter', 'name=^/camp-mvp-run-'], { timeout: 10000 });
  return answer.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [id, name, extra] = line.split(' ');
    if (!/^[a-f0-9]{64}$/.test(id) || !/^camp-mvp-run-[a-f0-9]{16}-/.test(name ?? '') || extra !== undefined) throw fail();
    return { id, name };
  });
}

/** Dry-run is read-only. Apply holds the same kernel lock as the worker and
 * re-reads the journal under it. No API calls, result settlement, Store deletion
 * or inference from a server lease clock is permitted in this operation. */
export async function reapWorker({ runtime, apiUrl, workerId, apply = false, lockRoot }) {
  optionsIdentity({ runtime, apiUrl, workerId });
  const lock = apply ? await acquireWorkerLock(workerId, lockRoot ? { root: lockRoot } : {}) : null;
  try {
    const journal = await existingJournal({ runtime, apiUrl, workerId });
    const records = journal ? await journal.list() : [];
    const known = records.map(record => ({ record, identity: attemptIdentity(runtime, record) }));
    const observed = await containers(runtime);
    const result = { schemaVersion: 1, operation: 'offline_reap', applied: apply, workerId, requiresStoppedWorker: true, apiContacted: false, attempts: [], unownedContainers: [] };
    const prefixes = new Set(known.map(item => item.identity.prefix));
    result.unownedContainers = observed.filter(container => ![...prefixes].some(prefix => container.name.startsWith(prefix)));
    for (const { record, identity } of known) {
      const matching = observed.filter(container => container.name.startsWith(identity.prefix));
      const action = record.phase === 'ownership_conflict' ? 'ownership_conflict' : record.requiresInspection ? 'requires_inspection' : record.cleanupKnown ? matching.length ? 'unexpected_resources' : 'already_clean' : 'eligible';
      const item = { runId: record.runId, epoch: record.epoch, phase: record.phase, action, containers: matching, cleaned: false, serverAcknowledged: Boolean(record.cleanupAck?.acknowledgedAt) };
      result.attempts.push(item);
      if (!apply || action !== 'eligible') continue;
      await runtime.cleanupAttempt(identity.prefix);
      // Retain both successful and cancellation outboxes byte-for-byte. Server
      // confirmation remains pending until ordinary authenticated recovery.
      await journal.update(record, { cleanupKnown: true, phase: ['fenced', 'settled'].includes(record.phase) ? record.phase : record.completion ? 'completion_pending' : 'interrupted', offlineCleanup: { cleanedAt: new Date().toISOString(), serverAcknowledged: false }, runtime: { ...record.runtime, ...identity } });
      item.cleaned = true;
    }
    return result;
  } finally { await lock?.release(); }
}
