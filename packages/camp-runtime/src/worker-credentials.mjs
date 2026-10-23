import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { atomicJson, privateDirectory } from './durable-state.mjs';
import { workerApiRequest, workerApiUrl } from './worker-preflight.mjs';

const renewalIntervalMs = 86400_000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// The existing Worker retries transport errors without status. Local credential
// corruption and failed durable publication require inspection and must drain
// both lanes instead of being mistaken for a temporary network interruption.
const fail = (code = 'camp_credential_invalid') => Object.assign(new Error('The private Worker credential file is unavailable or invalid; inspect its ownership, renewal policy and Room binding'), { code, status: 409 });

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
    for (let directory = dirname(path);;) {
      const stat = await lstat(directory), parent = dirname(directory);
      const stickyTemporary = directory === '/tmp' && stat.uid === 0 && !!(stat.mode & 0o1000);
      if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.getuid()].includes(stat.uid) || !stickyTemporary && stat.mode & 0o022) throw fail();
      if (parent === directory) break;
      directory = parent;
    }
    await privateDirectory(dirname(path));
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 || stat.size > 16384) throw fail();
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const part = await file.read(bytes, length, bytes.length - length); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length !== stat.size) throw fail();
    const value = JSON.parse(bytes.subarray(0, length).toString('utf8'));
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
export async function managedWorkerCredential({ env = process.env, request, now = () => performance.now(), wallNow = Date.now, persist = atomicJson } = {}) {
  const path = env.CAMP_WORKER_CREDENTIAL_FILE;
  if (!path) {
    if (env.CAMP_WORKER_ROOM_ID !== undefined) throw fail();
    return { env, request: request ?? workerApiRequest(env), wrapRequest: transport => transport };
  }
  if (env.CAMP_WORKER_TOKEN) throw fail();
  const url = new URL(workerApiUrl(env));
  if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw fail();
  let credential = await readWorkerCredential(path), renewal, authenticated = false, renewedAt, renewedAtWall;
  if (env.CAMP_WORKER_ROOM_ID !== undefined && (!uuid.test(env.CAMP_WORKER_ROOM_ID) || credential.roomId !== env.CAMP_WORKER_ROOM_ID)) throw fail();
  const selectedEnv = { ...env, CAMP_API_URL: workerApiUrl(env), CAMP_WORKER_TOKEN: credential.token };
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
    authenticated = true;
    renewedAt = now();
    renewedAtWall = wallNow();
  };
  const ensureAuthenticated = async () => {
    // The JSON is operator metadata, not proof of the token's Room. Bind it
    // against an authenticated server response before any recovery or claim,
    // including when a newly issued local lease still has its full seven days.
    // A lease capped by renewUntil cannot extend further. Renewing on every
    // request in its last six days would serialize all heartbeats and fsyncs.
    // The monotonic cadence survives wall-clock corrections; elapsed wall time
    // also catches a host suspension while its monotonic clock was paused. Server
    // authentication still rejects an expired/revoked lease on every request.
    const clock = now();
    if (!authenticated || clock < renewedAt || clock - renewedAt >= renewalIntervalMs || wallNow() - renewedAtWall >= renewalIntervalMs) {
      renewal ??= renew().finally(() => { renewal = null; });
      await renewal;
    }
  };
  const wrapRequest = transport => async (...args) => { await ensureAuthenticated(); return transport(...args); };
  return { env: selectedEnv, request: wrapRequest(api), wrapRequest };
}
