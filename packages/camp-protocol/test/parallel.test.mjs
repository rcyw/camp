import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkerDeclaration, createPluginDeclaration, parseWorkerDeclaration, parseExecutionPool, serializeExecutionPool, getTaskRequirements, getPluginTaskRequirements, checkWorkerCompatibility, parsePlanMode, CAMP_CAPABILITIES_V3 } from '../src/index.js';
const pool = { poolId: '11111111-1111-4111-8111-111111111111', storageId: 'a'.repeat(64), maxParallel: 2, workerIds: ['lane-1', 'lane-2'], resources: { maxContainers: 4, cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3, pidsLimit: 1024 } };
test('v4 requires the trusted two-lane pool while model plugins receive only model requirements', () => {
  assert.equal(parsePlanMode('parallel_pair'), 'parallel_pair'); assert.equal(CAMP_CAPABILITIES_V3.length, 10);
  const requirements = getTaskRequirements({ protocolVersion: 4, workflow: 'serial', taskKind: 'build' });
  assert.equal(requirements.executionPoolRequired, true); assert.ok(requirements.capabilities.includes('bounded-pair.v1'));
  assert.equal(checkWorkerCompatibility(createWorkerDeclaration(), requirements).code, 'pool_required');
  assert.equal(checkWorkerCompatibility({ ...createWorkerDeclaration(), executionPool: pool }, requirements).status, 'compatible');
  assert.equal(checkWorkerCompatibility({ ...createWorkerDeclaration(), executionPool: pool, protocolVersions: [1, 2, 3] }, requirements).code, 'protocol_unsupported');
  const modelRequirements = getPluginTaskRequirements(requirements);
  assert.equal('executionPoolRequired' in modelRequirements, false); assert.equal(modelRequirements.capabilities.includes('bounded-pair.v1'), false);
  assert.equal(checkWorkerCompatibility(createPluginDeclaration(), modelRequirements).status, 'compatible');
  assert.throws(() => getPluginTaskRequirements(getTaskRequirements({ protocolVersion: 4, workflow: 'serial', taskKind: 'integration' })));
});
test('pool declarations reject extra authority, duplicate lanes and impossible resource reservations', () => {
  for (const change of [{ maxParallel: 3 }, { workerIds: ['lane-1', 'lane-1'] }, { storageId: 'path/to/store' }, { hostPath: '/private' }, { poolId: 'not-uuid' }, { workerIds: ['lane-1'] }, { resources: { ...pool.resources, maxContainers: 2 } }, { resources: { ...pool.resources, cpuMillis: 499 } }, { resources: { ...pool.resources, memoryBytes: 1 } }, { resources: { ...pool.resources, pidsLimit: 0 } }]) assert.throws(() => parseExecutionPool({ ...pool, ...change }));
  const parsed = parseWorkerDeclaration({ ...createWorkerDeclaration(), executionPool: pool }); parsed.executionPool.workerIds.pop(); parsed.executionPool.resources.cpuMillis = 500;
  assert.equal(pool.workerIds.length, 2); assert.equal(pool.resources.cpuMillis, 4000);
  assert.equal(serializeExecutionPool({ resources: { pidsLimit: 1024, cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3, maxContainers: 4 }, workerIds: ['lane-1', 'lane-2'], maxParallel: 2, storageId: pool.storageId, poolId: pool.poolId }), serializeExecutionPool(pool));
});
test('whole-pool CPU reservations cover the existing four-container resource-policy range', () => {
  const maximum = { ...pool, resources: { ...pool.resources, cpuMillis: 4 * 64000 } };
  assert.equal(parseExecutionPool(maximum).resources.cpuMillis, 256000);
  assert.throws(() => parseExecutionPool({ ...maximum, resources: { ...maximum.resources, cpuMillis: 256001 } }));
});
