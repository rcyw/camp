import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { boundedVerificationReport, executeVerificationCheck, loadVerificationHarnesses } from '../src/verification.mjs';
import { negotiateWorker } from '../src/worker-protocol.mjs';
import { serverProtocol, CAMP_AGENT_TASK_KINDS, CAMP_CAPABILITIES_V1, CAMP_VERIFICATION_LIMITS, parseVerificationReport } from '../../camp-protocol/src/index.js';
const execute = promisify(execFile);

test('five observed checks survive aggregate JSON log expansion without losing exit facts', () => {
  const candidate = { type: 'layerfs', projectId: `p-${'a'.repeat(16)}`, imageId: `sha256:${'b'.repeat(64)}`, refKind: 'commit', refId: `12${'c'.repeat(64)}`, commitId: `12${'c'.repeat(64)}`, rootId: 'd'.repeat(64) };
  const checks = Array.from({ length: 5 }, (_, index) => ({ id: `check-${index}`, argv: ['node', '--test'], exitCode: index ? 0 : 1, signal: null, timedOut: false, oomKilled: false, durationMs: 10 + index, stdout: '\0'.repeat(16384), stderr: '\u0001'.repeat(16384), outputTruncated: false }));
  const raw = { candidate, policyDigest: 'e'.repeat(64), checks };
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) > CAMP_VERIFICATION_LIMITS.maxPayloadBytes);
  const report = boundedVerificationReport(raw);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= CAMP_VERIFICATION_LIMITS.maxPayloadBytes);
  assert.deepEqual(parseVerificationReport(report), report);
  assert.deepEqual(report.candidate, candidate);
  for (const [index, check] of report.checks.entries()) {
    const { stdout, stderr, outputTruncated, ...facts } = check;
    const { stdout: _out, stderr: _err, outputTruncated: _truncated, ...expected } = checks[index];
    assert.deepEqual(facts, expected); assert.equal(outputTruncated, true);
    assert.ok(checks[index].stdout.startsWith(stdout)); assert.ok(checks[index].stderr.startsWith(stderr));
  }
  const exact = boundedVerificationReport({ ...raw, checks: checks.map(check => ({ ...check, stdout: '\uFEFFvalid output', stderr: '' })) });
  assert.equal(exact.checks[0].stdout, '\uFEFFvalid output'); assert.equal(exact.checks[0].outputTruncated, false);
  const fullText = { ...raw, checks: checks.map(check => ({ ...check, stdout: 'x'.repeat(32768), stderr: '' })) };
  assert.ok(Buffer.byteLength(JSON.stringify(fullText)) < CAMP_VERIFICATION_LIMITS.maxPayloadBytes);
  assert.deepEqual(boundedVerificationReport(fullText), parseVerificationReport(fullText), 'Valid complete logs must never be shortened by an unnecessary fair-share limit');
});

test('an unresponsive Docker kill and exec client hit an independent hard deadline', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const killed = []; child.kill = value => { killed.push(value); return true; };
  const calls = [];
  const started = Date.now();
  await assert.rejects(executeVerificationCheck({
    runtime: { docker: '/fixture.sock', dockerCall: async argv => { calls.push(argv); return new Promise(() => {}); } },
    containerId: 'owned-container', check: { id: 'hung', argv: ['node', '--test'], timeoutMs: 5 },
    spawnCommand: () => child, stopGraceMs: 25,
  }), { code: 'verification_execution_failed' });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(calls, [['kill', 'owned-container']]);
  assert.ok(killed.includes('SIGKILL'));
});

