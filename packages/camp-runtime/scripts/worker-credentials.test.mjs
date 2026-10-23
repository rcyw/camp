import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, chmod, symlink, link, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedWorkerCredential, readWorkerCredential } from '../src/worker-credentials.mjs';
import { runTokenForClaim } from '../src/durable-state.mjs';

const day = 86400_000;
async function fixture(age = 2 * day) {
  const home = await mkdtemp(join(tmpdir(), 'camp-credential-')), path = join(home, 'worker.json'), now = Date.now();
  const value = { schemaVersion: 1, token: `camp_worker_${randomBytes(32).toString('base64url')}`, tokenId: randomUUID(), roomId: randomUUID(), expiresAt: new Date(now + 7 * day - age).toISOString(), renewUntil: new Date(now + 90 * day - age).toISOString() };
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return { home, path, now, value, env: { CAMP_API_URL: 'https://camp.example.test', CAMP_WORKER_CREDENTIAL_FILE: path }, close: () => rm(home, { recursive: true, force: true }) };
}

test('private credentials reject links, public modes, malformed values and ambiguous environment configuration', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await readWorkerCredential(f.path), f.value);
    await chmod(f.path, 0o644); await assert.rejects(readWorkerCredential(f.path), { code: 'camp_credential_invalid' }); await chmod(f.path, 0o600);
    const linkedPath = join(f.home, 'linked'); await symlink(f.path, linkedPath); await assert.rejects(readWorkerCredential(linkedPath), { code: 'camp_credential_invalid' });
    const alias = join(f.home, 'hardlink'); await link(f.path, alias); await assert.rejects(readWorkerCredential(f.path), { code: 'camp_credential_invalid' }); await unlink(alias);
    await assert.rejects(managedWorkerCredential({ env: { ...f.env, CAMP_WORKER_TOKEN: f.value.token } }), { code: 'camp_credential_invalid' });
    await assert.rejects(managedWorkerCredential({ env: { ...f.env, CAMP_WORKER_ROOM_ID: randomUUID() } }), { code: 'camp_credential_invalid' });
    await assert.rejects(managedWorkerCredential({ env: { CAMP_API_URL: f.env.CAMP_API_URL, CAMP_WORKER_TOKEN: f.value.token, CAMP_WORKER_ROOM_ID: f.value.roomId } }), { code: 'camp_credential_invalid' });
    await assert.rejects(managedWorkerCredential({ env: { ...f.env, CAMP_API_URL: 'http://remote.example.test' } }), { code: 'camp_credential_invalid' });
    await writeFile(f.path, JSON.stringify({ ...f.value, token: 'invalid' })); await assert.rejects(readWorkerCredential(f.path), { code: 'camp_credential_invalid' });
    await writeFile(f.path, JSON.stringify({ ...f.value, expiresAt: new Date(f.now + 100 * day).toISOString() })); await assert.rejects(readWorkerCredential(f.path), { code: 'camp_credential_invalid' });
  } finally { await f.close(); }
});

test('simultaneous lanes share renewal, durably persist metadata and keep pending claim credentials stable', async () => {
  const f = await fixture(); let renewals = 0, published = false;
  try {
    const next = { ...f.value, expiresAt: new Date(f.now + 7 * day).toISOString() }; delete next.token;
    const { env, request } = await managedWorkerCredential({ env: { ...f.env, CAMP_WORKER_ROOM_ID: f.value.roomId }, now: () => f.now, request: async route => {
      if (route === '/credential/renew') { renewals++; await new Promise(resolve => setImmediate(resolve)); return next; }
      published = JSON.parse(await readFile(f.path, 'utf8')).expiresAt === next.expiresAt; return { ready: true };
    } });
    const claimId = randomUUID(); assert.equal(runTokenForClaim(env.CAMP_WORKER_TOKEN, claimId), runTokenForClaim(f.value.token, claimId));
    await Promise.all([request('/protocol'), request('/setup'), request('/claim', {})]);
    assert.equal(renewals, 1); assert.equal(published, true); assert.deepEqual(await readWorkerCredential(f.path), { ...next, token: f.value.token });
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
    await request('/protocol'); assert.equal(renewals, 1);
  } finally { await f.close(); }
});

test('a lost renewal response retries the identical secret even when persisted expiry is stale', async () => {
  const f = await fixture(8 * day); let attempts = 0;
  try {
    const requestApi = async route => {
      if (route !== '/credential/renew') return {};
      if (++attempts === 1) throw Object.assign(new Error('transport unavailable'), { code: 'camp_api_transport' });
      return { ...f.value, expiresAt: new Date(f.now + 7 * day).toISOString() };
    };
    const first = await managedWorkerCredential({ env: f.env, now: () => f.now, request: requestApi });
    await assert.rejects(first.request('/setup'), { code: 'camp_api_transport' });
    assert.deepEqual(await readWorkerCredential(f.path), f.value);
    const restarted = await managedWorkerCredential({ env: f.env, now: () => f.now, request: requestApi });
    await restarted.request('/setup'); assert.equal(attempts, 2);
    assert.equal(restarted.env.CAMP_WORKER_TOKEN, f.value.token);
  } finally { await f.close(); }
});

test('revocation, expiry and a disk publication failure admit no ordinary API request', async () => {
  for (const failure of ['revoked', 'expired', 'storage', 'foreign']) {
    const f = await fixture(); let ordinary = 0;
    try {
      const managed = await managedWorkerCredential({ env: f.env, now: () => f.now,
        persist: async () => { if (failure === 'storage') throw new Error('disk full'); },
        request: async route => {
          if (route !== '/credential/renew') { ordinary++; return {}; }
          if (['revoked', 'expired'].includes(failure)) throw Object.assign(new Error('rejected'), { status: 401, code: 'camp_auth_required' });
          return { ...f.value, tokenId: failure === 'foreign' ? randomUUID() : f.value.tokenId, expiresAt: new Date(f.now + 7 * day).toISOString() };
        } });
      await assert.rejects(managed.request('/claim', {}), failure === 'storage' ? { code: 'camp_credential_storage', status: 409 } : failure === 'foreign' ? { code: 'camp_credential_invalid', status: 409 } : { status: 401 });
      assert.equal(ordinary, 0); assert.deepEqual(await readWorkerCredential(f.path), f.value);
    } finally { await f.close(); }
  }
});

test('legacy token environments retain their existing API and request identity', async () => {
  const env = { CAMP_WORKER_TOKEN: 'fixture-token' }, request = async () => ({});
  const selected = await managedWorkerCredential({ env, request });
  assert.equal(selected.env, env); assert.equal(selected.request, request);
});
