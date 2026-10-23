import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkerDeclaration, parseWorkerDeclaration, getTaskRequirements, checkWorkerCompatibility, parseServerProtocol, serverProtocol, parseCandidate, parsePlanSubmission, parsePlan, CAMP_CAPABILITIES, CAMP_TOOL_SCHEMAS, CAMP_PLAN_ITEM_SCHEMA } from '../src/index.js';

const candidate = { type: 'layerfs', projectId: 'p-' + 'a'.repeat(16), refKind: 'layer', refId: '32' + 'b'.repeat(64), rootId: 'c'.repeat(64), imageId: 'sha256:' + 'd'.repeat(64) };
const item = { key: 'search', title: 'Implement search', description: 'Filter by name', acceptance: 'Case insensitive', verification: 'node --test' };
const requirements = getTaskRequirements({ protocolVersion: 1, workflow: 'serial', taskKind: 'plan', inputCandidate: null });

test('an upgraded worker can offer future features while proving every current serial ability', () => {
  const declaration = createWorkerDeclaration();
  declaration.protocolVersions.push(99);
  declaration.taskKinds.push('future-task');
  declaration.capabilities.push('future-feature.v99');
  assert.equal(checkWorkerCompatibility(parseWorkerDeclaration(declaration), requirements).status, 'compatible');
  declaration.protocolVersions = [99];
  assert.equal(checkWorkerCompatibility(declaration, requirements).code, 'protocol_unsupported');
});

test('unsupported and undeclared workers cannot receive versioned work', () => {
  assert.equal(checkWorkerCompatibility(null, requirements).code, 'protocol_required');
  const future = getTaskRequirements({ protocolVersion: 99, workflow: 'serial', taskKind: 'build', inputCandidate: candidate });
  const worker = createWorkerDeclaration(); worker.protocolVersions.push(99);
  assert.equal(checkWorkerCompatibility(worker, future).code, 'protocol_unsupported');
  assert.equal(checkWorkerCompatibility(null, getTaskRequirements({ protocolVersion: null, workflow: 'legacy', taskKind: 'plan' })).status, 'legacy');
});

test('legacy selection uses the highest common version and serial work never infers a missing version', () => {
  const legacy = getTaskRequirements({ protocolVersion: null, workflow: 'legacy', taskKind: 'plan' });
  const worker = { ...createWorkerDeclaration(), protocolVersions: [1] };
  const result = checkWorkerCompatibility(worker, legacy);
  assert.equal(result.status, 'compatible'); assert.equal(result.protocolVersion, 1);
  assert.equal(checkWorkerCompatibility(createWorkerDeclaration(), legacy).protocolVersion, 3);
  assert.equal(checkWorkerCompatibility({ ...worker, protocolVersions: [99] }, legacy).status, 'incompatible');
  assert.equal(checkWorkerCompatibility(createWorkerDeclaration(), { ...requirements, protocolVersion: null }).status, 'incompatible');
  assert.equal(checkWorkerCompatibility(null, { ...legacy, taskKind: 'verification' }).status, 'incompatible');
  assert.equal(checkWorkerCompatibility(createWorkerDeclaration(), { ...legacy, protocolVersion: 2, taskKind: 'verification' }).status, 'incompatible');
});

test('missing tools, yield support and storage formats are diagnosed before allocation', () => {
  const declaration = createWorkerDeclaration();
  declaration.capabilities = declaration.capabilities.filter(value => value !== 'checkpoint-yield.v1' && value !== 'questions.v1');
  declaration.taskKinds = ['build']; declaration.refKinds = ['commit'];
  const result = checkWorkerCompatibility(declaration, requirements);
  assert.equal(result.code, 'capability_missing');
  assert.deepEqual(result.missingTaskKinds, ['plan']);
  assert.deepEqual(result.missingRefKinds, ['layer']);
  assert.deepEqual(result.missingCapabilities, ['questions.v1', 'checkpoint-yield.v1']);
  assert.equal(CAMP_CAPABILITIES.length, 10);
});

test('a commit-only observer can review a commit but cannot build from a layer', () => {
  const worker = createWorkerDeclaration(); worker.refKinds = ['commit'];
  const commit = { ...candidate, refKind: 'commit', refId: '12' + 'b'.repeat(64) };
  assert.equal(checkWorkerCompatibility(worker, getTaskRequirements({ workflow: 'serial', taskKind: 'review', inputCandidate: commit })).status, 'compatible');
  assert.equal(checkWorkerCompatibility(worker, getTaskRequirements({ workflow: 'serial', taskKind: 'build', inputCandidate: commit })).status, 'incompatible');
  assert.throws(() => getTaskRequirements({ workflow: 'parallel', taskKind: 'build' }), /Unknown/);
});

