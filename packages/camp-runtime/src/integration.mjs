import { createHash } from 'node:crypto';
import { mkdir, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseIntegrationInput, serializeIntegrationInput, parseIntegrationReport, parseCandidate, CAMP_INTEGRATION_LIMITS } from '../../camp-protocol/src/index.js';
import { atomicJson, acquireWorkerLock } from './durable-state.mjs';
import { regularBytes } from './toolchain.mjs';
import { materializeCandidate } from './export.mjs';
import { removeOwnedDirectory, exportPath } from './safe-export.mjs';
import { integrationTreeLimits, inventoryIntegrationTree, planIntegrationTree, compareIntegrationTree, treeDigest } from './integration-tree.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const commitId = /^12[a-f0-9]{64}$/, layerId = /^32[a-f0-9]{64}$/;
const inspection = cause => Object.assign(new Error('Integration native outcome requires inspection; no mutation was retried', { cause }), { code: 'camp_integration_inspection_required', requiresInspection: true });
async function read(path, maximum = 1024 * 1024) {
  try { return JSON.parse(await regularBytes(path, maximum)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw inspection(error); }
}
function context(runtime, ownerRun, value) {
  const input = parseIntegrationInput(value), inputDigest = hash(serializeIntegrationInput(input));
  const identity = runtime.runIdentity(ownerRun.runId);
  if (identity.folder !== ownerRun.folder || identity.prefix !== ownerRun.prefix) throw new Error('Integration owner differs from its original attempt');
  const prefix = `ci-${hash(ownerRun.runId).slice(0, 16)}-${inputDigest.slice(0, 8)}`;
  return { input, inputDigest, identity, branches: { left: `${prefix}-left`, right: `${prefix}-right`, output: `${prefix}-out` }, message: `Camp integration ${ownerRun.runId} ${inputDigest}` };
}
function checkedIntent(value, selected) {
  if (!value || value.schemaVersion !== 1 || value.inputDigest !== selected.inputDigest || serializeIntegrationInput(value.input) !== serializeIntegrationInput(selected.input) || value.owner?.runId !== selected.identity.runId || value.owner.prefix !== selected.identity.prefix || JSON.stringify(value.branches) !== JSON.stringify(selected.branches) || typeof value.mutationStarted !== 'boolean') throw inspection();
  return value;
}
function report(selected, status, conflicts = [], candidate = null) {
  const rows = [...new Map(conflicts.map(item => [item.path, item])).values()];
  const result = { schemaVersion: 1, inputDigest: selected.inputDigest, algorithm: selected.input.algorithm, policy: selected.input.policy, status, candidate, conflicts: rows.slice(0, CAMP_INTEGRATION_LIMITS.maxConflicts), truncated: rows.length > CAMP_INTEGRATION_LIMITS.maxConflicts };
  while (Buffer.byteLength(JSON.stringify(result)) > CAMP_INTEGRATION_LIMITS.maxPayloadBytes && result.conflicts.length > 1) { result.conflicts.pop(); result.truncated = true; }
  return parseIntegrationReport(result);
}
async function branchInfo(runtime, project, name, signal) {
  const answer = await runtime.sdk(project, 'project.branch_info', [name], project, { signal });
  if (!answer || !Array.isArray(answer.items) || answer.items.length > 1 || answer.hasMore || answer.nextPagePos !== null) throw inspection();
  const item = answer.items[0];
  if (!item) return null;
  if (item.name !== name || !layerId.test(item.base ?? '') || !(item.head === null || commitId.test(item.head ?? ''))) throw inspection();
  return item;
}
function atCandidate(item, candidate) {
  return item && (item.head ?? item.base) === candidate.refId;
}
function nativeSafe(reply, selected) {
  const parents = selected.input.parents;
  return reply?.kind === 'Merged' && reply.branch === selected.branches.output && reply.mergeBase === selected.input.base.refId
    && Array.isArray(reply.sources) && reply.sources.length === 2 && reply.sources.every((item, index) => item.ref === selected.branches[index === 0 ? 'left' : 'right'] && item.node === parents[index].candidate.refId)
    && ['conflicts', 'lww', 'units'].every(key => Array.isArray(reply[key]) && !reply[key].length)
    && ['conflictsTruncated', 'lwwTruncated', 'unitsTruncated'].every(key => reply[key] === false);
}
async function firstParentLine(runtime, project, branch, candidate, base, signal) {
  if (candidate.refKind === 'layer') return candidate.refId === base.refId ? new Set([base.refId]) : null;
  const line = new Set(); let position = 0, next = candidate.refId;
  while (line.size < 4096) {
    const page = await runtime.sdk(project, 'branch.list_commits', [branch, 128, position], project, { signal });
    if (!page || !Array.isArray(page.items) || !page.items.length) return null;
    for (const item of page.items) {
      if (item.id !== next || !commitId.test(item.id ?? '') || line.has(item.id)) return null;
      if (!line.size && item.root !== candidate.rootId) return null;
      line.add(item.id);
      if (item.id === base.refId) return item.root === base.rootId ? line : null;
      if (item.secondParent !== null || (base.refKind === 'layer' && item.base !== base.refId)) return null;
      if (item.parent === null) return base.refKind === 'layer' && item.base === base.refId ? line.add(base.refId) : null;
      if (!commitId.test(item.parent ?? '')) return null;
      next = item.parent;
      if (line.size >= 4096) return null;
    }
    if (!page.hasMore || !Number.isSafeInteger(page.nextPagePos) || page.nextPagePos <= position) return null;
    position = page.nextPagePos;
  }
  return null;
}

/** Reads persisted validation and exact immutable metadata. It never forks,
 * merges, mounts, publishes, stages an outbox or changes a local receipt. */
export async function recoverTrustedIntegration({ runtime, ownerRun, integrationInput, signal }) {
  const selected = context(runtime, ownerRun, integrationInput);
  const intent = await read(join(ownerRun.folder, 'integration-intent.json'));
  const raw = await read(join(ownerRun.folder, 'integration-result.json'), CAMP_INTEGRATION_LIMITS.maxPayloadBytes);
  const validation = await read(join(ownerRun.folder, 'integration-validation.json'));
  const native = await read(join(ownerRun.folder, 'integration-native-result.json'));
  if (!intent) return raw || validation || native ? { status: 'requires_inspection', phase: 'orphan_result' } : { status: 'missing' };
  checkedIntent(intent, selected);
  if (raw && validation) {
    const value = parseIntegrationReport(raw);
    if (validation.schemaVersion !== 1 || value.inputDigest !== selected.inputDigest || validation.inputDigest !== selected.inputDigest || validation.ownerRunId !== ownerRun.runId || validation.reportDigest !== hash(JSON.stringify(value)) || (value.status === 'merged' && (!/^[a-f0-9]{64}$/.test(validation.expectedTreeDigest ?? '') || validation.actualTreeDigest !== validation.expectedTreeDigest || !nativeSafe(native, selected) || validation.nativeDigest !== hash(JSON.stringify(native)) || native.root !== value.candidate.rootId || (native.head !== null && native.head !== value.candidate.refId)))) throw inspection();
    if (value.candidate) {
      const project = await runtime.loadProject(selected.input.base.projectId);
      await runtime.verifyCandidate(project, value.candidate, { signal });
      const output = await branchInfo(runtime, project, selected.branches.output, signal);
      if (!atCandidate(output, value.candidate) || output.forkedFrom !== selected.input.parents[0].candidate.refId) throw inspection();
    }
    return { status: 'validated', report: value };
  }
  if (!intent.mutationStarted && !raw && !validation && !native && ['materializing', 'preflight'].includes(intent.phase)) return { status: 'preparing', phase: intent.phase };
  return { status: 'requires_inspection', phase: intent.phase };
}

/** Exactly two candidates; no model, shell merge, display patch or publication. */
export async function runTrustedIntegration({ runtime, ownerRun, integrationInput, signal, onResult = () => {}, onIntent = () => {}, materialize = materializeCandidate }) {
  const selected = context(runtime, ownerRun, integrationInput);
  const lock = await acquireWorkerLock(`integration:${runtime.home}:${ownerRun.runId}`, { root: join(tmpdir(), `camp-integration-locks-${process.getuid()}`), signal });
  const owned = []; let cleaned = false, failed, result;
  try {
    result = await (async () => {
    await mkdir(ownerRun.folder, { recursive: true, mode: 0o700 });
    const recovered = await recoverTrustedIntegration({ runtime, ownerRun, integrationInput, signal });
    if (recovered.status === 'validated') { await onResult(recovered.report); return recovered.report; }
    if (recovered.status === 'requires_inspection') throw inspection();
    if (recovered.status === 'preparing') await runtime.cleanupAttempt(ownerRun.prefix);
    const intent = { schemaVersion: 1, inputDigest: selected.inputDigest, input: selected.input, owner: { runId: ownerRun.runId, prefix: ownerRun.prefix }, branches: selected.branches, phase: 'materializing', mutationStarted: false };
    const persist = async (phase, mutationStarted = intent.mutationStarted) => {
      Object.assign(intent, { phase, mutationStarted });
      await atomicJson(join(ownerRun.folder, 'integration-intent.json'), intent);
      if (mutationStarted) await onIntent({ ...intent });
    };
    await persist('materializing');
    const finish = async (value, proof = {}) => {
      const validation = { schemaVersion: 1, inputDigest: selected.inputDigest, ownerRunId: ownerRun.runId, reportDigest: hash(JSON.stringify(value)), ...proof };
      await atomicJson(join(ownerRun.folder, 'integration-validation.json'), validation);
      await atomicJson(join(ownerRun.folder, 'integration-result.json'), value);
      await persist('validated');
      await onResult(value);
      return value;
    };
    const project = await runtime.loadProject(selected.input.base.projectId);
    for (const candidate of [selected.input.base, ...selected.input.parents.map(parent => parent.candidate)]) await runtime.verifyCandidate(project, candidate, { signal });
    const snapshots = [];
    for (const [index, candidate] of [selected.input.base, ...selected.input.parents.map(parent => parent.candidate)].entries()) {
      const directory = join(ownerRun.folder, ['integration-base', 'integration-left', 'integration-right'][index]);
      try {
        // Snapshot transport counts descendants; the integration tree bound
        // also includes the root. Reject at admission, before native mutation.
        await materialize({ runtime, candidate, ownerRun, output: directory, signal, maxBytes: integrationTreeLimits.maxBytes, maxEntries: integrationTreeLimits.maxEntries - 1 });
        owned.push({ directory, identity: await lstat(directory) });
        snapshots.push(await inventoryIntegrationTree(directory, { signal }));
      }
      catch (error) {
        if (!['camp_integration_unsupported', 'camp_snapshot_limit_exceeded'].includes(error.code)) throw error;
        return await finish(report(selected, 'rejected', [{ path: error.path ?? '.', reason: 'unsupported' }]));
      }
    }
    await persist('preflight');
    const plan = planIntegrationTree(...snapshots);
    if (plan.status !== 'ready') return await finish(report(selected, plan.status, plan.conflicts));
    for (const [index, key] of ['left', 'right'].entries()) {
      await persist(`forking_${key}`, true);
      if (await branchInfo(runtime, project, selected.branches[key], signal)) throw inspection();
      try { await runtime.sdk(project, 'branch.fork', [selected.branches[key], selected.input.parents[index].candidate.refId], project, { signal }); }
      catch (error) { throw inspection(error); }
      if (!atCandidate(await branchInfo(runtime, project, selected.branches[key], signal), selected.input.parents[index].candidate)) throw inspection();
    }
    const lines = [];
    for (const [index, key] of ['left', 'right'].entries()) lines.push(await firstParentLine(runtime, project, selected.branches[key], selected.input.parents[index].candidate, selected.input.base, signal));
    if (lines.some(line => !line) || [...lines[0]].some(id => id !== selected.input.base.refId && lines[1].has(id))) return await finish(report(selected, 'rejected', [{ path: '.', reason: 'unsupported' }]));
    if (await branchInfo(runtime, project, selected.branches.output, signal)) throw inspection();
    await persist('merging', true);
    let native;
    try { native = await runtime.sdk(project, 'branch.merge', [selected.branches.left, selected.branches.right, selected.branches.output, selected.message, []], project, { signal }); }
    catch (error) {
      if (error.code !== 'Conflict') throw inspection(error);
      await atomicJson(join(ownerRun.folder, 'integration-native-result.json'), { refused: { code: 'Conflict', detail: error.detail ?? null } });
      const conflicts = (error.detail?.conflicts ?? []).map(item => {
        let path; try { path = exportPath(item.path.replace(/^\//, '')); } catch { path = '.'; }
        return { path, reason: ['modify/delete', 'delete/modify'].includes(item.kind) ? 'delete_modify' : item.kind === 'type' ? 'structural' : 'overlap' };
      });
      return await finish(report(selected, 'conflict', conflicts.length ? conflicts : [{ path: '.', reason: 'overlap' }]));
    }
    await atomicJson(join(ownerRun.folder, 'integration-native-result.json'), native);
    await persist('native_result', true);
    if (native?.kind !== 'Merged' || native.branch !== selected.branches.output || !(native.head === null || commitId.test(native.head ?? '')) || !/^[a-f0-9]{64}$/.test(native.root ?? '')) throw inspection();
    if (!nativeSafe(native, selected)) return await finish(report(selected, 'rejected', [{ path: '.', reason: 'structural' }]));
    const output = await branchInfo(runtime, project, selected.branches.output, signal);
    const reference = output?.head ?? output?.base;
    const candidate = parseCandidate({ type: 'layerfs', projectId: selected.input.base.projectId, imageId: selected.input.base.imageId, refKind: output?.head ? 'commit' : 'layer', refId: reference, ...(output?.head ? { commitId: reference } : { layerId: reference }), rootId: native.root, baseRef: selected.input.base.refId, branch: selected.branches.output });
    if (native.head !== output.head || output.forkedFrom !== selected.input.parents[0].candidate.refId) throw inspection();
    try { await runtime.verifyCandidate(project, candidate, { signal }); } catch (error) { throw inspection(error); }
    await persist('validating', true);
    const directory = join(ownerRun.folder, 'integration-result');
    await materialize({ runtime, candidate, ownerRun, output: directory, signal, maxBytes: integrationTreeLimits.maxBytes, maxEntries: integrationTreeLimits.maxEntries - 1 });
    owned.push({ directory, identity: await lstat(directory) });
    const actual = await inventoryIntegrationTree(directory, { signal });
    const mismatches = compareIntegrationTree(plan.expected, actual);
    if (mismatches.length) return await finish(report(selected, 'rejected', mismatches));
    return await finish(report(selected, 'merged', [], candidate), { expectedTreeDigest: plan.expectedDigest, actualTreeDigest: treeDigest(actual), nativeDigest: hash(JSON.stringify(native)) });
    })();
  } catch (error) { failed = error; }
  finally {
    try {
      await runtime.cleanupAttempt(ownerRun.prefix, { timeout: 5000 }); cleaned = true;
      for (const { directory, identity } of owned) { await removeOwnedDirectory(directory, identity); await rm(`${directory}.manifest.json`, { force: true }); }
    } catch (error) {
      failed ??= Object.assign(new Error('Integration resource cleanup was not confirmed', { cause: error }), { code: 'camp_integration_cleanup_failed' });
      failed.cleanupKnown = false;
    } finally {
      if (failed && failed.cleanupKnown !== false) failed.cleanupKnown = cleaned;
      await lock.release();
    }
  }
  if (failed) throw failed;
  return result;
}
