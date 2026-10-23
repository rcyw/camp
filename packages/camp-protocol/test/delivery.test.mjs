import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCandidate, parseChangeSet, parseVerificationPolicy, parseVerificationReport, serializeVerificationPolicy, createWorkerDeclaration, getTaskRequirements, checkWorkerCompatibility, CAMP_VERIFICATION_LIMITS } from '../src/index.js';

const base = parseCandidate({ type: 'layerfs', projectId: 'p-' + 'a'.repeat(16), refKind: 'layer', refId: '32' + 'b'.repeat(64), rootId: 'c'.repeat(64), imageId: 'sha256:' + 'd'.repeat(64) });
const target = parseCandidate({ ...base, layerId: undefined, refKind: 'commit', refId: '12' + 'e'.repeat(64), rootId: 'f'.repeat(64) });
const file = { type: 'file', mode: 0o644, size: 1, sha256: '0'.repeat(64) };
const entry = { path: 'src/index.js', change: 'added', before: null, after: file, binary: false, modeChanged: false, patch: '+x', patchTruncated: false, previewReason: null };
const changes = { schemaVersion: 1, base, target, entries: [entry], truncated: false, stats: { added: 1, modified: 0, deleted: 0, typeChanged: 0 } };
const policy = { id: 'catalog', revision: 1, name: 'Project checks', checks: [{ id: 'node-tests', label: 'Node tests', argv: ['node', '--test'], timeoutMs: 30000 }], maxRepairAttempts: 1 };
const check = { id: 'node-tests', argv: ['node', '--test'], exitCode: 0, signal: null, timedOut: false, oomKilled: false, durationMs: 100, stdout: '22 tests passed\n', stderr: '', outputTruncated: false };

test('operator policy is canonical and cannot smuggle execution configuration', () => {
  assert.deepEqual(parseVerificationPolicy(policy), policy);
  const reordered = { checks: policy.checks, revision: 1, name: policy.name, maxRepairAttempts: 1, id: 'catalog' };
  assert.equal(serializeVerificationPolicy(reordered), serializeVerificationPolicy(policy));
  for (const update of [{ image: 'arbitrary-image' }, { env: { SECRET: 'not allowed' } }, { checks: [] }, { maxRepairAttempts: 4 }, { checks: [{ ...policy.checks[0], timeoutMs: 0 }] }, { checks: [{ ...policy.checks[0], argv: ['node', 'bad\0argument'] }] }]) assert.throws(() => parseVerificationPolicy({ ...policy, ...update }));
});

test('fixed external harness support is checked by digest before any verification work', () => {
  const harness = { id: 'catalog-contract', sha256: 'e'.repeat(64) };
  const external = parseVerificationPolicy({ ...policy, checks: [{ ...policy.checks[0], argv: ['node', '/camp-checks/catalog-contract'], harness }] });
  const requirements = getTaskRequirements({ protocolVersion: 2, workflow: 'serial', taskKind: 'verification', inputCandidate: target, verificationPolicy: { policy: external, digest: 'f'.repeat(64) } });
  assert.equal(requirements.capabilities.some(value => value.startsWith('dsh.')), false);
  const worker = createWorkerDeclaration(); worker.taskKinds = ['verification']; worker.capabilities = requirements.capabilities;
  assert.deepEqual(checkWorkerCompatibility(worker, requirements).missingHarnesses, ['catalog-contract']);
  worker.harnesses = [{ ...harness, sha256: '0'.repeat(64) }];
  assert.equal(checkWorkerCompatibility(worker, requirements).status, 'incompatible');
  worker.harnesses = [harness];
  assert.equal(checkWorkerCompatibility(worker, requirements).status, 'compatible');
  worker.protocolVersions = [1]; assert.equal(checkWorkerCompatibility(worker, requirements).code, 'protocol_unsupported');
  assert.throws(() => parseVerificationPolicy({ ...external, checks: [{ ...external.checks[0], argv: ['node', '--test'] }] }), /readonly/);
});

test('v1 model work retains the exact original requirement shape', () => {
  const requirements = getTaskRequirements({ protocolVersion: 1, workflow: 'serial', taskKind: 'plan', inputCandidate: null });
  assert.equal('harnesses' in requirements, false);
  assert.equal(requirements.capabilities.includes('trusted-verification.v1'), false);
  const legacyWorker = { ...createWorkerDeclaration(), protocolVersions: [1], taskKinds: ['plan'], capabilities: requirements.capabilities };
  assert.equal(checkWorkerCompatibility(legacyWorker, requirements).status, 'compatible');
  assert.equal(checkWorkerCompatibility(createWorkerDeclaration(), { ...requirements, taskKind: 'verification' }).code, 'protocol_unsupported');
});

