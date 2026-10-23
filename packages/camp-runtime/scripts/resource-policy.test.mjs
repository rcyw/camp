import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, statfs, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resourcePolicy, checkedResourcePolicy, storageCapacity, enforceAgentPolicy } from '../src/resource-policy.mjs';

test('operator resource bounds reject ambiguous units and unbounded execution', () => {
  const policy = resourcePolicy({}); assert.deepEqual(checkedResourcePolicy(policy), policy);
  for (const env of [{ CAMP_AGENT_CPU_MILLIS: '0' }, { CAMP_AGENT_MEMORY_MIB: '511' }, { CAMP_AGENT_PIDS_LIMIT: '0' }, { CAMP_MIN_FREE_MIB: '63' }, { CAMP_AGENT_MEMORY_MIB: '1e3' }, { CAMP_AGENT_CPU_MILLIS: '2000.5' }]) assert.throws(() => resourcePolicy(env));
  assert.throws(() => checkedResourcePolicy({ ...policy, memoryBytes: policy.memoryBytes + 1 }));
  assert.throws(() => checkedResourcePolicy({ ...policy, privileged: true }));
});
test('capacity admission checks both storage roots and rejects the low filesystem before allocation', async () => {
  const runtime = { home: '/state', dockerCall: async () => ({ stdout: JSON.stringify('/docker') }) };
  const seen = [];
  await assert.rejects(storageCapacity(runtime, resourcePolicy({}), { filesystem: async path => { seen.push(path); return { bavail: path === '/docker' ? 1n : 2n ** 40n, bsize: 4096n }; } }), { code: 'camp_capacity_low' });
  assert.deepEqual(seen, ['/state', '/docker']);
});
test('agent execution requires Docker to report the exact applied cgroups', async () => {
  const policy = resourcePolicy({}); const commands = [];
  const facts = { NanoCpus: policy.cpuMillis * 1000000, Memory: policy.memoryBytes, MemorySwap: policy.memoryBytes, PidsLimit: policy.pidsLimit };
  const runtime = { dockerCall: async args => { commands.push(args); return { stdout: JSON.stringify(facts) }; } };
  const receipt = await enforceAgentPolicy(runtime, 'a'.repeat(64), policy);
  assert.equal(commands[0][0], 'update'); assert.equal(receipt.observed.pidsLimit, 256);
  facts.MemorySwap = -1;
  await assert.rejects(enforceAgentPolicy(runtime, 'a'.repeat(64), policy), { code: 'camp_resource_enforcement_failed' });
});
test('first-start capacity inspects an existing parent without creating a runtime home', async () => {
  const runtime = { home: '/new/deployment/state', dockerCall: async () => ({ stdout: JSON.stringify('/docker') }) };
  const seen = [];
  const result = await storageCapacity(runtime, resourcePolicy({}), { filesystem: async path => {
    seen.push(path);
    if (path !== '/new' && path !== '/docker') throw Object.assign(new Error('Missing directory'), { code: 'ENOENT' });
    return { bavail: 2n ** 40n, bsize: 4096n };
  } });
  assert.deepEqual(seen, ['/new/deployment/state', '/new/deployment', '/new', '/docker']);
  assert.equal(result.checkedFilesystems, 2);
});
test('capacity never hides missing Docker storage or non-ENOENT home failures', async () => {
  for (const home of ['/state', '/docker']) {
    const seen = [];
    await assert.rejects(storageCapacity({ home, dockerCall: async () => ({ stdout: JSON.stringify('/docker') }) }, resourcePolicy({}), { filesystem: async path => {
      seen.push(path);
      if (path === '/docker') throw Object.assign(new Error('Missing Docker directory'), { code: 'ENOENT' });
      return { bavail: 2n ** 40n, bsize: 4096n };
    } }), error => error.code === 'camp_capacity_unavailable' && error.status === 409 && error.cause.code === 'ENOENT');
    assert(!seen.includes('/'), 'An absent Docker root must not fall back to its parent');
  }
  await assert.rejects(storageCapacity({ home: '/private', dockerCall: async () => ({ stdout: JSON.stringify('/docker') }) }, resourcePolicy({}), { filesystem: async () => { throw Object.assign(new Error('Unreadable'), { code: 'EACCES' }); } }), error => error.code === 'camp_capacity_unavailable' && error.cause.code === 'EACCES');
});
test('a real missing home remains absent after its capacity is checked', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'camp-capacity-first-start-'));
  const home = join(parent, 'not-created', 'state');
  try {
    const result = await storageCapacity({ home, dockerCall: async () => ({ stdout: JSON.stringify(parent) }) }, resourcePolicy({}), { filesystem: async (path, options) => {
      const actual = await statfs(path, options);
      return { ...actual, bavail: 2n ** 40n };
    } });
    assert.equal(result.checkedFilesystems, 2);
    await assert.rejects(access(join(parent, 'not-created')), { code: 'ENOENT' });
  } finally { await rm(parent, { recursive: true, force: true }); }
});
test('Docker capacity errors have a stable code without serializing private diagnostics', async () => {
  const cause = Object.assign(new Error('Private host path and Docker stderr'), { code: 1, stderr: 'private-fixture-value' });
  await assert.rejects(storageCapacity({ home: '/state', dockerCall: async () => { throw cause; } }, resourcePolicy({})), error => {
    assert.equal(error.code, 'camp_capacity_unavailable'); assert.equal(error.status, 409); assert.equal(error.cause, cause);
    assert.equal(error.message, 'Camp storage capacity cannot be checked');
    assert(!JSON.stringify(error).includes('private-fixture-value'));
    return true;
  });
});
