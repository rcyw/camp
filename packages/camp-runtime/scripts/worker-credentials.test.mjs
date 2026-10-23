import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, symlink, link, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { managedWorkerCredential, readWorkerCredential } from '../src/worker-credentials.mjs';
import { runTokenForClaim } from '../src/durable-state.mjs';

const day = 86400_000;
const execute = promisify(execFile);
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

test('a fresh lease verifies the actual bearer Room before recovery instead of trusting editable JSON metadata', async () => {
  const f = await fixture(0); let ordinary = 0;
  try {
    const managed = await managedWorkerCredential({ env: { ...f.env, CAMP_WORKER_ROOM_ID: f.value.roomId }, request: async route => {
      if (route === '/credential/renew') return { ...f.value, roomId: randomUUID() };
      ordinary++; return {};
    } });
    await assert.rejects(managed.request('/claim', {}), { code: 'camp_credential_invalid', status: 409 });
    assert.equal(ordinary, 0, 'Pasting a foreign bearer into an otherwise matching Room file cannot rebind the Store');
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

test('a FIFO credential fails promptly instead of hanging startup before the host manager lock', async () => {
  const f = await fixture();
  try {
    await unlink(f.path); await execute('mkfifo', ['-m', '600', f.path]);
    const source = new URL('../src/worker-credentials.mjs', import.meta.url).href;
    const script = `import {readWorkerCredential} from ${JSON.stringify(source)};try{await readWorkerCredential(process.argv[1]);process.exitCode=1}catch(e){console.log(e.code)}`;
    const result = await execute(process.execPath, ['--input-type=module', '-e', script, f.path], { timeout: 2000 });
    assert.equal(result.stdout.trim(), 'camp_credential_invalid');
  } finally { await f.close(); }
});

test('an apparently private credential below a writable ancestor is rejected before authentication', async () => {
  const f = await fixture();
  try {
    const privateHome = join(f.home, 'private'), path = join(privateHome, 'worker.json');
    await mkdir(privateHome, { mode: 0o700 }); await writeFile(path, JSON.stringify(f.value), { mode: 0o600 });
    await chmod(f.home, 0o777);
    await assert.rejects(managedWorkerCredential({ env: { ...f.env, CAMP_WORKER_CREDENTIAL_FILE: path } }), { code: 'camp_credential_invalid' });
    await chmod(f.home, 0o700); assert.deepEqual(await readWorkerCredential(path), f.value);
  } finally { await f.close(); }
});

test('capped leases renew once daily across lanes and transfers without a last-week renewal/fsync storm', async () => {
  const f = await fixture(); let clock = 0, renewals = 0, writes = 0, calls = 0;
  try {
    const capped = { ...f.value, expiresAt: new Date(f.now + 2 * day).toISOString(), renewUntil: new Date(f.now + 2 * day).toISOString() };
    await writeFile(f.path, JSON.stringify(capped));
    const managed = await managedWorkerCredential({ env: f.env, now: () => clock, persist: async () => { writes++; }, request: async route => {
      if (route === '/credential/renew') { renewals++; return capped; }
      calls++; return {};
    } });
    const binary = Buffer.from('private artifact fixture'), options = { method: 'PUT', body: binary, binary: false };
    const transfer = managed.wrapRequest(async (route, supplied) => { assert.equal(route, '/artifact-part'); assert.equal(supplied, options); calls++; });
    await managed.request('/setup');
    for (let i = 0; i < 30; i++) await Promise.all([managed.request('/heartbeat', {}), transfer('/artifact-part', options)]);
    assert.equal(renewals, 1); assert.equal(writes, 1); assert.equal(calls, 61);
    clock = day - 1; await managed.request('/setup'); assert.equal(renewals, 1);
    clock = day; await Promise.all([managed.request('/setup'), transfer('/artifact-part', options)]);
    assert.equal(renewals, 2); assert.equal(writes, 2);
    const restarted = await managedWorkerCredential({ env: f.env, now: () => clock, request: async () => { renewals++; return capped; } });
    await restarted.request('/protocol'); assert.equal(renewals, 4, 'Each process authenticates before use even with a recently issued lease');
  } finally { await f.close(); }
});

test('maintenance CLIs load the same private file and authenticate its Room before ordinary API operations', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { serverProtocol } = await import('../../camp-protocol/src/index.js');
  const f = await fixture(), calls = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + f.value.token);
    calls.push([req.method, req.url]); res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/credential/renew')) res.end(JSON.stringify(f.value));
    else if (req.url.endsWith('/setup')) res.end(JSON.stringify({ roomId: f.value.roomId, projectDigest: 'a'.repeat(64), project: { name: 'fixture' } }));
    else if (req.url.endsWith('/protocol')) res.end(JSON.stringify(serverProtocol()));
    else res.end(JSON.stringify({ plan: { operationId: '12345678-1234-4123-8123-123456789012' }, operation: { phase: 'cancelled' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const env = { ...process.env, ...f.env, CAMP_API_URL: `http://127.0.0.1:${server.address().port}`, CAMP_WORKER_ROOM_ID: f.value.roomId, CAMP_TOOLCHAIN_BUNDLE: join(f.home, 'missing-bundle'), CAMP_RUNTIME_HOME: join(f.home, 'runtime'), CAMP_STORAGE_BUNDLE: join(f.home, 'backup') };
    delete env.CAMP_WORKER_TOKEN;
    for (const [script, args] of [['doctor.mjs', []], ['storage.mjs', ['backup', '--operation', '12345678-1234-4123-8123-123456789012']], ['artifacts.mjs', ['download', '--operation', '12345678-1234-4123-8123-123456789012']], ['export.mjs', ['--goal', '12345678-1234-4123-8123-123456789012', '--out', join(f.home, 'export')]]]) {
      calls.length = 0;
      const result = await execute(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { env, timeout: 10000 }).then(value => value, error => error);
      assert.deepEqual(calls[0], ['POST', '/api/camp/worker/credential/renew'], script);
      assert.ok(calls.length >= 2, script + ' must reach the normal endpoint after authentication');
      assert.equal((result.stdout + result.stderr).includes(f.value.token), false);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.close(); }
});