test('declarations reject malformed input and never mutate caller-owned arrays', () => {
  const declaration = createWorkerDeclaration();
  for (const patch of [{ protocolVersions: [] }, { protocolVersions: [1, 1] }, { protocolVersions: ['1'] }, { capabilities: ['a', 'a'] }, { capabilities: ['../../credentials'] }, { workerVersion: '' }, { token: 'not-a-protocol-field' }, { taskKinds: Array(33).fill('plan') }]) assert.throws(() => parseWorkerDeclaration({ ...declaration, ...patch }));
  const parsed = parseWorkerDeclaration(declaration); parsed.capabilities.pop();
  assert.equal(declaration.capabilities.length, 10);
  assert.equal(parseServerProtocol(serverProtocol()).schemaVersion, 1);
  for (const patch of [{ schemaVersion: 2 }, { supportedProtocolVersions: [99] }, { token: 'unexpected' }]) assert.throws(() => parseServerProtocol({ ...serverProtocol(), ...patch }));
});

test('canonical candidates distinguish initial layers, commits and explicit legacy aliases', () => {
  const layer = parseCandidate(candidate); assert.equal(layer.layerId, candidate.refId); assert.equal(layer.commitId, undefined);
  const refId = '12' + 'b'.repeat(64);
  const commit = parseCandidate({ ...candidate, refKind: 'commit', refId }); assert.equal(commit.commitId, refId);
  const legacy = { ...candidate, commitId: refId }; delete legacy.refKind; delete legacy.refId;
  assert.throws(() => parseCandidate(legacy), /explicitly/);
  assert.equal(parseCandidate(legacy, { requireTagged: false, allowLegacy: true }).refId, refId);
  for (const patch of [{ layerId: refId }, { commitId: candidate.refId }, { imageId: undefined }, { refKind: 'commit' }, { rootId: '../root' }, { projectId: 'other-project' }]) assert.throws(() => parseCandidate({ ...candidate, ...patch }));
  assert.throws(() => parseCandidate(candidate, { imageId: 'sha256:' + 'e'.repeat(64) }), /image differs/);
  assert.throws(() => parseCandidate(candidate, { projectId: 'p-' + 'e'.repeat(16) }), /another project/);
});

test('ordered plans reject unsupported graph semantics and preserve one canonical representation', () => {
  const plan = parsePlanSubmission({ planRevision: 1, summary: '  Search  ', tasks: [item] });
  assert.equal(plan.summary, 'Search');
  assert.deepEqual(parsePlan({ revision: 1, summary: plan.summary, tasks: plan.tasks }), { revision: 1, summary: 'Search', tasks: [item] });
  for (const tasks of [[], Array(6).fill(item), [item, item], [{ ...item, dependsOn: [] }], [{ ...item, role: 'builder' }], [{ ...item, description: 'x'.repeat(4001) }], [{ ...item, key: 'UPPER' }]]) assert.throws(() => parsePlanSubmission({ planRevision: 1, summary: 'Search', tasks }));
  assert.throws(() => parsePlanSubmission({ planRevision: 2, summary: 'Search', tasks: [item] }));
  assert.equal(CAMP_PLAN_ITEM_SCHEMA.properties.description.maxLength, 4000);
  assert.equal(CAMP_TOOL_SCHEMAS.camp_submit_plan.properties.tasks.items, CAMP_PLAN_ITEM_SCHEMA);
  assert.equal(Object.keys(CAMP_TOOL_SCHEMAS).length, 12);
  for (const schema of Object.values(CAMP_TOOL_SCHEMAS)) {
    assert.equal(schema.additionalProperties, false);
    assert.equal(Object.keys(schema.properties).some(key => /worker|token|agent_id|model/i.test(key)), false);
  }
});

test('the same dependency-free module runs in a browser', async () => {
  const { chromium } = await import('../../../node_modules/playwright/index.mjs');
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(async ({ source, candidate }) => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try {
        const protocol = await import(url);
        return { version: protocol.CAMP_PROTOCOL_VERSION, candidate: protocol.parseCandidate(candidate), compatible: protocol.checkWorkerCompatibility(protocol.createWorkerDeclaration(), protocol.getTaskRequirements({ workflow: 'serial', taskKind: 'build', inputCandidate: candidate })).status };
      } finally { URL.revokeObjectURL(url); }
    }, { source, candidate });
    assert.equal(result.version, 3); assert.equal(result.compatible, 'compatible'); assert.equal(result.candidate.layerId, candidate.refId);
  } finally { await browser.close(); }
});
