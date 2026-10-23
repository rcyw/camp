import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlanSubmission, parsePlan, parseDagPlanItem, createWorkerDeclaration, createPluginDeclaration, getTaskRequirements, getPluginTaskRequirements, checkWorkerCompatibility, CAMP_DAG_PLAN_TOOL_SCHEMA, parseIntegrationInput, parseIntegrationReport } from '../src/index.js';

const node = (key, dependsOnKeys = []) => ({ key, title: key, description: `Implement ${key}`, acceptance: `${key} works`, verification: 'node --test', dependsOnKeys });
const plan = tasks => ({ planRevision: 2, summary: 'Bounded delivery', tasks });
const pool = { poolId: '11111111-1111-4111-8111-111111111111', storageId: 'a'.repeat(64), maxParallel: 2, workerIds: ['lane-1', 'lane-2'], resources: { maxContainers: 4, cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3, pidsLimit: 1024 } };

test('a six-node graph preserves explicit dependencies rather than inferring array order', () => {
  const tasks = [node('join', ['right', 'left']), node('root'), node('left', ['root']), node('right', ['root']), node('finish', ['join']), node('docs', ['finish'])];
  const accepted = parsePlanSubmission(plan(tasks));
  assert.equal(accepted.planRevision, 2);
  assert.deepEqual(accepted.tasks[0].dependsOnKeys, ['left', 'right']);
  assert.deepEqual(tasks[0].dependsOnKeys, ['right', 'left'], 'Caller arrays remain untouched');
  assert.deepEqual(parsePlan({ revision: 2, summary: accepted.summary, tasks: accepted.tasks }), { revision: 2, summary: accepted.summary, tasks: accepted.tasks });
  assert.equal(CAMP_DAG_PLAN_TOOL_SCHEMA.properties.tasks.maxItems, 6);
  assert.ok(CAMP_DAG_PLAN_TOOL_SCHEMA.properties.tasks.items.required.includes('dependsOnKeys'));
});

test('invalid graphs fail before an accepted plan can become durable', () => {
  const invalid = [
    [], Array.from({ length: 7 }, (_, n) => node(`n${n}`, n ? [`n${n - 1}`] : [])),
    [node('a'), node('a')], [node('a', ['a'])], [node('a', ['missing'])],
    [node('a', ['b']), node('b', ['a'])],
    [node('a'), node('b', ['a']), node('c', ['a', 'b'])],
    [node('a'), node('b'), node('c')],
    [node('a'), node('b'), node('c', ['a', 'a'])],
    [node('a'), node('b'), node('c'), node('d', ['a', 'b', 'c'])],
  ];
  for (const tasks of invalid) assert.throws(() => parsePlanSubmission(plan(tasks)), { code: 'invalid_plan' });
  const { dependsOnKeys: _deps, ...ordinary } = node('a');
  for (const task of [ordinary, { ...node('a'), dependsOnKeys: null }, { ...node('a'), dependsOnKeys: ['../escape'] }, { ...node('a'), workerId: 'forged' }, { ...node('a'), role: 'reviewer' }]) assert.throws(() => parseDagPlanItem(task));
  assert.throws(() => parsePlanSubmission({ ...plan([node('a')]), planRevision: 3 }));
  assert.throws(() => parsePlanSubmission({ planRevision: 1, summary: 'Legacy', tasks: [node('a')] }), /unknown field/);
  assert.deepEqual(parsePlanSubmission(plan([node('a')])).tasks[0].dependsOnKeys, []);
});

test('two independent final nodes are admitted, while a third requires an explicit join', () => {
  assert.equal(parsePlanSubmission(plan([node('a'), node('b')])).tasks.length, 2);
  assert.equal(parsePlanSubmission(plan([node('a'), node('b'), node('c'), node('ab', ['a', 'b'])])).tasks.length, 4);
  assert.throws(() => parsePlanSubmission(plan([node('a'), node('b'), node('c')])), /two final nodes/);
});

test('v5 graph authority requires both a host pool and graph capabilities, plugins only need model tools', () => {
  const requirements = getTaskRequirements({ protocolVersion: 5, workflow: 'serial', taskKind: 'build' });
  const offered = { ...createWorkerDeclaration(), executionPool: pool };
  assert.equal(checkWorkerCompatibility(offered, requirements).status, 'compatible');
  assert.equal(checkWorkerCompatibility({ ...offered, protocolVersions: [1, 2, 3, 4] }, requirements).code, 'protocol_unsupported');
  assert.equal(checkWorkerCompatibility({ ...offered, capabilities: offered.capabilities.filter(cap => cap !== 'bounded-dag.v1') }, requirements).code, 'capability_missing');
  assert.equal(checkWorkerCompatibility(createWorkerDeclaration(), requirements).code, 'pool_required');
  const plugin = createPluginDeclaration();
  assert.equal(checkWorkerCompatibility(plugin, getPluginTaskRequirements(requirements)).status, 'compatible');
  assert.equal(plugin.capabilities.includes('bounded-dag.v1'), false);
  assert.equal(plugin.capabilities.includes('bounded-pair.v1'), false);
  const system = getTaskRequirements({ protocolVersion: 5, workflow: 'serial', taskKind: 'integration' });
  assert.equal(system.capabilities.includes('structured-plan.v2'), false);
  const old = getTaskRequirements({ protocolVersion: 4, workflow: 'serial', taskKind: 'build' });
  assert.equal(old.capabilities.includes('bounded-dag.v1'), false);
});

test('the v2 merge algorithm remains part of the hashed input and reported outcome', () => {
  const candidate = { type: 'layerfs', projectId: `p-${'a'.repeat(16)}`, refKind: 'layer', refId: `32${'b'.repeat(64)}`, rootId: 'c'.repeat(64), imageId: `sha256:${'d'.repeat(64)}` };
  const input = { schemaVersion: 1, algorithm: 'layerfs-three-way-v2', policy: 'reject-overlap-v1', base: candidate, parents: ['a', 'b'].map((key, n) => ({ key, runId: `${n + 1}`.repeat(8) + '-1111-4111-8111-111111111111', epoch: 1, candidate })) };
  assert.equal(parseIntegrationInput(input).algorithm, 'layerfs-three-way-v2');
  const report = { schemaVersion: 1, algorithm: input.algorithm, policy: input.policy, inputDigest: 'e'.repeat(64), status: 'merged', candidate, conflicts: [], truncated: false };
  assert.equal(parseIntegrationReport(report).algorithm, input.algorithm);
  assert.throws(() => parseIntegrationReport({ ...report, algorithm: 'layerfs-three-way-v99' }));
});
