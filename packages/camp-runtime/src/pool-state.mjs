import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { atomicJson, privateDirectory, WorkerJournal, stateKey } from './durable-state.mjs';
import { managerFailure, storageIdentity } from './host-manager.mjs';
import { parseExecutionPool } from '../../camp-protocol/src/index.js';

async function readPrivate(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 65536) throw managerFailure('Pool metadata is not a private bounded regular file');
    return JSON.parse(await file.readFile('utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await file?.close(); }
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function loadPoolState({ home, apiUrl, baseWorkerId, dockerId }) {
  await privateDirectory(home);
  const existing = await readPrivate(join(home, 'execution-pool.json'));
  if (existing) {
    const expected = storageIdentity(existing.storeId, dockerId);
    if (existing.schemaVersion !== 1 || existing.apiUrl !== apiUrl || existing.baseWorkerId !== baseWorkerId || existing.storageId !== expected || !/^[a-f0-9]{64}$/.test(existing.configurationDigest ?? '') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(existing.storeId ?? '') || !Array.isArray(existing.workerIds) || existing.workerIds.length !== 2 || existing.workerIds.some((id, index) => id !== `camp-pool-${existing.poolId}-lane-${index + 1}`)) throw managerFailure('Pool identity or Docker host changed; inspect existing state before replacing it', 'camp_pool_identity');
    parseExecutionPool({ poolId: existing.poolId, storageId: existing.storageId, maxParallel: 2, workerIds: existing.workerIds, resources: existing.resources });
  }
  return existing;
}
export function assertPoolConfiguration(metadata, { resources, policy }) {
  if (Object.keys(resources).some(key => metadata.resources[key] !== resources[key]) || metadata.configurationDigest !== digest({ resources, policy })) throw managerFailure('Pool resource configuration changed; old results were recovered but new execution requires the original configuration', 'camp_pool_identity');
}
export async function openPoolState({ home, apiUrl, baseWorkerId, dockerId, resources, policy }) {
  const existing = await loadPoolState({ home, apiUrl, baseWorkerId, dockerId });
  if (existing) { assertPoolConfiguration(existing, { resources, policy }); return existing; }
  const poolId = randomUUID(), storeId = randomUUID();
  const value = { schemaVersion: 1, poolId, storeId, storageId: storageIdentity(storeId, dockerId), apiUrl, baseWorkerId, workerIds: [1, 2].map(index => `camp-pool-${poolId}-lane-${index}`), configurationDigest: digest({ resources, policy }), resources };
  // A bad resource declaration must never poison durable identity before its
  // first negotiation. Existing identities are only read during recovery.
  parseExecutionPool({ poolId, storageId: value.storageId, maxParallel: 2, workerIds: value.workerIds, resources });
  await atomicJson(join(home, 'execution-pool.json'), value);
  return value;
}
/** Reject another pending authority rather than silently reaping a different
 * worker's journal. Old settled journals remain audit records. */
export async function checkPoolJournals({ home, apiUrl, workerIds }) {
  const root = join(home, 'workers');
  await privateDirectory(root);
  const known = new Set(workerIds.map(id => stateKey(`${apiUrl.replace(/\/$/, '')}\n${id}`)));
  for (const folder of await readdir(root)) {
    if (known.has(folder)) continue;
    if (!/^[a-f0-9]{32}$/.test(folder)) throw managerFailure('Unrecognized worker state exists in this runtime home');
    await privateDirectory(join(root, folder));
    const metadata = await readPrivate(join(root, folder, 'worker.json'));
    if (!metadata || metadata.version !== 1 || typeof metadata.workerId !== 'string' || typeof metadata.apiUrl !== 'string' || stateKey(`${metadata.apiUrl}\n${metadata.workerId}`) !== folder) throw managerFailure('Foreign worker metadata cannot be verified');
    const journal = await new WorkerJournal({ home, apiUrl: metadata.apiUrl, workerId: metadata.workerId }).ready();
    const records = await journal.list();
    if (metadata.pendingClaim || records.some(record => record.requiresInspection || !record.cleanupKnown || !['settled', 'fenced'].includes(record.phase) || (record.phase === 'fenced' && !record.cleanupAck?.acknowledgedAt))) throw managerFailure('Another pending or unsafe worker journal exists; pool recovery has no authority over it', 'camp_pool_foreign_state');
  }
}
