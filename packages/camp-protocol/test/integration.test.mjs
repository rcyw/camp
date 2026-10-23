import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerDeclaration, createPluginDeclaration, parseIntegrationInput, serializeIntegrationInput, parseIntegrationReport, getTaskRequirements, checkWorkerCompatibility, parsePlanMode } from '../src/index.js';

const candidate = hex => ({ type: 'layerfs', projectId: 'p-' + 'a'.repeat(16), imageId: 'sha256:' + 'b'.repeat(64), refKind: 'commit', refId: '12' + hex.repeat(64), rootId: hex.repeat(64) });
const input = () => ({ schemaVersion: 1, algorithm: 'layerfs-three-way-v1', policy: 'reject-overlap-v1', base: candidate('c'), parents: [{ key: 'left', runId: '00000000-0000-4000-8000-000000000001', epoch: 1, candidate: candidate('d') }, { key: 'right', runId: '00000000-0000-4000-8000-000000000002', epoch: 2, candidate: candidate('e') }] });
const report = () => ({ schemaVersion: 1, inputDigest: 'f'.repeat(64), algorithm: 'layerfs-three-way-v1', policy: 'reject-overlap-v1', status: 'merged', candidate: candidate('f'), conflicts: [], truncated: false });

test('integration input freezes ordered producing identities, project and algorithm', () => {
  const value = input(), parsed = parseIntegrationInput(value);
  assert.equal(parsed.parents[1].epoch, 2);
  assert.equal(serializeIntegrationInput({ parents: value.parents, base: value.base, policy: value.policy, algorithm: value.algorithm, schemaVersion: 1 }), serializeIntegrationInput(value));
  assert.notEqual(serializeIntegrationInput({ ...value, parents: [...value.parents].reverse() }), serializeIntegrationInput(value));
  for (const patch of [
    { units: ['src'] }, { policy: 'prefer-last' }, { algorithm: 'model-merge' },
    { parents: [value.parents[0]] }, { parents: [value.parents[0], value.parents[0]] },
    { parents: [value.parents[0], { ...value.parents[1], candidate: { ...value.parents[1].candidate, projectId: 'p-' + 'f'.repeat(16) } }] },
    { parents: [value.parents[0], { ...value.parents[1], candidate: { ...value.parents[1].candidate, imageId: 'sha256:' + 'f'.repeat(64) } }] },
    { parents: [value.parents[0], { ...value.parents[1], epoch: 0 }] },
  ]) assert.throws(() => parseIntegrationInput({ ...value, ...patch }));
});

test('merged results cannot hide conflicts, truncation or unsafe conflict paths', () => {
  assert.equal(parseIntegrationReport(report()).status, 'merged');
  const conflict = { ...report(), status: 'conflict', candidate: null, conflicts: [{ path: 'src/shared.js', reason: 'overlap' }] };
  assert.deepEqual(parseIntegrationReport(conflict).conflicts, conflict.conflicts);
  for (const patch of [{ candidate: null }, { conflicts: conflict.conflicts }, { truncated: true }, { extra: 'untrusted' }]) assert.throws(() => parseIntegrationReport({ ...report(), ...patch }));
  for (const patch of [{ candidate: candidate('f') }, { conflicts: [] }, { conflicts: [{ path: '../outside', reason: 'overlap' }] }, { conflicts: [{ path: '/etc/file', reason: 'overlap' }] }, { conflicts: [{ path: '.', reason: 'choose-left' }] }, { conflicts: Array(101).fill(conflict.conflicts[0]) }]) assert.throws(() => parseIntegrationReport({ ...conflict, ...patch }));
});

test('integration is a v3 roleless capability and a model plugin cannot offer it', () => {
  assert.equal(parsePlanMode('same_baseline_pair'), 'same_baseline_pair');
  assert.throws(() => parsePlanMode('parallel'));
  const requirements = getTaskRequirements({ protocolVersion: 3, workflow: 'serial', taskKind: 'integration', inputCandidate: candidate('c') });
  assert.deepEqual(requirements.refKinds, ['layer', 'commit']);
  assert.ok(!requirements.capabilities.includes('dsh.acp.v1'));
  assert.equal(checkWorkerCompatibility(createWorkerDeclaration(), requirements).status, 'compatible');
  assert.equal(checkWorkerCompatibility(createPluginDeclaration(), requirements).status, 'incompatible');
  assert.equal(checkWorkerCompatibility({ ...createWorkerDeclaration(), protocolVersions: [1, 2] }, requirements).code, 'protocol_unsupported');
  assert.equal(checkWorkerCompatibility(createWorkerDeclaration(), { ...requirements, protocolVersion: 2 }).code, 'protocol_unsupported');
  assert.equal(checkWorkerCompatibility(createWorkerDeclaration(), { ...requirements, workflow: 'legacy' }).code, 'protocol_unsupported');
});
