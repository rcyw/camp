import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { startWorker } from '../src/worker.mjs';
import { WorkerJournal } from '../src/durable-state.mjs';
import { assertClaimCompatibility, selectWorkerDeclaration, negotiateWorker } from '../src/worker-protocol.mjs';
import { checkedRunPolicy } from '../src/run-policy.mjs';
import { CAMP_PREFLIGHT_CHECK_IDS, CAMP_CAPABILITIES_V1, CAMP_CAPABILITIES_V4, createWorkerDeclaration, serverProtocol, getTaskRequirements, checkWorkerCompatibility } from '../../camp-protocol/src/index.js';

const compatibility = { status: 'compatible', code: 'compatible', protocolVersion: 1, missingTaskKinds: [], missingRefKinds: [], missingCapabilities: [] };
const executionPool = () => ({ poolId: randomUUID(), storageId: 'a'.repeat(64), maxParallel: 2, workerIds: ['dag-lane-1', 'dag-lane-2'], resources: { maxContainers: 4, cpuMillis: 8000, memoryBytes: 8 * 1024 ** 3, pidsLimit: 1024 } });
test('only a coordinated pool offers v5 DAG authority, with correct v4 and standalone capability fallback', () => {
  const server = serverProtocol(), pool = executionPool();
  const model = selectWorkerDeclaration(server, { executionPool: pool });
  assert.equal(model.version, 5); assert(model.protocol.capabilities.includes('structured-plan.v2')); assert(model.protocol.capabilities.includes('bounded-dag.v1'));
  const verifier = selectWorkerDeclaration(server, { executionPool: pool, hasModel: false });
  assert.equal(verifier.version, 5); assert(verifier.protocol.capabilities.includes('bounded-dag.v1')); assert(!verifier.protocol.capabilities.includes('structured-plan.v2'));
  assert.equal(checkWorkerCompatibility(verifier.protocol, getTaskRequirements({ protocolVersion: 5, workflow: 'serial', taskKind: 'integration', inputCandidate: null })).status, 'compatible');
  const old = { ...server, supportedProtocolVersions: [1, 2, 3, 4], capabilities: [...CAMP_CAPABILITIES_V4] };
  const fallback = selectWorkerDeclaration(old, { executionPool: pool });
  assert.equal(fallback.version, 4); assert(!fallback.protocol.capabilities.includes('structured-plan.v2')); assert(!fallback.protocol.capabilities.includes('bounded-dag.v1'));
  assert.equal(checkWorkerCompatibility(fallback.protocol, getTaskRequirements({ protocolVersion: 5, workflow: 'serial', taskKind: 'build', inputCandidate: null })).status, 'incompatible');
  const standalone = selectWorkerDeclaration(server);
  assert.equal(standalone.version, 3); assert(!standalone.protocol.protocolVersions.includes(5)); assert(!standalone.protocol.capabilities.includes('structured-plan.v2')); assert(!standalone.protocol.capabilities.includes('bounded-dag.v1'));
});
test('an integration claim cannot switch between the v1 and v2 algorithm after protocol negotiation', () => {
  const pool = executionPool(), offered = selectWorkerDeclaration(serverProtocol(), { executionPool: pool }).protocol;
  for (const version of [4, 5]) {
    const requirements = getTaskRequirements({ protocolVersion: version, workflow: 'serial', taskKind: 'integration', inputCandidate: null });
    const value = { compatibility: checkWorkerCompatibility(offered, requirements) };
    const claim = { executor: 'integration', taskKind: 'integration', workflow: 'serial', protocolVersion: version, inputCandidate: null, integrationInput: { algorithm: version === 5 ? 'layerfs-three-way-v2' : 'layerfs-three-way-v1' }, workerProtocol: { version, declaration: offered, requirements } };
    assert.doesNotThrow(() => assertClaimCompatibility(value, claim, offered));
    assert.throws(() => assertClaimCompatibility(value, { ...claim, integrationInput: { algorithm: version === 5 ? 'layerfs-three-way-v1' : 'layerfs-three-way-v2' } }, offered), /integration algorithm/);
  }
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'camp-protocol-worker-'));
  const workerId = `protocol-test-${randomUUID()}`;
  const env = { CAMP_API_URL: 'http://protocol.test', CAMP_WORKER_TOKEN: 'fixture-only', CAMP_WORKER_ID: workerId, CAMP_WORKER_ONCE: '1', DEEPSEEK_API_KEY: 'fixture-unused' };
  const runtime = { home, runIdentity: runId => ({ runId, prefix: `prefix-${runId}` }), async cleanupAttempt(prefix) { actions.push(`cleanup:${prefix}`); } };
  const journal = await new WorkerJournal({ home, apiUrl: env.CAMP_API_URL, workerId }).ready();
  const actions = [], claims = [], completions = [];
  const state = { run: { id: 'old-run', roomId: 'room', workerId, epoch: 2, status: 'completed' }, leaseValid: false, replaced: false };
  const f = { home, env, runtime, journal, state, actions, claims, completions, server: serverProtocol(), claimResult: { run: null, compatibility: null, requirements: null }, sessions: 0 };
  f.request = async (path, body) => {
    actions.push(path);
    if (path.startsWith('/reconcile')) return { runs: [] };
    if (path.endsWith('/state')) return state;
    if (path.endsWith('/cleanup')) return { cleanupState: 'confirmed' };
    if (path.endsWith('/complete')) { completions.push(body); return { replayed: true }; }
    if (path === '/protocol') { if (f.server instanceof Error) throw f.server; return f.server; }
    if (path === '/claim') { claims.push(body); return f.claimResult; }
    throw new Error(`Unexpected fixture request ${path}`);
  };
  f.createSession = () => { f.sessions++; throw new Error('No model session is permitted in protocol tests'); };
  f.log = () => {};
  f.admitExecution = async () => {};
  f.checkCapacity = async () => {};
  f.close = async () => rm(home, { recursive: true, force: true });
  return f;
}
test('actual old plugin and new server negotiate only v1–v4 and reject DAG without allocation, including default preflight', async () => {
  const f = await fixture(), pool = executionPool(), versions = []; let allocated = 0;
  pool.workerIds = [f.env.CAMP_WORKER_ID, 'other-old-plugin-lane'];
  const old = { ...createWorkerDeclaration(), protocolVersions: [1, 2, 3, 4], capabilities: [...CAMP_CAPABILITIES_V4] };
  const pluginPath = join(f.home, 'original-installed-plugin'); await mkdir(pluginPath); await writeFile(join(pluginPath, 'protocol.json'), JSON.stringify(old)); f.env.CAMP_DSH_PLUGIN = pluginPath;
  try {
    const negotiated = await negotiateWorker({ request: f.request, env: f.env, pluginPath, executionPool: pool });
    assert.deepEqual(negotiated.protocol.protocolVersions, [1, 2, 3, 4]); assert(!negotiated.protocol.capabilities.includes('bounded-dag.v1'));
    assert.equal(checkWorkerCompatibility(negotiated.protocol, getTaskRequirements({ protocolVersion: 4, workflow: 'serial', taskKind: 'build', inputCandidate: null })).status, 'compatible');
    const request = async (path, body) => {
      if (path === '/setup') return { roomId: randomUUID(), project: { name: 'old-deployment' }, projectDigest: 'a'.repeat(64) };
      if (path === '/preflight') return { accepted: true };
      if (path === '/claim') {
        f.claims.push(body); assert.deepEqual(body.protocol.protocolVersions, [1, 2, 3, 4]);
        const requirements = getTaskRequirements({ protocolVersion: 5, workflow: 'serial', taskKind: 'build', inputCandidate: null });
        const compatibility = checkWorkerCompatibility(body.protocol, requirements);
        if (compatibility.status === 'compatible') allocated++;
        return { run: null, compatibility, requirements };
      }
      return f.request(path, body);
    };
    const preflightChecks = async ({ protocolVersion }) => {
      versions.push(protocolVersion);
      return { checks: CAMP_PREFLIGHT_CHECK_IDS.filter(id => !['api', 'resource_policy', 'model'].includes(id)).map(id => ({ id, status: 'passed', code: 'available' })), toolchainDigest: 'b'.repeat(64), imageId: 'sha256:' + 'c'.repeat(64) };
    };
    await assert.rejects(startWorker({ ...f, request, executionPool: pool, admitExecution: undefined, preflightChecks }), { code: 'protocol_unsupported' });
    assert.deepEqual(versions, [4]); assert.equal(allocated, 0); assert.equal(f.sessions, 0); assert.equal(f.claims.length, 1);
    assert.equal(await f.journal.pendingClaim(), null);
  } finally { await f.close(); }
});
test('v1 plugin compatibility remains explicit and missing baseline capabilities cannot cause a silent downgrade', async () => {
  const plugin = { ...createWorkerDeclaration(), protocolVersions: [1], capabilities: [...CAMP_CAPABILITIES_V1] };
  const oldServer = { ...serverProtocol(), supportedProtocolVersions: [1], capabilities: [...CAMP_CAPABILITIES_V1] };
  assert.equal(selectWorkerDeclaration(oldServer, { plugin }).version, 1);
  const versionTwoOnly = selectWorkerDeclaration(serverProtocol(), { plugin: { ...createWorkerDeclaration(), protocolVersions: [2] } });
  assert.equal(versionTwoOnly.version, 2);
  assert.deepEqual(versionTwoOnly.protocol.protocolVersions, [2]);
  assert.throws(() => selectWorkerDeclaration(serverProtocol(), { plugin: { ...createWorkerDeclaration(), capabilities: createWorkerDeclaration().capabilities.filter(value => value !== 'dsh.acp.v1') } }), { code: 'capability_missing' });
});
test('invalid API URL configurations fail before runtime, journal, logging, signals or requests', async () => {
  const home = await mkdtemp(join(tmpdir(), 'camp-invalid-api-'));
  try {
    for (const value of [
      'http://operator:private_url_value@127.0.0.1:1', 'http://private_url_value@127.0.0.1:1',
      'http://127.0.0.1:1/?key=private_url_value', 'http://127.0.0.1:1/#private_url_value',
      'http://127.0.0.1:1/?', 'http://127.0.0.1:1/#', 'private_url_value',
      'file:///private_url_value', '',
    ]) {
      const runtimeHome = join(home, randomUUID()), logs = [], signalSource = new EventEmitter();
      let runtimeReads = 0, journalReads = 0, requests = 0;
      const options = {
        env: { CAMP_API_URL: value, CAMP_WORKER_TOKEN: 'fixture-token', CAMP_WORKER_ID: 'invalid-' + randomUUID(), CAMP_WORKER_ONCE: '1' },
        get runtime() { runtimeReads++; return { home: runtimeHome }; },
        get journal() { journalReads++; return undefined; },
        signalSource, log: entry => logs.push(entry),
        admitExecution: async () => {}, checkCapacity: async () => {},
        request: async path => { requests++; return path.startsWith('/reconcile') ? { runs: [] } : path === '/protocol' ? serverProtocol() : { run: null, compatibility: null, requirements: null }; },
      };
      await assert.rejects(startWorker(options), error => {
        assert.equal(error.code, 'camp_api_configuration'); assert.equal(error.status, 409);
        assert.ok(!error.message.includes('private_url_value')); assert.ok(!JSON.stringify(error).includes('private_url_value')); return true;
      });
      assert.equal(runtimeReads, 0); assert.equal(journalReads, 0); assert.equal(requests, 0); assert.deepEqual(logs, []);
      assert.equal(signalSource.listenerCount('SIGTERM'), 0); assert.equal(signalSource.listenerCount('SIGINT'), 0);
      await assert.rejects(access(runtimeHome), { code: 'ENOENT' });
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('default worker recovery transport rejects a redirect before contacting its token destination', async () => {
  const f = await fixture(), signalSource = new EventEmitter();
  let redirects = 0, destinations = 0;
  const server = createServer((req, res) => {
    if (req.url === '/destination') { destinations++; res.end('{}'); return; }
    redirects++; assert.equal(req.headers.authorization, 'Bearer fixture-only');
    res.writeHead(307, { Location: '/destination' }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.env.CAMP_API_URL = 'http://127.0.0.1:' + server.address().port;
  try {
    await startWorker({ ...f, request: undefined, journal: undefined, signalSource, log: entry => { if (entry.event === 'worker_api_backoff') signalSource.emit('SIGTERM'); } });
    assert.equal(redirects, 1); assert.equal(destinations, 0); assert.equal(f.sessions, 0);
  } finally { await new Promise(resolve => server.close(resolve)); await f.close(); }
});
test('default worker transport and its retained journal preserve the existing base path slash identity', async () => {
  const f = await fixture(), requests = [], logs = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (!req.url.startsWith('/legacy//api/camp/worker/')) { res.statusCode = 400; res.end(JSON.stringify({ code: 'path_changed' })); return; }
    const path = req.url.slice('/legacy//api/camp/worker'.length);
    res.end(JSON.stringify(path.startsWith('/reconcile?') ? { runs: [] } : path === '/protocol' ? serverProtocol() : { run: null, compatibility: null, requirements: null }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.env.CAMP_API_URL = 'http://127.0.0.1:' + server.address().port + '/legacy//';
  try {
    await startWorker({ ...f, request: undefined, journal: undefined, log: entry => logs.push(entry) });
    assert.equal(requests.length, 3); assert.equal(f.sessions, 0);
    const expected = f.env.CAMP_API_URL.slice(0, -1);
    // The existing start path passes its once-trimmed URL to WorkerJournal,
    // which applies its own historical trim. Preserve both identities.
    const journal = new WorkerJournal({ home: f.home, workerId: f.env.CAMP_WORKER_ID, apiUrl: expected });
    assert.equal(JSON.parse(await readFile(join(journal.folder, 'worker.json'), 'utf8')).apiUrl, expected.slice(0, -1));
    assert.equal(logs.find(entry => entry.event === 'worker_ready').apiUrl, expected);
  } finally { await new Promise(resolve => server.close(resolve)); await f.close(); }
});
for (const mode of ['old-server', 'unknown-version', 'missing-capability', 'missing-kind', 'missing-reference']) test(`${mode} refuses new claims before allocating a run`, async () => {
  const f = await fixture();
  try {
    if (mode === 'old-server') f.server = Object.assign(new Error('Discovery does not exist'), { status: 404 });
    if (mode === 'unknown-version') f.server.supportedProtocolVersions = [99];
    if (mode === 'missing-capability') f.server.capabilities = f.server.capabilities.filter(capability => capability !== 'layerfs.candidate.v1');
    if (mode === 'missing-kind') f.server.taskKinds.pop();
    if (mode === 'missing-reference') f.server.refKinds.pop();
    await assert.rejects(startWorker(f), error => error.status === 426);
    assert.equal(f.claims.length, 0);
    assert.equal(f.sessions, 0);
    assert.equal(await f.journal.pendingClaim(), null);
  } finally { await f.close(); }
});
test('the actual selected plugin needs a static descriptor; its JS is never executed on the host', async () => {
  const f = await fixture();
  try {
    const plugin = join(f.home, 'old-plugin');
    const marker = join(f.home, 'host-execution');
    await mkdir(join(plugin, 'src'), { recursive: true });
    await writeFile(join(plugin, 'src/protocol.js'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'must not execute'); export const pluginProtocol = ${JSON.stringify(createWorkerDeclaration())};\n`);
    f.env.CAMP_DSH_PLUGIN = plugin;
    await assert.rejects(startWorker(f), { code: 'plugin_protocol_required' });
    assert.equal(f.claims.length, 0);
    await assert.rejects(access(marker));
    await writeFile(join(plugin, 'protocol.json'), JSON.stringify({ ...createWorkerDeclaration(), capabilities: [] }));
    await assert.rejects(startWorker(f), { code: 'capability_missing' });
    assert.equal(f.claims.length, 0);
  } finally { await f.close(); }
});
test('a compatible idle claim declares capabilities and closes the confirmed empty intent', async () => {
  const f = await fixture();
  try {
    await startWorker(f);
    assert.equal(f.claims.length, 1);
    assert.deepEqual(f.claims[0].protocol, selectWorkerDeclaration(f.server).protocol);
    assert.equal(await f.journal.pendingClaim(), null);
    assert.equal(f.sessions, 0);
  } finally { await f.close(); }
});
for (const fault of ['503', 'transport']) test('default admission retries ' + fault + ' during protocol discovery before the first HTTP claim', async () => {
  const f = await fixture(), logs = [];
  let protocolReads = 0, claims = 0, reports = 0, serverFailure;
  const localChecks = async () => ({
    checks: CAMP_PREFLIGHT_CHECK_IDS.filter(id => !['api', 'resource_policy', 'model'].includes(id)).map(id => ({ id, status: 'passed', code: 'available' })),
    toolchainDigest: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64),
  });
  const server = createServer(async (req, res) => {
    const reply = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (req.url.startsWith('/api/camp/worker/reconcile?')) return reply({ runs: [] });
      if (req.url === '/api/camp/worker/setup') return reply({ roomId: 'fixture-room', project: { name: 'fixture' }, projectDigest: 'a'.repeat(64), projectMutable: true });
      if (req.url === '/api/camp/worker/protocol') {
        protocolReads++;
        if (protocolReads === 1) {
          assert.equal(claims, 0); assert.equal(reports, 0);
          if (fault === 'transport') { req.socket.destroy(); return; }
          return reply({ code: 'camp_service_unavailable', error: 'Private upstream response must not reach the report' }, 503);
        }
        return reply(serverProtocol());
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const value = JSON.parse(body);
      if (req.url === '/api/camp/worker/preflight') {
        reports++; assert.equal(claims, 0); assert.ok(protocolReads >= 2);
        assert.equal(value.report.checks.some(check => check.status === 'failed'), false);
        assert.equal('apiFailure' in value.report, false);
        return reply({ accepted: true });
      }
      if (req.url === '/api/camp/worker/claim') {
        claims++; assert.equal(reports, 1); assert.ok(protocolReads >= 3);
        return reply({ run: null, compatibility: null, requirements: null });
      }
      throw new Error('Unexpected local acceptance route');
    } catch (error) { serverFailure = error; reply({ code: 'invalid_fixture' }, 400); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.env.CAMP_API_URL = 'http://127.0.0.1:' + server.address().port;
  try {
    await startWorker({ ...f, request: undefined, journal: undefined, admitExecution: undefined, preflightChecks: localChecks, log: entry => logs.push(entry) });
    assert.ifError(serverFailure);
    assert.equal(claims, 1); assert.equal(reports, 1); assert.equal(protocolReads, 3); assert.equal(f.sessions, 0);
    assert.equal(logs.filter(entry => entry.event === 'worker_api_backoff').length, 1);
    assert.ok(!JSON.stringify(logs).includes('Private upstream response'));
  } finally { await new Promise(resolve => server.close(resolve)); await f.close(); }
});
test('an explicit incompatible result clears its unallocated intent and exits without busy polling', async () => {
  const f = await fixture();
  try {
    f.claimResult = { run: null, compatibility: { ...compatibility, status: 'incompatible', code: 'capability_missing', missingCapabilities: ['future.v2'] } };
    await assert.rejects(startWorker(f), { code: 'capability_missing', status: 426 });
    assert.equal(f.claims.length, 1);
    assert.equal(await f.journal.pendingClaim(), null);
  } finally { await f.close(); }
});
for (const mode of ['unknown-server', 'invalid-new-budget']) test(`existing future-metadata outbox replays unchanged before rejecting ${mode}`, async () => {
  const f = await fixture();
  try {
    const record = await f.journal.recordClaim({ id: 'old-run', roomId: 'room', epoch: 2, workerProtocol: { version: 99, future: 'retained' } }, { runtime: f.runtime.runIdentity('old-run-e2') });
    await f.journal.update(record, { cleanupKnown: true });
    const payload = { workerId: f.env.CAMP_WORKER_ID, epoch: 2, status: 'completed', summary: 'Original result', artifacts: [{ type: 'future', unknown: { immutable: true } }] };
    await f.journal.prepareCompletion(record, payload);
    const digest = record.completion.digest;
    if (mode === 'unknown-server') f.server.supportedProtocolVersions = [99];
    if (mode === 'invalid-new-budget') f.env.CAMP_MODEL_MAX_REQUESTS = '-1';
    await assert.rejects(startWorker(f), error => error.status === 426);
    assert.deepEqual(f.completions, [payload]);
    assert.equal(f.claims.length, 0);
    const [stored] = await f.journal.list();
    assert.equal(stored.completion.digest, digest);
    assert.equal(stored.workerProtocol.version, 99);
    assert.equal(stored.phase, 'settled');
  } finally { await f.close(); }
});
test('an ambiguous old intent is reconciled without another allocation when discovery is unsupported', async () => {
  const f = await fixture();
  try {
    const pending = await f.journal.claimIntent();
    f.server = Object.assign(new Error('Old server'), { status: 404 });
    await assert.rejects(startWorker(f), error => error.status === 426);
    assert.ok(f.actions.indexOf('/protocol') < f.actions.findIndex(path => path.startsWith('/reconcile')));
    assert.equal(await f.journal.pendingClaim(), pending);
    assert.equal(f.claims.length, 0);
  } finally { await f.close(); }
});
test('a keyless worker replays a future-protocol outbox unchanged before offering verification only', async () => {
  const f = await fixture();
  try {
    delete f.env.DEEPSEEK_API_KEY; f.env.CAMP_DSH_PLUGIN = '/missing-plugin';
    const record = await f.journal.recordClaim({ id: 'old-run', roomId: 'room', epoch: 2, workerProtocol: { version: 99, future: 'retained' } }, { runtime: f.runtime.runIdentity('old-run-e2') });
    await f.journal.update(record, { cleanupKnown: true });
    const payload = { workerId: f.env.CAMP_WORKER_ID, epoch: 2, status: 'completed', summary: 'Original future result', future: { immutable: true } };
    await f.journal.prepareCompletion(record, payload);
    const digest = record.completion.digest;
    await startWorker(f);
    assert.deepEqual(f.completions, [payload]);
    assert.deepEqual(f.claims[0].protocol.taskKinds, ['verification', 'integration']);
    const [stored] = await f.journal.list();
    assert.equal(stored.completion.digest, digest); assert.equal(stored.workerProtocol.version, 99);
  } finally { await f.close(); }
});
test('claim validation binds its selected version and exact immutable requirements', () => {
  const claim = { protocolVersion: 1, workflow: 'serial', taskKind: 'plan', inputCandidate: null };
  claim.workerProtocol = { version: 1, declaration: createWorkerDeclaration(), requirements: getTaskRequirements(claim) };
  assert.doesNotThrow(() => assertClaimCompatibility({ compatibility }, claim, createWorkerDeclaration()));
  for (const workerProtocol of [null, { ...claim.workerProtocol, version: 99 }, { ...claim.workerProtocol, requirements: { ...claim.workerProtocol.requirements, capabilities: [] } }]) {
    assert.throws(() => assertClaimCompatibility({ compatibility }, { ...claim, workerProtocol }, createWorkerDeclaration()));
  }
});
test('a legacy reviewer binds the same resolved dependency candidate in negotiation and runtime policy', () => {
  const input = { type: 'layerfs', projectId: `p-${'a'.repeat(16)}`, imageId: `sha256:${'b'.repeat(64)}`, refKind: 'commit', refId: `12${'c'.repeat(64)}`, commitId: `12${'c'.repeat(64)}`, rootId: 'd'.repeat(64) };
  const claim = { protocolVersion: 1, workflow: 'legacy', taskKind: 'review', inputCandidate: input, baseRef: input.refId, dependencies: [{ artifacts: [input] }] };
  const requirements = getTaskRequirements(claim);
  claim.workerProtocol = { version: 1, declaration: createWorkerDeclaration(), requirements };
  assert.deepEqual(requirements.refKinds, ['commit']);
  assert.doesNotThrow(() => assertClaimCompatibility({ compatibility }, claim, createWorkerDeclaration()));
  assert.deepEqual(checkedRunPolicy(claim, input), input);
  const inconsistent = { ...claim, workerProtocol: { ...claim.workerProtocol, requirements: { ...requirements, refKinds: ['layer', 'commit'] } } };
  assert.throws(() => assertClaimCompatibility({ compatibility }, inconsistent, createWorkerDeclaration()), /original execution requirements/);
});
