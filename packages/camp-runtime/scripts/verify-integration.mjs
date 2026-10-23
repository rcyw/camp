import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CampRuntime } from '../src/index.mjs';
import { runTrustedIntegration, recoverTrustedIntegration } from '../src/integration.mjs';
import { materializeCandidate } from '../src/export.mjs';
import { inventoryIntegrationTree, planIntegrationTree, compareIntegrationTree, treeDigest } from '../src/integration-tree.mjs';
import { defaultBundle, runtimePackage } from '../src/toolchain.mjs';

// No API, model, publication or shared Store is used. Every Docker resource
// belongs to the random project and exact attempt prefixes recorded below.
if (process.argv[2] === '--interrupt-child') {
  const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const runtime = await new CampRuntime(config.options).ready();
  await runTrustedIntegration({ runtime, ownerRun: config.ownerRun, integrationInput: config.input, onIntent: intent => { if (intent.phase === 'native_result') process.kill(process.pid, 'SIGKILL'); } });
  throw new Error('Expected a real interruption after the native merge receipt');
}
if (process.argv[2] !== '--real') throw new Error('Use --real for an isolated Docker/LayerFS integration proof');
const folder = await mkdtemp(join(tmpdir(), 'camp-integration-proof-'));
const image = JSON.parse(await readFile(join(runtimePackage, '.local/standard-image.json'), 'utf8'));
const options = { home: join(folder, 'state'), docker: process.env.CAMP_DOCKER_SOCKET ?? '/var/run/docker.sock', toolchainBundle: process.env.CAMP_TOOLCHAIN_BUNDLE ?? defaultBundle, imageId: process.env.CAMP_RUNTIME_IMAGE ?? image.imageId };
const runtime = await new CampRuntime(options).ready();
const namespace = `integration-proof-${randomUUID()}`, owners = [];
let project, receipt, sentinel;
const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('Integration proof deadline')), 360_000);
const signal = controller.signal;
const owner = () => { const identity = runtime.runIdentity(randomUUID() + '-e1'); owners.push(identity); return identity; };
const pair = (base, left, right, algorithm = 'layerfs-three-way-v1') => ({ schemaVersion: 1, algorithm, policy: 'reject-overlap-v1', base, parents: [{ key: 'left', runId: randomUUID(), epoch: 1, candidate: left }, { key: 'right', runId: randomUUID(), epoch: 1, candidate: right }] });
async function build(base, code) {
  const identity = owner(); let run;
  try {
    run = await runtime.prepareRun({ project, runId: identity.runId, roleId: 'builder', baseRef: base?.refId ?? 'main', signal });
    const input = await runtime.pinInputCandidate(run, base, { signal });
    if (code) {
      const exec = await runtime.dockerCall(['exec', '--user', '501:20', '--workdir', run.workspacePath, run.containerId, 'node', '-e', code], { signal });
      assert.equal(exec.stderr, '');
    }
    await runtime.quiesceAgent(run, { signal });
    const candidate = await runtime.commitCandidate(run, { signal });
    await runtime.releaseRun(run, { signal }); run = null;
    return { input, candidate };
  } finally { if (run) await runtime.cleanupAttempt(identity.prefix); }
}
async function tree(candidate) {
  const identity = owner(); await mkdir(identity.folder, { recursive: true, mode: 0o700 });
  const output = join(identity.folder, 'integration-result');
  try { await materializeCandidate({ runtime, candidate, ownerRun: identity, output, signal }); return await inventoryIntegrationTree(output, { signal }); }
  finally { await runtime.cleanupAttempt(identity.prefix); }
}
try {
  // A dedicated unrelated container stays alive while ordinary Workers are
  // free to complete and remove their own containers concurrently.
  sentinel = (await runtime.dockerCall(['run', '-d', '--network', 'none', '--read-only', '--user', '501:20', '--cap-drop', 'ALL', '--pids-limit', '16', '--memory', '128m', '--cpus', '0.1', '--name', `camp-integration-sentinel-${randomUUID()}`, options.imageId, 'node', '-e', 'setInterval(()=>{},60000)'], { signal })).stdout.trim();
  const source = join(folder, 'source'); await mkdir(source);
  await writeFile(join(source, 'a'), 'base A\n'); await writeFile(join(source, 'b'), 'base B\n');
  await writeFile(join(source, 'binary'), Buffer.from([0, 1, 2])); await writeFile(join(source, 'deleted'), 'remove\n');
  await writeFile(join(source, 'mode'), 'unchanged bytes\n'); await chmod(join(source, 'mode'), 0o644);
  project = await runtime.prepareProject({ projectId: namespace, sourcePath: source, signal });
  const base = (await build(null)).candidate; assert.equal(base.refKind, 'layer');
  const left = (await build(base, "const fs=require('node:fs');fs.writeFileSync('a','left A\\n');fs.writeFileSync('binary',Buffer.from([0,9,8]));fs.unlinkSync('deleted');")).candidate;
  const right = (await build(base, "const fs=require('node:fs');fs.writeFileSync('b','right B\\n');fs.chmodSync('mode',0o751);")).candidate;
  const before = await Promise.all([base, left, right].map(tree));
  const input = pair(base, left, right), identity = owner(); let staged = 0;
  const merged = await runTrustedIntegration({ runtime, ownerRun: identity, integrationInput: input, signal, onResult: async report => { staged++; assert.equal(report.status, 'merged'); assert.equal((await inventoryIntegrationTree(join(identity.folder, 'integration-result'))).get('mode').mode, 0o751); } });
  assert.equal(staged, 1); assert.equal(merged.status, 'merged'); assert.equal(merged.candidate.baseRef, base.refId);
  const expected = planIntegrationTree(...before); assert.equal(expected.status, 'ready');
  const after = await tree(merged.candidate); assert.deepEqual(compareIntegrationTree(expected.expected, after), []);
  assert.equal(after.get('binary').sha256, before[1].get('binary').sha256); assert.equal(after.has('deleted'), false); assert.equal(after.get('mode').mode, 0o751);
  for (const [index, candidate] of [base, left, right].entries()) assert.equal(treeDigest(await tree(candidate)), treeDigest(before[index]), 'Input candidates remain immutable');
  const replay = await recoverTrustedIntegration({ runtime, ownerRun: identity, integrationInput: input, signal }); assert.deepEqual(replay, { status: 'validated', report: merged });
  const mergedHistory = await runtime.sdk(project, 'branch.list_commits', [merged.candidate.branch, 1, 0], project, { signal });
  assert.equal(mergedHistory.items[0].id, merged.candidate.refId); assert.equal(mergedHistory.items[0].secondParent, right.refId);
  const nextLeft = (await build(merged.candidate, "require('node:fs').writeFileSync('next-left','second goal left\\n')")).candidate;
  const nextRight = (await build(merged.candidate, "require('node:fs').writeFileSync('next-right','second goal right\\n')")).candidate;
  const continued = await runTrustedIntegration({ runtime, ownerRun: owner(), integrationInput: pair(merged.candidate, nextLeft, nextRight), signal });
  assert.equal(continued.status, 'merged'); assert.equal(continued.candidate.baseRef, merged.candidate.refId);
  const continuedTree = await tree(continued.candidate);
  assert(continuedTree.has('next-left')); assert(continuedTree.has('next-right'));
  assert.deepEqual(compareIntegrationTree(after, new Map([...continuedTree].filter(([path]) => !['next-left', 'next-right'].includes(path)))), []);
  assert.equal(continuedTree.get('binary').sha256, after.get('binary').sha256); assert.equal(continuedTree.get('mode').mode, 0o751); assert.equal(continuedTree.has('deleted'), false);
  assert.equal(treeDigest(await tree(merged.candidate)), treeDigest(after), 'The prior accepted merge remains immutable');
  const dagLeft = (await build(merged.candidate, "require('node:fs').writeFileSync('dag-left','after a prior integration\\n')")).candidate;
  const dagRight = (await build(left, "require('node:fs').writeFileSync('dag-right','after one shared ancestor\\n')")).candidate;
  const dagOwner = owner(), dagInput = pair(left, dagLeft, dagRight, 'layerfs-three-way-v2');
  const dag = await runTrustedIntegration({ runtime, ownerRun: dagOwner, integrationInput: dagInput, signal });
  assert.equal(dag.status, 'merged'); assert.equal(dag.candidate.baseRef, left.refId);
  const dagTree = await tree(dag.candidate);
  assert(dagTree.has('dag-left')); assert(dagTree.has('dag-right')); assert.equal(dagTree.get('b').sha256, after.get('b').sha256);
  const dagProof = JSON.parse(await readFile(join(dagOwner.folder, 'integration-ancestry.json')));
  assert.equal(dagProof.proof.mergeBase, left.refId); assert(dagProof.proof.nodes.some(node => node.id === right.refId));
  assert.equal((await recoverTrustedIntegration({ runtime, ownerRun: dagOwner, integrationInput: dagInput, signal })).status, 'validated');
  const reversed = await runTrustedIntegration({ runtime, ownerRun: owner(), integrationInput: pair(base, right, left), signal });
  assert.equal(reversed.status, 'merged');
  const crossRight = (await build(reversed.candidate, "require('node:fs').writeFileSync('dag-cross','other merge order\\n')")).candidate;
  const crossOwner = owner();
  const cross = await runTrustedIntegration({ runtime, ownerRun: crossOwner, integrationInput: pair(left, dagLeft, crossRight, 'layerfs-three-way-v2'), signal });
  assert.equal(cross.status, 'rejected'); assert(cross.conflicts.some(row => row.reason === 'unsupported'));
  const crossIntent = JSON.parse(await readFile(join(crossOwner.folder, 'integration-intent.json')));
  assert.equal((await runtime.sdk(project, 'project.branch_info', [crossIntent.branches.output], project, { signal })).items.length, 0, 'Ambiguous criss-cross never invokes native merge');
  const noopOwner = owner(), noopInput = pair(base, base, base);
  const noop = await runTrustedIntegration({ runtime, ownerRun: noopOwner, integrationInput: noopInput, signal });
  assert.equal(noop.status, 'merged'); assert.equal(noop.candidate.refKind, 'layer'); assert.equal(noop.candidate.refId, base.refId); assert.equal(noop.candidate.rootId, base.rootId);
  const overlapRight = (await build(base, "require('node:fs').writeFileSync('a','overlapping A\\n')")).candidate;
  const overlap = await runTrustedIntegration({ runtime, ownerRun: owner(), integrationInput: pair(base, left, overlapRight), signal });
  assert.equal(overlap.status, 'conflict'); assert(overlap.conflicts.some(row => row.path === 'a'));
  const deleteRight = (await build(base, "require('node:fs').writeFileSync('deleted','modified\\n')")).candidate;
  const deletion = await runTrustedIntegration({ runtime, ownerRun: owner(), integrationInput: pair(base, left, deleteRight), signal });
  assert.equal(deletion.status, 'conflict'); assert(deletion.conflicts.some(row => row.path === 'deleted' && row.reason === 'delete_modify'));
  const lwwRight = (await build(base, "require('node:fs').writeFileSync('.lww','*\\n')")).candidate;
  const lww = await runTrustedIntegration({ runtime, ownerRun: owner(), integrationInput: pair(base, left, lwwRight), signal });
  assert.equal(lww.status, 'rejected'); assert(lww.conflicts.some(row => row.reason === 'policy_path'));
  const interruptedOwner = owner(), childConfig = join(folder, 'interrupt.json');
  await writeFile(childConfig, JSON.stringify({ options, ownerRun: interruptedOwner, input }));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--interrupt-child', childConfig], { stdio: ['ignore', 'pipe', 'pipe'], signal });
  let childError = ''; child.stderr.on('data', data => { childError += data; }); child.stdout.resume();
  const exit = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, killedBy) => resolveExit({ code, signal: killedBy })); });
  assert.equal(exit.signal, 'SIGKILL', childError);
  const recovered = await recoverTrustedIntegration({ runtime, ownerRun: interruptedOwner, integrationInput: input, signal });
  assert.deepEqual(recovered, { status: 'requires_inspection', phase: 'native_result' });
  await assert.rejects(runTrustedIntegration({ runtime, ownerRun: interruptedOwner, integrationInput: input, signal }), error => error.code === 'camp_integration_inspection_required' && error.cleanupKnown);
  const intent = JSON.parse(await readFile(join(interruptedOwner.folder, 'integration-intent.json'), 'utf8'));
  const saved = await runtime.sdk(project, 'project.branch_info', [intent.branches.output], project, { signal }); assert.equal(saved.items.length, 1);
  receipt = { schemaVersion: 1, at: new Date().toISOString(), namespace, imageId: options.imageId, base, parents: [left, right], merged, continued, dag, proof: { nativeMerge: true, mergeCommitBaselineWithSecondParent: true, continuedPriorTreePreserved: true, dagSecondaryAncestry: true, dagSharedAncestorBase: true, dagValidatedRecovery: true, crissCrossRejectedBeforeMerge: true, layerNoop: true, immutableInputs: true, binaryPreserved: true, deletionPreserved: true, modePreserved: true, overlapRejected: true, deleteModifyRejected: true, lwwRejected: true, realSigkillAfterNative: true, ambiguousOutcomeNotRetried: true, stageBeforeCleanup: true }, modelCalls: 0 };
} finally {
  clearTimeout(timer);
  for (const identity of owners) await runtime.cleanupAttempt(identity.prefix);
  if (project) await runtime.dockerCall(['volume', 'rm', project.volume]);
  if (sentinel) {
    assert.equal((await runtime.dockerCall(['inspect', '--format', '{{.State.Running}}', sentinel])).stdout.trim(), 'true', 'Unrelated container remains alive');
    await runtime.dockerCall(['rm', '-f', sentinel]);
  }
  await rm(folder, { recursive: true, force: true });
  if (receipt) {
    receipt.ownResourcesRemoved = true; receipt.existingContainersPreserved = true;
    await writeFile(join(runtimePackage, '.local/integration-proof.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(receipt));
  }
}
