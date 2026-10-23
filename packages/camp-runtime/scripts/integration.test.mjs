import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, lstat, access, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { runTrustedIntegration, recoverTrustedIntegration } from '../src/integration.mjs';
import { inventoryIntegrationTree, planIntegrationTree, treeDigest } from '../src/integration-tree.mjs';
import { parseIntegrationReport } from '../../camp-protocol/src/index.js';
import { receiveSnapshot } from '../src/safe-export.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(options = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'camp-integration-'));
  const directories = {};
  for (const name of ['base', 'left', 'right', 'output']) { directories[name] = join(folder, name); await mkdir(directories[name], { mode: 0o755 }); }
  for (const directory of Object.values(directories)) {
    await writeFile(join(directory, 'a.txt'), 'base A\n'); await writeFile(join(directory, 'b.txt'), 'base B\n');
    await writeFile(join(directory, 'binary'), Buffer.from([0, 1, 2])); await writeFile(join(directory, 'mode'), 'same bytes');
    await writeFile(join(directory, 'deleted'), 'remove me\n');
  }
  await writeFile(join(directories.left, 'a.txt'), 'left A\n'); await writeFile(join(directories.right, 'b.txt'), 'right B\n');
  await writeFile(join(directories.output, 'a.txt'), 'left A\n'); await writeFile(join(directories.output, 'b.txt'), 'right B\n');
  const candidates = {}, nodes = new Map(), branches = new Map(), calls = [], events = [];
  const project = { projectId: `p-${'a'.repeat(16)}`, imageId: `sha256:${'b'.repeat(64)}` };
  const layer = `32${'1'.repeat(64)}`;
  const input = { schemaVersion: 1, algorithm: 'layerfs-three-way-v1', policy: 'reject-overlap-v1', base: null, parents: [] };
  const runtime = {
    home: join(folder, 'state'),
    runIdentity(runId) { const short = digest(runId).slice(0, 16); return { runId, prefix: `camp-mvp-run-${short}-`, folder: join(this.home, 'runs', short) }; },
    async loadProject(id) { assert.equal(id, project.projectId); return project; },
    async verifyCandidate(_project, candidate) { assert.equal(nodes.get(candidate.refId)?.rootId, candidate.rootId); return candidate; },
    async sdk(_project, method, args) {
      calls.push({ method, args });
      if (method === 'project.branch_info') {
        const item = branches.get(args[0]);
        return { items: item ? [{ name: args[0], base: layer, head: item.refKind === 'commit' ? item.refId : null, forkedFrom: item.forkedFrom }] : [], hasMore: false, nextPagePos: null };
      }
      if (method === 'branch.fork') {
        if (options.forkFailure) throw Object.assign(new Error('Native reply lost'), { code: 'Unknown' });
        assert(!branches.has(args[0]));
        const node = nodes.get(args[1]); assert(node);
        branches.set(args[0], { ...node, forkedFrom: args[1] }); return { kind: 'Forked', head: node.refKind === 'commit' ? node.refId : null, base: layer };
      }
      if (method === 'branch.list_commits') {
        const node = branches.get(args[0]);
        const row = { id: node.refId, root: node.rootId, parent: options.badLineage ? `12${'9'.repeat(64)}` : options.baseCommit ? candidates.base.refId : null, secondParent: null, base: layer };
        const baseline = { id: candidates.base.refId, root: candidates.base.rootId, parent: `12${'8'.repeat(64)}`, secondParent: `12${'9'.repeat(64)}`, base: layer };
        return { items: options.baseCommit ? [row, baseline] : [row], hasMore: false, nextPagePos: null };
      }
      if (method === 'branch.merge') {
        assert.deepEqual(args[4], [], 'No merge units can enter the trusted operation');
        if (options.nativeConflict) throw Object.assign(new Error('Native conflict'), { code: 'Conflict', detail: { conflicts: [{ path: '/binary', kind: 'binary' }], conflictsTruncated: false } });
        const output = nodes.get(candidates.output.refId);
        branches.set(args[2], { ...output, forkedFrom: candidates.left.refId });
        if (options.nativeUnknown) throw Object.assign(new Error('Merge committed but response was lost'), { code: 'Unknown', cleanupKnown: false });
        return { kind: 'Merged', branch: args[2], head: output.refId, root: output.rootId, fastForward: false, mergeBase: options.wrongBase ? `32${'9'.repeat(64)}` : candidates.base.refId, sources: [{ ref: args[0], node: candidates.left.refId }, { ref: args[1], node: candidates.right.refId }], conflicts: [], lww: options.lww ? [{ path: '/a.txt', keptOurs: true }] : [], units: [], conflictsTruncated: false, lwwTruncated: false, unitsTruncated: false };
      }
      throw new Error('Unexpected SDK method ' + method);
    },
    async cleanupAttempt(prefix) { events.push('cleanup'); assert.equal(prefix, ownerRun.prefix); if (options.cleanupFailure) throw new Error('Docker cleanup unavailable'); },
  };
  const ownerRun = runtime.runIdentity(randomUUID() + '-e1');
  async function refresh() {
    nodes.clear();
    for (const [index, name] of ['base', 'left', 'right', 'output'].entries()) {
      const refKind = name === 'base' && !options.baseCommit ? 'layer' : 'commit', refId = refKind === 'layer' ? layer : `12${String(index + 1).repeat(64)}`;
      const candidate = { type: 'layerfs', ...project, refKind, refId, ...(refKind === 'commit' ? { commitId: refId } : { layerId: refId }), rootId: treeDigest(await inventoryIntegrationTree(directories[name])) };
      candidates[name] = candidate; nodes.set(refId, candidate);
    }
    input.base = candidates.base;
    input.parents = ['left', 'right'].map((key, index) => ({ key, runId: input.parents[index]?.runId ?? randomUUID(), epoch: 1, candidate: candidates[key] }));
  }
  await refresh();
  const materialize = async ({ candidate, output }) => {
    const source = Object.keys(candidates).find(key => candidates[key].refId === candidate.refId);
    assert(source); await cp(directories[source], output, { recursive: true, dereference: false });
  };
  const run = extra => runTrustedIntegration({ runtime, ownerRun, integrationInput: input, materialize, onResult: async value => { events.push('staged'); assert.deepEqual(parseIntegrationReport(value), value); await access(join(ownerRun.folder, 'integration-base')); }, ...extra });
  return { folder, directories, candidates, input, runtime, ownerRun, events, calls, branches, refresh, run, async close() { await rm(folder, { recursive: true, force: true }); } };
}
test('complete disjoint binary, deletion and mode facts survive integration before cleanup', async () => {
  const f = await fixture();
  try {
    for (const key of ['left', 'output']) { await writeFile(join(f.directories[key], 'binary'), Buffer.from([0, 9, 8])); await rm(join(f.directories[key], 'deleted')); }
    for (const key of ['right', 'output']) await chmod(join(f.directories[key], 'mode'), 0o751);
    await f.refresh();
    const value = await f.run();
    assert.equal(value.status, 'merged'); assert.deepEqual(value.candidate, { ...f.candidates.output, baseRef: f.input.base.refId, branch: [...f.branches.keys()].find(name => name.endsWith('-out')) });
    assert(f.events.indexOf('staged') < f.events.indexOf('cleanup'));
    await assert.rejects(access(join(f.ownerRun.folder, 'integration-result')));
    const recovered = await recoverTrustedIntegration({ runtime: f.runtime, ownerRun: f.ownerRun, integrationInput: f.input });
    assert.equal(recovered.status, 'validated'); assert.deepEqual(recovered.report, value);
    const mergeCount = f.calls.filter(call => call.method === 'branch.merge').length;
    const replay = await f.run({ onResult: value => { assert.equal(value.status, 'merged'); } });
    assert.deepEqual(replay, value); assert.equal(f.calls.filter(call => call.method === 'branch.merge').length, mergeCount);
  } finally { await f.close(); }
});
test('the exact baseline may itself be a merge Commit with a second parent', async () => {
  const f = await fixture({ baseCommit: true });
  try {
    const value = await f.run();
    assert.equal(value.status, 'merged'); assert.equal(value.candidate.baseRef, f.input.base.refId);
    assert.equal(f.calls.filter(call => call.method === 'branch.list_commits').length, 2);
    assert.equal((await recoverTrustedIntegration({ runtime: f.runtime, ownerRun: f.ownerRun, integrationInput: f.input })).status, 'validated');
  } finally { await f.close(); }
});
for (const type of ['file', 'directory', 'symlink']) test(`any .lww ${type} is rejected before a native integration mutation`, async () => {
  const f = await fixture();
  try {
    const path = join(f.directories.left, '.lww');
    if (type === 'file') await writeFile(path, '*\n'); else if (type === 'directory') await mkdir(path); else await symlink('/outside/secret', path);
    await f.refresh();
    const value = await f.run();
    assert.equal(value.status, 'rejected'); assert.equal(value.conflicts[0].reason, 'policy_path');
    assert.equal(f.calls.some(call => ['branch.fork', 'branch.merge'].includes(call.method)), false);
  } finally { await f.close(); }
});
test('same-path writes and delete/modify conflicts never call native merge', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directories.right, 'a.txt'), 'another A\n'); await f.refresh();
    const value = await f.run(); assert.equal(value.status, 'conflict'); assert(value.conflicts.some(item => item.path === 'a.txt' && item.reason === 'overlap'));
    assert.equal(f.calls.some(call => call.method === 'branch.merge'), false);
  } finally { await f.close(); }
});
test('snapshot admission limits produce a durable rejection before any native mutation', async () => {
  const f = await fixture();
  try {
    const value = await f.run({ onResult: value => { f.events.push('staged'); assert.equal(value.status, 'rejected'); }, materialize: async ({ output, maxBytes, maxEntries }) => {
      assert.equal(maxBytes, 512 * 1024 ** 2); assert.equal(maxEntries, 19999);
      await mkdir(output);
      try {
        await receiveSnapshot(Readable.from([
          { type: 'root', mode: 0o700 },
          { type: 'file', path: 'too-large', mode: 0o600, size: maxBytes + 1 },
        ].map(frame => JSON.stringify(frame) + '\n')), output, { maxBytes, maxEntries });
      } finally { await rm(output, { recursive: true, force: true }); }
    } });
    assert.equal(value.status, 'rejected'); assert.equal(value.candidate, null);
    assert.deepEqual(value.conflicts, [{ path: '.', reason: 'unsupported' }]);
    assert.equal(f.calls.some(call => ['branch.fork', 'branch.merge'].includes(call.method)), false);
    assert.equal((await recoverTrustedIntegration({ runtime: f.runtime, ownerRun: f.ownerRun, integrationInput: f.input })).status, 'validated');
  } finally { await f.close(); }
});
test('directory deletion against a new descendant is a structural conflict', async () => {
  const f = await fixture();
  try {
    for (const key of ['base', 'right']) { await mkdir(join(f.directories[key], 'dir')); await writeFile(join(f.directories[key], 'dir/old'), 'old'); }
    await writeFile(join(f.directories.right, 'dir/new'), 'new'); await f.refresh();
    const value = await f.run(); assert.equal(value.status, 'conflict'); assert(value.conflicts.some(item => item.path === 'dir' && item.reason === 'delete_modify'));
    assert.equal(f.calls.some(call => call.method === 'branch.merge'), false);
  } finally { await f.close(); }
});
test('a successful native response cannot hide a dropped sibling file', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directories.output, 'b.txt'), 'base B\n'); await f.refresh();
    const value = await f.run(); assert.equal(value.status, 'rejected'); assert.equal(value.candidate, null); assert(value.conflicts.some(item => item.path === 'b.txt'));
  } finally { await f.close(); }
});
for (const option of ['wrongBase', 'lww', 'badLineage']) test(`${option} cannot authorize an integrated candidate`, async () => {
  const f = await fixture({ [option]: true });
  try { const value = await f.run(); assert.equal(value.status, 'rejected'); assert.equal(value.candidate, null); }
  finally { await f.close(); }
});
test('native conflict is a durable explicit report and creates no accepted output', async () => {
  const f = await fixture({ nativeConflict: true });
  try {
    const value = await f.run(); assert.equal(value.status, 'conflict'); assert.deepEqual(value.conflicts, [{ path: 'binary', reason: 'overlap' }]);
    assert.equal((await recoverTrustedIntegration({ runtime: f.runtime, ownerRun: f.ownerRun, integrationInput: f.input })).status, 'validated');
  } finally { await f.close(); }
});
test('lost native success is fenced for inspection without a second merge', async () => {
  const f = await fixture({ nativeUnknown: true });
  try {
    await assert.rejects(f.run(), error => error.code === 'camp_integration_inspection_required' && error.requiresInspection && error.cleanupKnown);
    const before = f.calls.length;
    const recovered = await recoverTrustedIntegration({ runtime: f.runtime, ownerRun: f.ownerRun, integrationInput: f.input });
    assert.equal(recovered.status, 'requires_inspection'); assert.equal(f.calls.length, before);
    await assert.rejects(f.run(), { code: 'camp_integration_inspection_required' });
    assert.equal(f.calls.filter(call => call.method === 'branch.merge').length, 1);
    assert.equal(f.events.includes('staged'), false);
  } finally { await f.close(); }
});
test('native receipt without final validation cannot be replayed as success', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ onIntent: value => { if (value.phase === 'native_result') throw new Error('Interrupted after native result'); } }), /Interrupted/);
    assert.equal((await recoverTrustedIntegration({ runtime: f.runtime, ownerRun: f.ownerRun, integrationInput: f.input })).status, 'requires_inspection');
    assert.equal(f.events.includes('staged'), false);
  } finally { await f.close(); }
});
test('NameTaken, changed immutable input and a foreign owner are never adopted', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ onIntent: value => { if (value.phase === 'forking_left') f.branches.set(value.branches.left, { ...f.candidates.left, forkedFrom: f.candidates.left.refId }); } }), { code: 'camp_integration_inspection_required' });
    assert.equal(f.calls.some(call => call.method === 'branch.merge'), false);
    const changed = structuredClone(f.input); changed.parents[0].key = 'different';
    await assert.rejects(recoverTrustedIntegration({ runtime: f.runtime, ownerRun: f.ownerRun, integrationInput: changed }), { code: 'camp_integration_inspection_required' });
    const cleanups = f.events.length;
    await assert.rejects(runTrustedIntegration({ runtime: f.runtime, ownerRun: { ...f.ownerRun, prefix: 'foreign' }, integrationInput: f.input }), /owner differs/);
    assert.equal(f.events.length, cleanups);
  } finally { await f.close(); }
});
test('cleanup failure retains staged exact result and does not return a successful run', async () => {
  const f = await fixture({ cleanupFailure: true });
  try {
    await assert.rejects(f.run(), error => error.code === 'camp_integration_cleanup_failed' && error.cleanupKnown === false);
    assert(f.events.includes('staged'));
    const recovered = await recoverTrustedIntegration({ runtime: f.runtime, ownerRun: f.ownerRun, integrationInput: f.input }); assert.equal(recovered.status, 'validated');
  } finally { await f.close(); }
});
test('opaque symlinks are facts and traversal never reads their external target', async () => {
  const f = await fixture();
  try {
    await symlink('/outside/private-file', join(f.directories.left, 'link'));
    const left = await inventoryIntegrationTree(f.directories.left);
    assert.equal(left.get('link').target, '/outside/private-file'); assert.equal(left.has('link/private-file'), false);
    const base = await inventoryIntegrationTree(f.directories.base), right = await inventoryIntegrationTree(f.directories.right);
    assert.equal(planIntegrationTree(base, left, right).status, 'ready');
    const path = join(f.directories.left, 'a.txt'); const bytes = await readFile(path); assert.equal(bytes.toString(), 'left A\n');
    assert.equal((await lstat(join(f.directories.left, 'link'))).isSymbolicLink(), true);
  } finally { await f.close(); }
});
