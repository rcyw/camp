// Explicit real-provider acceptance, isolated from the standing demo. The
// script never runs generated project code on the host or changes demo config.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CampRuntime } from '../../packages/camp-runtime/src/index.mjs';
import { exportCandidate } from '../../packages/camp-runtime/src/export.mjs';
import { parseCandidate, serializeIntegrationInput } from '../../packages/camp-protocol/src/index.js';
import { superviseOwnedChild } from './owned-child.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--real') throw new Error('Use --real to explicitly authorize this real DSH/provider acceptance. Stop the standing host manager first.');
const apiUrl = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018', webUrl = process.env.CAMP_WEB_URL ?? 'http://localhost:15190';
const image = JSON.parse(await readFile(process.env.CAMP_IMAGE_RECEIPT ?? 'packages/camp-runtime/.local/dag-image-0.7.0.json', 'utf8'));
assert.match(image.imageId ?? '', /^sha256:[a-f0-9]{64}$/); assert.match(image.toolchainDigest ?? '', /^[a-f0-9]{64}$/);
const bundle = resolve(process.env.CAMP_TOOLCHAIN_BUNDLE ?? 'packages/camp-runtime/.local/toolchain-bundle-dag-0.7.0');
const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const name = 'camp-dag-model-' + Date.now().toString(36), folder = resolve('.camp/dag-model', name), source = join(folder, 'project'), runtimeHome = join(folder, 'runtime');
await mkdir(source, { recursive: true, mode: 0o700 });
const originalFiles = {
  'package.json': JSON.stringify({ name, private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'foundation/index.js': 'export function normalizeName(value) { throw new Error("Implement normalizeName"); }\n',
  'foundation/index.test.js': 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { normalizeName } from "./index.js";\ntest("normalization contract", () => { assert.equal(normalizeName("  ALICE \\t SMITH  "), "alice smith"); assert.equal(normalizeName(""), ""); assert.equal(normalizeName("  \\n "), ""); });\ntest("normalization requires a string", () => { for (const input of [null, undefined, 1, {}, []]) assert.throws(() => normalizeName(input), TypeError); });\n',
  'left/index.js': 'import { normalizeName } from "../foundation/index.js";\nexport function greetName(value) { throw new Error("Implement greetName"); }\n',
  'left/index.test.js': 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greetName } from "./index.js";\ntest("greeting uses normalized foundation", () => { assert.equal(greetName("  ALICE \\t SMITH  "), "Hello, alice smith!"); assert.equal(greetName("  "), "Hello, stranger!"); });\ntest("greeting preserves foundation type validation", () => { assert.throws(() => greetName(null), TypeError); });\n',
  'right/index.js': 'import { normalizeName } from "../foundation/index.js";\nexport function slugName(value) { throw new Error("Implement slugName"); }\n',
  'right/index.test.js': 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { slugName } from "./index.js";\ntest("slug uses normalized foundation", () => { assert.equal(slugName("  ALICE \\t SMITH  "), "alice-smith"); assert.equal(slugName("  "), ""); });\ntest("slug preserves foundation type validation", () => { assert.throws(() => slugName(12), TypeError); });\n',
};
for (const directory of ['foundation', 'left', 'right']) await mkdir(join(source, directory), { mode: 0o755 });
for (const [path, content] of Object.entries(originalFiles)) await writeFile(join(source, path), content, { mode: 0o644 });
const protectedHashes = Object.fromEntries(Object.entries(originalFiles).filter(([path]) => !['foundation/index.js', 'left/index.js', 'right/index.js'].includes(path)).map(([path, content]) => [path, createHash('sha256').update(content).digest('hex')]));
const harnessPath = join(folder, 'dag-model-contract.mjs');
const harnessSource = [
  "import assert from 'node:assert/strict';",
  "import { createHash } from 'node:crypto';",
  "import { readFile, readdir } from 'node:fs/promises';",
  "import { normalizeName } from '/workspace/foundation/index.js';",
  "import { greetName } from '/workspace/left/index.js';",
  "import { slugName } from '/workspace/right/index.js';",
  `const expectedFiles = ${JSON.stringify(Object.keys(originalFiles).sort())};`,
  `const protectedHashes = ${JSON.stringify(protectedHashes)};`,
  "async function files(directory = '') { const result = []; for (const item of await readdir('/workspace/' + directory, { withFileTypes: true })) { const name = directory + item.name; assert.ok(item.isFile() || item.isDirectory(), 'No special or linked fixture files'); if (item.isDirectory()) result.push(...await files(name + '/')); else result.push(name); } return result.sort(); }",
  "assert.deepEqual(await files(), expectedFiles);",
  "for (const [path, digest] of Object.entries(protectedHashes)) assert.equal(createHash('sha256').update(await readFile('/workspace/' + path)).digest('hex'), digest, 'Protected fixture changed: ' + path);",
  "for (const [input, normalized] of [['  ALICE \\t SMITH  ', 'alice smith'], ['Bob\\nJONES', 'bob jones'], ['', ''], ['  ', '']]) { assert.equal(normalizeName(input), normalized); assert.equal(greetName(input), 'Hello, ' + (normalized || 'stranger') + '!'); assert.equal(slugName(input), normalized.replaceAll(' ', '-')); }",
  "for (const input of [null, undefined, 42, {}, []]) for (const method of [normalizeName, greetName, slugName]) assert.throws(() => method(input), TypeError);",
  "console.log('CAMP_DAG_MODEL_CONTRACT_PASSED');",
].join('\n') + '\n';
await writeFile(harnessPath, harnessSource, { mode: 0o400 });
const harness = { id: 'dag-model-contract', sha256: createHash('sha256').update(harnessSource).digest('hex') }, mappings = join(folder, 'harnesses.json');
await writeFile(mappings, JSON.stringify([{ id: harness.id, path: harnessPath }]), { mode: 0o600 });
const login = await fetch(apiUrl + '/api/auth/login', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }), signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 200); const auth = await login.json();
async function human(path, body, method) {
  const response = await fetch(apiUrl + '/api' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'error', headers: { authorization: 'Bearer ' + auth.accessToken, 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, `DAG model API rejected ${path} (${response.status})`); return response.json();
}
const identity = value => { const candidate = parseCandidate(value); return JSON.stringify([candidate.projectId, candidate.imageId, candidate.refKind, candidate.refId, candidate.rootId]); };
const dotenv = raw => { if (!/[\r\n"'`]/.test(raw)) return '"' + raw + '"'; if (!/[\r\n'`]/.test(raw)) return "'" + raw + "'"; if (!/[\r\n`]/.test(raw)) return '`' + raw + '`'; throw new Error('Unsupported quote characters in local fixture configuration'); };
let room, goal, owner, descriptor, interrupted = false, success = false, archived = false;
const interrupt = () => { interrupted = true; void owner?.stop({ graceMs: 30000 }).catch(() => {}); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt);
try {
  const created = await human('/channels/', { name, visibility: 'public', description: 'Real DSH bounded DAG: reviewed foundation, two terminal branches, trusted join and fixed external acceptance.' });
  const channelId = created.channel?.id ?? created.id;
  room = await human('/camp/rooms', { channelId, name, project: { name, repoPath: source } });
  await human(`/camp/rooms/${room.id}/verification-policy`, { expectedDigest: null, policy: { id: 'dag-model', revision: 1, name: 'All project tests and immutable DAG contract', maxRepairAttempts: 1, checks: [{ id: 'project', label: 'Full project suite', argv: ['node', '--test'], timeoutMs: 60000 }, { id: 'external', label: 'Foundation and both terminal module contracts', argv: ['node', '/camp-checks/dag-model-contract'], harness, timeoutMs: 30000 }] } }, 'PUT');
  const token = (await human(`/camp/rooms/${room.id}/worker-token`, {})).token, workerEnvPath = join(folder, 'worker.env');
  const environment = { CAMP_API_URL: apiUrl, CAMP_WORKER_ID: name, CAMP_WORKER_TOKEN: token, CAMP_RUNTIME_HOME: runtimeHome, CAMP_RUNTIME_IMAGE: image.imageId, CAMP_TOOLCHAIN_BUNDLE: bundle, CAMP_VERIFICATION_HARNESSES: mappings };
  await writeFile(workerEnvPath, Object.entries(environment).map(([key, raw]) => key + '=' + dotenv(raw)).join('\n') + '\n', { mode: 0o600 });
  const title = 'Implement a shared name foundation, greeting and slug as a three-node dependency graph';
  const description = [
    'Use bounded_dag with planRevision: 2 and exactly three task keys: foundation (dependsOnKeys: []), left (dependsOnKeys: ["foundation"]), right (dependsOnKeys: ["foundation"]). The two terminal tasks are independent after foundation approval. Submit this structure with camp_submit_plan; do not use an ordered revision-1 plan.',
    'foundation: only edit foundation/index.js. Implement normalizeName(value): require a string or throw TypeError, trim leading/trailing whitespace, collapse every internal whitespace sequence to one ASCII space, and lowercase. Empty and whitespace-only strings become empty.',
    'left: only edit left/index.js. Implement greetName(value) by calling normalizeName from ../foundation/index.js. Return "Hello, NAME!" using the normalized name, or "Hello, stranger!" for an empty normalized name. Preserve the foundation TypeError for non-string input.',
    'right: only edit right/index.js. Implement slugName(value) by calling normalizeName from ../foundation/index.js and replacing every remaining space with a hyphen. Preserve empty strings and the foundation TypeError for non-string input.',
    'Each builder must preserve all tests, package.json, and every other module. Do not add files, install dependencies, edit metadata, publish or call a model outside this workflow. The provided tests and a fixed external harness are protected acceptance inputs.',
    'Item reviewers must leave workspace files unchanged and run only the current item suite: node --test foundation/index.test.js, node --test left/index.test.js, or node --test right/index.test.js. Other independent terminal modules are intentionally unfinished in isolated branch candidates; do not reject a correct item because another branch is unfinished. Use camp_review for the exact mounted candidate.',
    'The platform reviews foundation before either branch starts, combines both approved terminal candidates with a trusted system operation, then runs all project tests and the immutable external contract. Only after combined final review and coordinator summary is the goal complete. Do not ask a human unless the concrete requirements cannot be followed; all required behavior is specified here.',
  ].join('\n\n');
  const submitted = await human(`/camp/rooms/${room.id}/tasks`, { title, description, planMode: 'bounded_dag', budget: { maxRuns: 24, maxReviewRounds: 10, maxDurationSeconds: 1800 } });
  goal = submitted.goals.find(value => value.title === title); assert.equal(goal?.protocolVersion, 5); assert.equal(goal.planMode, 'bounded_dag');
  const context = { name, roomId: room.id, goalId: goal.id, channelId, webUrl: `${webUrl}/s/${seed.server.slug}/channel/${channelId}?tab=camp`, planMode: 'bounded_dag', folder, runtimeHome, workerEnvPath, imageId: image.imageId, toolchainDigest: image.toolchainDigest };
  await writeFile('.camp/dag-model-pending.json', JSON.stringify(context, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ event: 'dag_model_started', ...context }));
  if (interrupted) throw new Error('Acceptance interrupted before worker launch');
  descriptor = await open(join(folder, 'worker.log'), 'a', 0o600);
  const child = spawn(process.execPath, ['--env-file=.camp/runtime.env', '--env-file=' + workerEnvPath, '--import', '@oxc-node/core/register', 'packages/camp-runtime/scripts/worker-pool.mjs'], { stdio: ['ignore', descriptor.fd, descriptor.fd], env: { ...process.env } });
  owner = superviseOwnedChild(child, { group: false });
  const deadline = Date.now() + 25 * 60 * 1000;
  let previous, state, current, observedParallelLeaves = false;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Acceptance interrupted; owned worker is draining');
    state = await human(`/camp/rooms/${room.id}`); current = state.goals.find(value => value.id === goal.id); assert.ok(current);
    await writeFile(join(folder, 'latest-state.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    const leafBuilds = state.runs.filter(run => run.goalId === goal.id && run.goalAttempt === current.attempt && run.taskKind === 'build' && ['left', 'right'].includes(run.planItemKey) && run.status === 'running' && run.leaseValid === true);
    if (leafBuilds.length === 2) { assert.notEqual(leafBuilds[0].workerId, leafBuilds[1].workerId); assert.equal(leafBuilds[0].agentId, leafBuilds[1].agentId); observedParallelLeaves = true; }
    const progress = { status: current.status, reason: current.reason, runs: current.usage.runs, reviews: current.usage.reviewRounds, approved: current.metrics?.itemsApproved, graph: current.graph?.delivery.status, integration: current.integration.status, verification: current.verification.status };
    if (JSON.stringify(progress) !== previous) { console.log(JSON.stringify({ event: 'dag_model_progress', ...progress })); previous = JSON.stringify(progress); }
    if (current.status === 'completed') break;
    assert.ok(!['needs_attention', 'cancelled'].includes(current.status), 'Real DSH DAG requires attention: ' + current.reason);
    assert.equal(current.questions.some(question => question.status === 'awaiting_human'), false, 'This acceptance requires no human coordination');
    owner.assertRunning('Real DSH pool exited before final delivery');
    await delay(1000);
  }
  assert.equal(current?.status, 'completed', 'Real DSH DAG acceptance deadline exceeded');
  assert.equal(current.attempt, 1); assert.equal(current.plan.revision, 2);
  assert.deepEqual(current.plan.tasks.map(item => item.key).sort(), ['foundation', 'left', 'right']);
  for (const item of current.plan.tasks) assert.deepEqual(item.dependsOnKeys, item.key === 'foundation' ? [] : ['foundation']);
  assert.deepEqual([...current.graph.sinkKeys].sort(), ['left', 'right']); assert.equal(current.graph.delivery.status, 'ready');
  const approvedFoundation = current.items.find(item => item.key === 'foundation'); assert.equal(approvedFoundation.status, 'approved');
  for (const key of ['left', 'right']) {
    const item = current.items.find(value => value.key === key); assert.equal(item.status, 'approved'); assert.equal(item.inputResolution, 'single_parent'); assert.equal(item.inputSources.length, 1);
    const parent = item.inputSources[0]; assert.equal(parent.key, 'foundation'); assert.equal(identity(parent.candidate), identity(approvedFoundation.candidate)); assert.equal(identity(item.inputCandidate), identity(parent.candidate));
    const producer = state.runs.find(run => run.id === parent.runId); assert.equal(producer.status, 'completed'); assert.equal(producer.planItemKey, 'foundation'); assert.equal(producer.epoch, parent.epoch); assert.equal(identity(producer.candidate), identity(parent.candidate));
    const firstBuild = state.runs.find(run => run.goalId === goal.id && run.goalAttempt === current.attempt && run.taskKind === 'build' && run.planItemKey === key); assert.equal(identity(firstBuild.inputCandidate), identity(parent.candidate));
    assert.ok(approvedFoundation.reviews.some(review => review.outcome === 'approved' && review.candidate?.refId === parent.candidate.refId));
  }
  const joins = current.integration.operations.filter(operation => operation.scope === 'goal'); assert.equal(joins.length, 1); assert.equal(current.integration.operations.length, 1);
  const joined = joins[0], receipt = joined.integrationReport; assert.equal(joined.status, 'completed'); assert.equal(receipt.status, 'merged'); assert.equal(joined.integrationInput.algorithm, 'layerfs-three-way-v2');
  assert.equal(identity(joined.integrationInput.base), identity(approvedFoundation.candidate), 'The final join must use the approved foundation, not the original goal baseline');
  assert.equal(createHash('sha256').update(serializeIntegrationInput(joined.integrationInput)).digest('hex'), joined.inputDigest); assert.equal(receipt.inputDigest, joined.inputDigest); assert.equal(receipt.operationId, joined.id); assert.equal(receipt.runId, joined.latestRunId);
  assert.equal(identity(current.graph.delivery.candidate), identity(receipt.candidate));
  assert.deepEqual(joined.integrationInput.parents.map(parent => parent.key).sort(), ['left', 'right']);
  for (const parent of joined.integrationInput.parents) {
    const item = current.items.find(value => value.key === parent.key), producer = state.runs.find(run => run.id === parent.runId);
    assert.equal(identity(parent.candidate), identity(item.candidate)); assert.equal(producer.status, 'completed'); assert.equal(producer.planItemKey, parent.key); assert.equal(producer.epoch, parent.epoch); assert.equal(identity(producer.candidate), identity(parent.candidate));
    assert.ok(item.reviews.some(review => review.outcome === 'approved' && review.candidate?.refId === parent.candidate.refId));
  }
  const manifest = await human(`/camp/rooms/${room.id}/goals/${goal.id}/result`); assert.equal(manifest.resultReady, true); assert.equal(manifest.verification.receipt.status, 'passed');
  assert.equal(identity(manifest.candidate), identity(current.finalCandidate)); assert.equal(identity(manifest.verification.receipt.candidate), identity(manifest.candidate)); assert.equal(manifest.verification.receipt.policyDigest, current.verificationPolicy.digest);
  assert.equal(manifest.metrics.humanAnswers, 0); assert.equal(manifest.metrics.manualRetries, 0);
  assert.equal(manifest.integration.operations.some(operation => operation.id === joined.id && operation.integrationReport?.runId === receipt.runId), true);
  assert.ok(state.runs.some(run => run.taskKind === 'final_review' && run.status === 'completed' && run.outcome === 'approved' && identity(run.inputCandidate) === identity(manifest.candidate)));
  assert.ok(state.runs.some(run => run.taskKind === 'summary' && run.status === 'completed')); assert.equal(state.room.acceptedHead.goalId, goal.id); assert.equal(identity(state.room.acceptedHead.candidate), identity(manifest.candidate));
  await owner.stop({ graceMs: 30000 });
  const runtime = await new CampRuntime({ home: runtimeHome, imageId: image.imageId, toolchainBundle: bundle }).ready(), output = join(folder, 'export');
  await exportCandidate({ runtime, candidate: manifest.candidate, roomId: room.id, goalId: goal.id, output });
  for (const [path, content] of Object.entries(originalFiles)) assert.equal(await readFile(join(source, path), 'utf8'), content, 'The source checkout must remain unchanged');
  for (const [path, digest] of Object.entries(protectedHashes)) assert.equal(createHash('sha256').update(await readFile(join(output, path))).digest('hex'), digest, 'Protected provided tests/package were changed');
  const exportedChecks = [];
  for (const argv of [['node', '--test'], ['node', '/camp-checks/dag-model-contract']]) {
    const container = 'camp-dag-export-check-' + randomUUID();
    try {
      const checked = await runtime.dockerCall(['run', '--rm', '--name', container, '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '536870912', '--memory-swap', '536870912', '--cpus', '1', '--log-driver', 'none', '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864,mode=0700', '--mount', `type=bind,source=${output},target=/workspace,readonly`, '--mount', `type=bind,source=${harnessPath},target=/camp-checks/dag-model-contract,readonly`, '--workdir', '/workspace', '--entrypoint', argv[0], image.imageId, ...argv.slice(1)], { timeout: 60000, maxBuffer: 65536 });
      assert.ok(argv.includes('--test') ? /(?:#|ℹ) pass 6\b/.test(checked.stdout) : checked.stdout.includes('CAMP_DAG_MODEL_CONTRACT_PASSED'), 'Export must pass the fixed independent checks');
      await writeFile(join(folder, argv.includes('--test') ? 'export-tests.log' : 'export-contract.log'), checked.stdout + checked.stderr, { mode: 0o600 });
      exportedChecks.push({ argv, exitCode: 0, executionUid: 0, network: 'none', readOnly: true });
    } finally { await runtime.dockerCall(['rm', '--force', container], { timeout: 5000 }).catch(error => { if (!/No such container/i.test(error.stderr ?? '')) throw error; }); }
  }
  await writeFile(join(folder, 'result.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  await human(`/channels/${channelId}/archive`, {}); archived = true;
  const result = { event: 'bounded_dag_real_model_passed', at: new Date().toISOString(), ...context, hostCount: 1, realDsh: true, roleOutputs: 'real_model', modelRuns: state.runs.filter(run => run.executor === 'agent').length, systemRuns: state.runs.filter(run => run.executor !== 'agent').length, nodes: 3, planRevision: 2, approvedFoundationShared: true, observedParallelLeaves, terminalSinks: ['left', 'right'], integrationRuns: 1, integrationAlgorithm: joined.integrationInput.algorithm, finalJoinUsesApprovedFoundation: true, externalVerificationPassed: true, resultReady: true, humanAnswers: manifest.metrics.humanAnswers, manualRetries: manifest.metrics.manualRetries, metrics: manifest.metrics, output, exportedChecks, archived: true, activeDemoChanged: false };
  await writeFile('.camp/dag-model-latest.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); success = true;
  console.log(JSON.stringify(result));
} finally {
  for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, interrupt);
  if (!success && room && goal) await human(`/camp/rooms/${room.id}/goals/${goal.id}/cancel`, {}).catch(() => {});
  try { await owner?.stop({ graceMs: 30000 }); }
  finally {
    await descriptor?.close();
    if (!archived && room) await human(`/channels/${room.channelId}/archive`, {}).catch(() => {});
  }
}
