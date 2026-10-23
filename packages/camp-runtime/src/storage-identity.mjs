import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicJson, privateDirectory } from './durable-state.mjs';
import { regularBytes } from './toolchain.mjs';
import { storageIdentity, managerFailure } from './host-manager.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
async function optional(path) {
  try { return JSON.parse(await regularBytes(path, 65536)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/** Physical identity belongs to the Store deployment, independently of a pool.
 * Existing pool UUIDs seed it without changing an already pinned storage ID. */
export async function openStorageIdentity({ home, dockerId, create = true }) {
  await privateDirectory(home);
  const path = join(home, 'storage-identity.json');
  const current = await optional(path), pool = await optional(join(home, 'execution-pool.json'));
  const storeId = current?.storeId ?? pool?.storeId;
  if (storeId && !uuid.test(storeId)) throw managerFailure('Physical storage identity is invalid', 'camp_storage_identity');
  if (current && (current.schemaVersion !== 1 || current.dockerId !== dockerId || current.storageId !== storageIdentity(storeId, dockerId))) throw managerFailure('Physical storage belongs to another Docker host', 'camp_storage_identity');
  if (pool && (pool.storeId !== storeId || pool.storageId !== storageIdentity(storeId, dockerId))) throw managerFailure('Pool and physical storage identities differ', 'camp_storage_identity');
  if (current) return current;
  if (!create && !storeId) return null;
  const selected = storeId ?? randomUUID();
  const value = { schemaVersion: 1, storeId: selected, dockerId, storageId: storageIdentity(selected, dockerId) };
  if (create) await atomicJson(path, value);
  return value;
}