test('trusted harnesses are regular no-follow files with actual hashes, not declared hashes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'camp-harness-'));
  try {
    const path = join(home, 'check.mjs'), mapping = join(home, 'mapping.json');
    await writeFile(path, 'process.exit(0);\n');
    await writeFile(mapping, JSON.stringify([{ id: 'core', path }]));
    const [harness] = await loadVerificationHarnesses({ CAMP_VERIFICATION_HARNESSES: mapping });
    assert.equal(harness.sha256, createHash('sha256').update('process.exit(0);\n').digest('hex'));
    const link = join(home, 'symlink.mjs'); await symlink(path, link);
    await writeFile(mapping, JSON.stringify([{ id: 'core', path: link }]));
    await assert.rejects(loadVerificationHarnesses({ CAMP_VERIFICATION_HARNESSES: mapping }));
    await writeFile(mapping, JSON.stringify([{ id: '../escape', path }]));
    await assert.rejects(loadVerificationHarnesses({ CAMP_VERIFICATION_HARNESSES: mapping }));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a FIFO harness or mapping is rejected by a bounded process without waiting for a writer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'camp-fifo-harness-'));
  try {
    const fifo = join(home, 'not-a-file'); await execute('mkfifo', [fifo]);
    const mapping = join(home, 'mapping.json'); await writeFile(mapping, JSON.stringify([{ id: 'core', path: fifo }]));
    const module = new URL('../src/verification.mjs', import.meta.url).href;
    for (const path of [mapping, fifo]) {
      const script = `import {loadVerificationHarnesses} from ${JSON.stringify(module)}; try {await loadVerificationHarnesses({CAMP_VERIFICATION_HARNESSES:process.argv[1]}); process.exitCode=1;} catch {process.stdout.write('refused');}`;
      const result = await execute(process.execPath, ['--input-type=module', '-e', script, path], { timeout: 2000 });
      assert.equal(result.stdout, 'refused');
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a FIFO plugin declaration is rejected before any claim or blocking read', async () => {
  const home = await mkdtemp(join(tmpdir(), 'camp-fifo-plugin-'));
  try {
    await execute('mkfifo', [join(home, 'protocol.json')]);
    const protocol = new URL('../../camp-protocol/src/index.js', import.meta.url).href, worker = new URL('../src/worker-protocol.mjs', import.meta.url).href;
    const script = `import {serverProtocol} from ${JSON.stringify(protocol)};import {negotiateWorker} from ${JSON.stringify(worker)};try{await negotiateWorker({request:async()=>serverProtocol(),pluginPath:process.argv[1],env:{DEEPSEEK_API_KEY:'fixture-unused'}});process.exitCode=1;}catch(error){if(error.code!=='plugin_protocol_required')throw error;process.stdout.write('refused');}`;
    assert.equal((await execute(process.execPath, ['--input-type=module', '-e', script, home], { timeout: 2000 })).stdout, 'refused');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('keyless v3 negotiation offers system operations and never reads a plugin', async () => {
  const { protocol } = await negotiateWorker({ request: async () => serverProtocol(), pluginPath: '/does-not-exist', env: {} });
  assert.deepEqual(protocol.taskKinds, ['verification', 'integration']);
  assert.deepEqual(protocol.capabilities, ['layerfs.candidate.v1', 'candidate-diff.v1', 'trusted-verification.v1', 'trusted-integration.v1']);
  assert.equal('harnesses' in protocol, false);
});

test('a v2 server receives no v3 integration declaration from either worker mode', async () => {
  const server = serverProtocol();
  server.supportedProtocolVersions = [1, 2];
  server.taskKinds = server.taskKinds.filter(kind => kind !== 'integration');
  server.capabilities = server.capabilities.filter(capability => capability !== 'trusted-integration.v1');
  for (const hasModel of [false, true]) {
    const { protocol } = await negotiateWorker({ request: async () => server, pluginPath: hasModel ? new URL('../../dsh-plugin/', import.meta.url).pathname : '/does-not-exist', env: hasModel ? { DEEPSEEK_API_KEY: 'fixture-unused' } : {} });
    assert.deepEqual(protocol.protocolVersions, [1, 2]);
    assert.equal(protocol.taskKinds.includes('integration'), false);
    assert.equal(protocol.capabilities.includes('trusted-integration.v1'), false);
    if (!hasModel) assert.deepEqual(protocol.taskKinds, ['verification']);
  }
});

test('a v1 server receives the v1 declaration shape, while keyless workers cannot claim its agents', async () => {
  const server = { ...serverProtocol(), supportedProtocolVersions: [1], taskKinds: [...CAMP_AGENT_TASK_KINDS], capabilities: [...CAMP_CAPABILITIES_V1] };
  const { protocol } = await negotiateWorker({ request: async () => server, pluginPath: new URL('../../dsh-plugin/', import.meta.url).pathname, env: { DEEPSEEK_API_KEY: 'fixture-unused' } });
  assert.deepEqual(protocol.protocolVersions, [1]);
  assert.deepEqual(protocol.taskKinds, CAMP_AGENT_TASK_KINDS);
  assert.equal('harnesses' in protocol, false);
  await assert.rejects(negotiateWorker({ request: async () => server, pluginPath: '/unused', env: {} }), { status: 426 });
});
