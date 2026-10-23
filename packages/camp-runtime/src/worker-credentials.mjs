import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { atomicJson, privateDirectory } from './durable-state.mjs';
import { workerApiRequest, workerApiUrl } from './worker-preflight.mjs';

const renewalWindowMs = 6 * 86400_000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (code = 'camp_credential_invalid') => Object.assign(new Error('The private Worker credential file is unavailable or invalid; inspect its ownership, renewal policy and Room binding'), { code });

function metadata(value) {
  if (!value || value.schemaVersion !== 1 || !uuid.test(value.tokenId) || !uuid.test(value.roomId)
    || typeof value.expiresAt !== 'string' || typeof value.renewUntil !== 'string'
    || !Number.isFinite(Date.parse(value.expiresAt)) || !Number.isFinite(Date.parse(value.renewUntil))
    || Date.parse(value.expiresAt) > Date.parse(value.renewUntil)) throw fail();
  return { schemaVersion: 1, tokenId: value.tokenId, roomId: value.roomId, expiresAt: value.expiresAt, renewUntil: value.renewUntil };
}

export async function readWorkerCredential(path) {
  let file;
  try {
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw fail();
    await privateDirectory(dirname(path));
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) throw fail();
    const value = JSON.parse(await file.readFile('utf8'));
    if (!/^camp_worker_[A-Za-z0-9_-]{43}$/.test(value?.token)) throw fail();
    return { ...metadata(value), token: value.token };
  } catch { throw fail(); }
  finally { await file?.close(); }
}

/** The secret remains stable across lease renewals so an ambiguous allocation
 * retains exactly the same derived Run credential after restart. No timer is
 * needed: idle polling and active heartbeats both cross this shared boundary.
 * The server owns expiry and the absolute renewal deadline; a stale disk expiry
 * must still be retried because an earlier response could have been lost. */
export async function managedWorkerCredential({ env = process.env, request, now = Date.now, persist = atomicJson } = {}) {
  const path = env.CAMP_WORKER_CREDENTIAL_FILE;
  if (!path) return { env, request: request ?? workerApiRequest(env) };
  if (env.CAMP_WORKER_TOKEN) throw fail();
  const url = new URL(workerApiUrl(env));
  if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw fail();
  let credential = await readWorkerCredential(path), renewal;
  const selectedEnv = { ...env, CAMP_WORKER_TOKEN: credential.token };
  const api = request ?? workerApiRequest(selectedEnv);
  const renew = async () => {
    const next = metadata(await api('/credential/renew', {}));
    if (next.tokenId !== credential.tokenId || next.roomId !== credential.roomId || next.renewUntil !== credential.renewUntil) throw fail();
    const updated = { ...next, token: credential.token };
    // Publish and fsync before admitting another request. A storage failure
    // drains the pool; a process restart can retry the still-identical secret.
    try { await persist(path, updated); }
    catch { throw fail('camp_credential_storage'); }
    credential = updated;
  };
  return { env: selectedEnv, request: async (route, body) => {
    if (Date.parse(credential.expiresAt) - now() <= renewalWindowMs) {
      renewal ??= renew().finally(() => { renewal = null; });
      await renewal;
    }
    return api(route, body);
  } };
}