test('raw check reports contain observed termination, never an asserted pass decision', () => {
  const report = { candidate: target, policyDigest: 'a'.repeat(64), checks: [check] };
  assert.deepEqual(parseVerificationReport(report), report);
  for (const patch of [{ status: 'passed' }, { checks: [{ ...check, exitCode: undefined }] }, { checks: [{ ...check, timedOut: undefined }] }, { checks: [check, check] }, { checks: [{ ...check, stdout: 'x'.repeat(32769) }] }]) assert.throws(() => parseVerificationReport({ ...report, ...patch }));
  const timeout = parseVerificationReport({ ...report, checks: [{ ...check, exitCode: null, signal: 'SIGKILL', timedOut: true }] });
  assert.equal(timeout.checks[0].timedOut, true);
  assert.equal('status' in timeout, false);
});

test('diffs bind both immutable snapshots and reject unsafe or contradictory entries', () => {
  assert.deepEqual(parseChangeSet(changes), changes);
  for (const path of ['/etc/passwd', '../escape', 'src/../escape', 'src\\escape', 'bad\0name']) assert.throws(() => parseChangeSet({ ...changes, entries: [{ ...entry, path }] }));
  for (const update of [{ entries: [entry, entry] }, { stats: { ...changes.stats, added: 2 } }, { entries: [{ ...entry, binary: true }] }, { entries: [{ ...entry, patch: 'x'.repeat(16385) }] }, { entries: [{ ...entry, before: file }] }]) assert.throws(() => parseChangeSet({ ...changes, ...update }));
  const root = { ...entry, path: '.', change: 'modified', before: { type: 'directory', mode: 0o755, size: 0 }, after: { type: 'directory', mode: 0o700, size: 0 }, modeChanged: true, patch: null };
  assert.equal(parseChangeSet({ ...changes, entries: [root], stats: { added: 0, modified: 1, deleted: 0, typeChanged: 0 } }).entries[0].modeChanged, true);
  assert.throws(() => parseChangeSet({ ...changes, entries: [{ ...entry, path: '.' }] }));
});

test('opaque links and truncated previews preserve their explicit semantics', () => {
  const link = { ...entry, path: 'config-link', after: { type: 'symlink', mode: 0o777, size: 11, target: '/etc/config' }, patch: null, previewReason: 'symlink' };
  const parsed = parseChangeSet({ ...changes, entries: [link], truncated: true, stats: { ...changes.stats, added: 50 } });
  assert.equal(parsed.entries[0].after.target, '/etc/config'); assert.equal(parsed.truncated, true);
  const huge = { ...entry, patch: null, patchTruncated: true, previewReason: 'text_size_limit' };
  assert.equal(parseChangeSet({ ...changes, entries: [huge] }).entries[0].patchTruncated, true);
});

test('a policy cannot exceed the mandatory argv budget of its future report', () => {
  const large = { ...policy, checks: Array.from({ length: 5 }, (_, index) => ({ ...policy.checks[0], id: 'check-' + index, argv: ['node', ...Array(20).fill('界'.repeat(4000))] })) };
  assert.throws(() => parseVerificationPolicy(large), /total byte budget/);
  const accepted = parseVerificationPolicy({ ...policy, checks: [{ ...policy.checks[0], argv: ['node', ...Array(10).fill('x'.repeat(4000))] }] });
  assert.ok(Buffer.byteLength(serializeVerificationPolicy(accepted)) <= CAMP_VERIFICATION_LIMITS.maxPolicyBytes);
  const raw = parseVerificationReport({ candidate: target, policyDigest: 'a'.repeat(64), checks: [{ ...check, argv: accepted.checks[0].argv }] });
  assert.deepEqual(raw.checks[0].argv, accepted.checks[0].argv);
});

test('diff sides and classifications cannot carry contradictory filesystem facts', () => {
  const link = { type: 'symlink', mode: 0o777, size: 1, target: 'x' };
  const directory = { type: 'directory', mode: 0o755, size: 0 };
  const invalid = [
    { ...entry, after: { ...file, target: { invalid: true } } },
    { ...entry, after: { ...link, sha256: 'f'.repeat(64) }, patch: null },
    { ...entry, after: { ...directory, size: 4 }, patch: null },
    { ...entry, after: { ...directory, sha256: 'x' }, patch: null },
    { ...entry, change: 'modified', before: file, after: link, modeChanged: true, patch: null },
    { ...entry, change: 'modified', before: file, after: file, patch: null },
    { ...entry, after: link },
    { ...entry, after: directory },
    { ...entry, modeChanged: true },
  ];
  for (const value of invalid) {
    const stats = { added: 0, modified: 0, deleted: 0, typeChanged: 0, [value.change === 'type_changed' ? 'typeChanged' : value.change]: 1 };
    assert.throws(() => parseChangeSet({ ...changes, stats, entries: [value] }), undefined, JSON.stringify(value));
  }
});
