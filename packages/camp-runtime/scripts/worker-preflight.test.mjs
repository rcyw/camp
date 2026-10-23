import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { CAMP_PREFLIGHT_CHECK_IDS, CAMP_AGENT_TASK_KINDS, CAMP_CAPABILITIES_V1, serverProtocol } from '../../camp-protocol/src/index.js';
import { inspectWorker, workerApiRequest, workerApiUrl } from '../src/worker-preflight.mjs';

const setup = { roomId: 'room', projectDigest: 'a'.repeat(64), project: { name: 'fixture', repoPath: '/source' } };
const protocol = serverProtocol();
const localChecks = async () => ({ checks: CAMP_PREFLIGHT_CHECK_IDS.filter(id => !['api', 'model', 'resource_policy'].includes(id)).map(id => ({ id, status: 'passed', code: 'available' })), toolchainDigest: 'b'.repeat(64), imageId: 'sha256:' + 'c'.repeat(64) });
const env = { CAMP_WORKER_ID: 'preflight-worker', DEEPSEEK_API_KEY: 'private-fixture-value' };
test('safe API validation preserves existing journal URL identities without canonicalization', () => {
  for (const raw of ['http://Example.test:80/base/', 'HTTP://Example.test/a/../base/', 'https://Example.test:443/base%3Fpart', 'http://127.0.0.1:3001/base//']) {
    assert.equal(workerApiUrl({ CAMP_API_URL: raw }), raw.replace(/\/$/, ''));
    assert.equal(typeof workerApiRequest({ CAMP_API_URL: raw }), 'function');
  }
});
test('the shared worker API transport refuses every redirect without sending the room token to its target', async () => {
  let targets = 0, initial = 0;
  const statuses = [301, 302, 303, 307, 308];
  const server = createServer((req, res) => {
    if (req.url === '/target') { targets++; res.end('{}'); return; }
    assert.equal(req.headers.authorization, 'Bearer fixture-room-token');
    res.writeHead(statuses[initial++], { Location: '/target' }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const request = workerApiRequest({ CAMP_API_URL: 'http://127.0.0.1:' + server.address().port, CAMP_WORKER_TOKEN: 'fixture-room-token' });
    for (const _status of statuses) await assert.rejects(request('/setup'), { code: 'camp_api_transport' });
    assert.equal(initial, statuses.length); assert.equal(targets, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('preflight reports failed prerequisites without allocating any work or exposing credentials', async () => {
  const calls = []; const request = async (path, body) => { calls.push({ path, body }); return path === '/setup' ? setup : protocol; };
  const result = await inspectWorker({ runtime: {}, env, request, report: true, localChecks, capacity: async () => { throw Object.assign(new Error('Private host output'), { code: 'camp_capacity_low' }); } });
  assert.equal(result.ready, false); assert.equal(result.reported, true); assert.equal(result.report.checks.find(item => item.id === 'capacity').code, 'capacity_low');
  assert.deepEqual(calls.map(item => item.path), ['/setup', '/protocol', '/preflight']);
  assert.ok(!JSON.stringify(result).includes(env.DEEPSEEK_API_KEY)); assert.ok(!JSON.stringify(result.report).includes('/source'));
});
test('a verification-only worker is explicit and a model credential is only checked for configuration', async () => {
  for (const [configuration, mode, code] of [[env, 'agent', 'configured_not_tested'], [{ CAMP_WORKER_ID: 'verifier' }, 'verification', 'verification_only']]) {
    const result = await inspectWorker({ runtime: {}, env: configuration, request: async path => path === '/setup' ? setup : protocol, localChecks, capacity: async () => {} });
    assert.equal(result.ready, true); assert.equal(result.report.mode, mode); assert.equal(result.report.checks.find(item => item.id === 'model').code, code); assert.equal(result.reported, false);
  }
});
test('missing API and forced agent mode cannot produce a ready report or a claim', async () => {
  const calls = [];
  const result = await inspectWorker({ runtime: {}, env: {}, requireAgent: true, request: async path => { calls.push(path); throw new Error('offline'); }, localChecks, capacity: async () => {} });
  assert.equal(result.ready, false); assert.equal(result.setup, null); assert.equal(result.report.checks.find(item => item.id === 'model').status, 'failed'); assert.deepEqual(calls, ['/setup']);
});
test('preflight checks the actual agent/verifier declaration and the selected v1/v2 server capabilities', async () => {
  const legacy = { ...protocol, supportedProtocolVersions: [1], capabilities: [...CAMP_CAPABILITIES_V1], taskKinds: [...CAMP_AGENT_TASK_KINDS] };
  const verifier = { ...protocol, supportedProtocolVersions: [2], capabilities: ['layerfs.candidate.v1', 'candidate-diff.v1', 'trusted-verification.v1'], taskKinds: ['verification'] };
  for (const [configuration, metadata, ready] of [
    [env, legacy, true], [{ CAMP_WORKER_ID: 'verifier' }, verifier, true],
    [{ CAMP_WORKER_ID: 'verifier' }, legacy, false], [env, verifier, false],
    [env, { ...protocol, capabilities: [] }, false],
    [env, { ...protocol, taskKinds: [] }, false],
    [env, { ...protocol, refKinds: [] }, false],
  ]) {
    let checkedVersion;
    const result = await inspectWorker({ runtime: {}, env: configuration, request: async path => path === '/setup' ? setup : metadata, localChecks: async options => { checkedVersion = options.protocolVersion; return localChecks(); }, capacity: async () => {} });
    assert.equal(result.ready, ready);
    assert.equal(checkedVersion, !configuration.DEEPSEEK_API_KEY && Math.max(...metadata.supportedProtocolVersions) < 2 ? undefined : Math.min(3, Math.max(...metadata.supportedProtocolVersions)));
    assert.equal(result.report.checks.find(item => item.id === 'api').status, ready ? 'passed' : 'failed');
    if (!ready) assert.equal(result.apiFailure.retryable, false);
  }
});
test('preflight retains bounded transient API facts outside its wire report without retaining raw diagnostics', async () => {
  for (const error of [
    Object.assign(new Error('Private response /host/secret'), { status: 503, code: 'camp_service_unavailable' }),
    Object.assign(new Error('Private transport /host/secret'), { code: 'camp_api_transport' }),
    Object.assign(new Error('Private forbidden /host/secret'), { status: 401, code: 'camp_auth_required' }),
  ]) {
    const calls = [];
    const result = await inspectWorker({ runtime: {}, env, report: true, request: async path => { calls.push(path); if (path === '/setup') return setup; throw error; }, localChecks, capacity: async () => {} });
    assert.equal(result.ready, false); assert.equal(result.reported, false);
    assert.deepEqual(result.apiFailure, { ...(error.status ? { status: error.status } : {}), code: error.code, retryable: error.status !== 401 });
    assert.deepEqual(calls, ['/setup', '/protocol']);
    assert.equal('apiFailure' in result.report, false);
    assert.ok(!JSON.stringify(result).includes('/host/secret'));
  }
});

test('reporting without an explicit worker ID uses the same stable default as execution and offline recovery', async () => {
  const { hostname } = await import('node:os');
  const { workerIdForEnvironment } = await import('../src/worker-preflight.mjs');
  let observed;
  const result = await inspectWorker({ runtime: {}, env: {}, report: true, localChecks, capacity: async () => {}, request: async (path, body) => {
    if (path === '/setup') return setup;
    if (path === '/protocol') return protocol;
    assert.equal(path, '/preflight'); observed = body; return {};
  } });
  assert.equal(result.ready, true); assert.equal(result.reported, true);
  assert.equal(observed.workerId, `camp-${hostname()}`); assert.equal(observed.workerId, workerIdForEnvironment({}));
  assert.equal(workerIdForEnvironment({ CAMP_WORKER_ID: 'explicit-worker' }), 'explicit-worker');
});
