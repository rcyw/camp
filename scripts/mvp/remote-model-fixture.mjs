import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import { parseCandidate, serializeIntegrationInput } from '../../packages/camp-protocol/src/index.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const candidateIdentity = value => { const c = parseCandidate(value); return JSON.stringify([c.projectId, c.imageId, c.refKind, c.refId, c.rootId]); };
export const editableFiles = Object.freeze(['foundation/index.js', 'left/index.js', 'right/index.js']);
// Docker binds this operator file read-only into an unprivileged UID 501
// verifier. The private host operation directory still protects its pathname.
export const modelHarnessMode = 0o444;
export function standardModelWorkerCommand(argv, release) {
  const canonical = value => typeof value === 'string' && isAbsolute(value) && /^\/[A-Za-z0-9_./-]+$/.test(value) && resolve(value) === value && value !== '/';
  if (!canonical(release) || !Array.isArray(argv) || argv.length < 2 || !argv.every(value => typeof value === 'string')) return false;
  const entry = release + '/packages/camp-runtime/scripts/worker-pool.mjs';
  if (argv.at(-1) !== entry || !(['node', 'nodejs'].includes(argv[0]) || canonical(argv[0]) && ['node', 'nodejs'].includes(basename(argv[0])))) return false;
  const files = argv.slice(1, -1).map(value => value.startsWith('--env-file=') ? value.slice('--env-file='.length) : null);
  return files.every(canonical) && new Set(files).size === files.length;
}
export function modelFixture(name = 'camp-remote-model') {
  assert.match(name, /^[a-z][a-z0-9-]{0,99}$/);
  const files = {
    'package.json': JSON.stringify({ name, private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
    'foundation/index.js': 'export function normalizeName(value) { throw new Error("Implement normalizeName"); }\n',
    'foundation/index.test.js': 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { normalizeName } from "./index.js";\ntest("normalization contract", () => { assert.equal(normalizeName("  ALICE \\t SMITH  "), "alice smith"); assert.equal(normalizeName(""), ""); assert.equal(normalizeName("  \\n "), ""); });\ntest("normalization requires a string", () => { for (const input of [null, undefined, 1, {}, []]) assert.throws(() => normalizeName(input), TypeError); });\n',
    'left/index.js': 'import { normalizeName } from "../foundation/index.js";\nexport function greetName(value) { throw new Error("Implement greetName"); }\n',
    'left/index.test.js': 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greetName } from "./index.js";\ntest("greeting uses foundation", () => { assert.equal(greetName("  ALICE \\t SMITH  "), "Hello, alice smith!"); assert.equal(greetName("  "), "Hello, stranger!"); });\ntest("greeting preserves validation", () => assert.throws(() => greetName(null), TypeError));\n',
    'right/index.js': 'import { normalizeName } from "../foundation/index.js";\nexport function slugName(value) { throw new Error("Implement slugName"); }\n',
    'right/index.test.js': 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { slugName } from "./index.js";\ntest("slug uses foundation", () => { assert.equal(slugName("  ALICE \\t SMITH  "), "alice-smith"); assert.equal(slugName("  "), ""); });\ntest("slug preserves validation", () => assert.throws(() => slugName(12), TypeError));\n',
  };
  const sourceHashes = Object.fromEntries(Object.entries(files).map(([path, value]) => [path, hash(value)]));
  const protectedHashes = Object.fromEntries(Object.entries(sourceHashes).filter(([path]) => !editableFiles.includes(path)));
  return { files, sourceHashes, protectedHashes, harnessId: 'remote-model-contract' };
}
export function modelContract(fixture, workspace = '/workspace') {
  assert.equal(typeof workspace, 'string');
  const inputs = ['  ALICE \t SMITH  ', 'Bob\nJONES', '', '  '];
  const normalized = ['alice smith', 'bob jones', '', ''];
  const expectedResults = {
    schemaVersion: 1,
    values: normalized.map(value => [value, 'Hello, ' + (value || 'stranger') + '!', value.replaceAll(' ', '-')].map(result => ({ kind: 'return', value: result }))),
    invalid: Array.from({ length: 5 }, () => Array.from({ length: 3 }, () => ({ kind: 'throw', typeError: true }))),
  };
  // Candidate modules are imported only in a child. Patching node:assert or
  // printing a success marker/exit(0) there cannot decide the parent verdict.
  // This is a bounded behavior probe, not same-UID malicious-code isolation.
  const child = [
    `const root=${JSON.stringify(workspace)},inputs=${JSON.stringify(inputs)};`,
    'const stringify=JSON.stringify.bind(JSON),write=process.stdout.write.bind(process.stdout),exit=process.exit.bind(process),TypeErrorClass=TypeError;',
    'const{normalizeName}=await import(root+"/foundation/index.js"),{greetName}=await import(root+"/left/index.js"),{slugName}=await import(root+"/right/index.js");',
    'const functions=[normalizeName,greetName,slugName];function observe(fn,input){try{return{kind:"return",value:fn(input)};}catch(error){return{kind:"throw",typeError:error instanceof TypeErrorClass};}}',
    'const values=inputs.map(input=>functions.map(fn=>observe(fn,input))),invalid=[null,undefined,42,{},[]].map(input=>functions.map(fn=>observe(fn,input)));',
    'write(stringify({schemaVersion:1,values,invalid}),()=>exit(0));',
  ].join('\n');
  return [
    "import assert from 'node:assert/strict';import{createHash}from'node:crypto';import{readFile,readdir}from'node:fs/promises';import{spawn}from'node:child_process';import{isDeepStrictEqual}from'node:util';",
    `const root=${JSON.stringify(workspace)};`,
    `const expected=${JSON.stringify(Object.keys(fixture.files).sort())},protectedHashes=${JSON.stringify(fixture.protectedHashes)};`,
    "const directories=new Set(expected.flatMap(path=>path.split('/').slice(0,-1).map((_,index)=>path.split('/').slice(0,index+1).join('/'))));",
    "async function checkInventory(){let entries=0;async function files(path=''){const result=[];for(const item of await readdir(root+'/'+path,{withFileTypes:true})){assert.ok(++entries<=32&& (item.isFile()||item.isDirectory()),'Unexpected inventory or linked/special file');const name=path+item.name;if(item.isDirectory()){assert.ok(directories.has(name),'Unexpected candidate directory');result.push(...await files(name+'/'));}else result.push(name);}return result.sort();}assert.ok(isDeepStrictEqual(await files(),expected),'Unexpected or missing candidate files');for(const[path,digest]of Object.entries(protectedHashes))assert.equal(createHash('sha256').update(await readFile(root+'/'+path)).digest('hex'),digest,'Protected test or metadata changed: '+path);}",
    `const childCode=${JSON.stringify(child)},expectedResults=${JSON.stringify(expectedResults)};`,
    "function runCandidate(){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',childCode],{cwd:root,detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'}});let done=false,total=0,stderrBytes=0;const chunks=[];let timer;function fail(){if(done)return;done=true;clearTimeout(timer);if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}child.stdout.destroy();child.stderr.destroy();reject(Error('Candidate behavior subprocess did not complete a valid bounded report'));}timer=setTimeout(fail,5000);child.once('error',fail);child.stdout.on('data',bytes=>{total+=bytes.length;if(total>32768)return fail();chunks.push(bytes);});child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;total+=bytes.length;if(total>32768)fail();});child.once('close',(code,signal)=>{if(done)return;if(code!==0||signal||stderrBytes)return fail();let result;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)));}catch{return fail();}done=true;clearTimeout(timer);resolve(result);});});}",
    "await checkInventory();let report,failed=false;try{report=await runCandidate();}catch{failed=true;}await checkInventory();assert.ok(!failed&&isDeepStrictEqual(report,expectedResults),'Candidate behavior did not satisfy the trusted contract');console.log('CAMP_REMOTE_MODEL_CONTRACT_PASSED');",
  ].join('\n') + '\n';
}
export function modelGoal() {
  return {
    title: 'Implement a reviewed name foundation and two dependent modules on the remote Worker', planMode: 'bounded_dag',
    budget: { maxRuns: 24, maxReviewRounds: 10, maxDurationSeconds: 1800 },
    description: [
      'Submit a bounded_dag planRevision 2 with exactly three keys: foundation (dependsOnKeys: []), left (dependsOnKeys: ["foundation"]), right (dependsOnKeys: ["foundation"]). Use camp_submit_plan. Left and right become independent only after foundation review approval.',
      'foundation may edit only foundation/index.js. normalizeName(value) requires a string or throws TypeError, trims, collapses all internal whitespace to one ASCII space, and lowercases. Empty/whitespace-only inputs return an empty string.',
      'left may edit only left/index.js. greetName(value) calls normalizeName from ../foundation/index.js; return "Hello, NAME!", or "Hello, stranger!" for an empty normalized name. Preserve TypeError on non-string input.',
      'right may edit only right/index.js. slugName(value) calls normalizeName and replaces every remaining ASCII space with a hyphen. Preserve empty string and TypeError behavior.',
      'Preserve every test, package.json, other module and file inventory. Do not add files, dependencies, metadata or publish. Fixed external checks protect these inputs.',
      'Item reviewers must not change files. Run only the assigned item suite (node --test foundation/index.test.js, left/index.test.js, or right/index.test.js). Other independent branches are intentionally unfinished; do not reject a correct item because another branch is unfinished. Record camp_review bound to the mounted candidate.',
      'The platform combines both approved terminal candidates through trusted integration, then independently runs all tests and the frozen external contract. Final review must use those trusted checks; planner summary must record camp_finalize. Use real role tools and their reasoning. Ask a coordinator via camp_ask_question only when needed; do not ask a human unless these concrete requirements are impossible.',
    ].join('\n\n'),
  };
}
export function validateModelDelivery({ state, manifest, goalId, progressEvents = [] }) {
  const goal = state.goals.find(value => value.id === goalId); assert.ok(goal);
  assert.equal(goal.status, 'completed'); assert.equal(goal.attempt, 1); assert.equal(goal.protocolVersion, 5); assert.equal(goal.planMode, 'bounded_dag'); assert.equal(goal.plan.revision, 2);
  assert.deepEqual(goal.plan.tasks.map(value => value.key).sort(), ['foundation', 'left', 'right']);
  for (const item of goal.plan.tasks) assert.deepEqual(item.dependsOnKeys, item.key === 'foundation' ? [] : ['foundation']);
  assert.equal(goal.metrics.humanAnswers, 0); assert.equal(goal.metrics.manualRetries, 0);
  assert.equal(manifest.resultReady, true); assert.equal(manifest.goalId, goalId); assert.equal(manifest.verification.receipt.status, 'passed');
  assert.equal(candidateIdentity(manifest.candidate), candidateIdentity(goal.finalCandidate));
  assert.equal(candidateIdentity(manifest.verification.receipt.candidate), candidateIdentity(manifest.candidate)); assert.equal(manifest.verification.receipt.policyDigest, goal.verificationPolicy.digest);
  assert.ok(manifest.verification.receipt.checks.some(check => check.id === 'external' && check.exitCode === 0 && check.stdout.includes('CAMP_REMOTE_MODEL_CONTRACT_PASSED')));
  const runs = state.runs.filter(run => run.goalId === goalId && run.goalAttempt === goal.attempt), models = runs.filter(run => run.executor === 'agent');
  assert.ok(models.length >= 9); assert.ok(models.every(run => (run.status === 'completed' || (run.status === 'suspended' && (goal.questions ?? []).some(question => question.id === run.questionId && question.status === 'answered' && question.resumedAt))) && typeof run.sessionId === 'string' && run.sessionId.length > 0 && run.cleanupState === 'confirmed'));
  assert.deepEqual([...new Set(models.map(run => run.role))].sort(), ['builder', 'planner', 'reviewer']);
  for (const kind of ['plan', 'build', 'review', 'final_review', 'summary']) assert.ok(models.some(run => run.taskKind === kind));
  for (const run of models) if (run.taskKind !== 'build') assert.equal(run.candidate.rootId, run.inputCandidate.rootId, 'Read-only model role changed its candidate');
  const foundation = goal.items.find(item => item.key === 'foundation'); assert.equal(foundation.status, 'approved');
  for (const key of ['left', 'right']) {
    const item = goal.items.find(value => value.key === key); assert.equal(item.status, 'approved'); assert.equal(item.inputResolution, 'single_parent'); assert.equal(item.inputSources.length, 1);
    const parent = item.inputSources[0], producer = runs.find(run => run.id === parent.runId);
    assert.equal(parent.key, 'foundation'); assert.equal(candidateIdentity(parent.candidate), candidateIdentity(foundation.candidate)); assert.equal(candidateIdentity(item.inputCandidate), candidateIdentity(parent.candidate));
    assert.ok(producer && producer.status === 'completed' && producer.epoch === parent.epoch && producer.planItemKey === 'foundation'); assert.equal(candidateIdentity(producer.candidate), candidateIdentity(parent.candidate));
    assert.ok(foundation.reviews.some(review => review.outcome === 'approved' && review.candidate?.refId === parent.candidate.refId));
    const firstBuild = models.find(run => run.taskKind === 'build' && run.planItemKey === key); assert.ok(firstBuild); assert.equal(candidateIdentity(firstBuild.inputCandidate), candidateIdentity(parent.candidate));
  }
  const operations = goal.integration.operations; assert.equal(operations.length, 1);
  const joined = operations[0], report = joined.integrationReport;
  assert.equal(joined.scope, 'goal'); assert.equal(joined.status, 'completed'); assert.equal(report.status, 'merged'); assert.equal(joined.integrationInput.algorithm, 'layerfs-three-way-v2');
  assert.equal(candidateIdentity(joined.integrationInput.base), candidateIdentity(foundation.candidate)); assert.equal(hash(serializeIntegrationInput(joined.integrationInput)), joined.inputDigest); assert.equal(report.inputDigest, joined.inputDigest); assert.equal(report.operationId, joined.id); assert.equal(report.runId, joined.latestRunId);
  assert.deepEqual(joined.integrationInput.parents.map(parent => parent.key).sort(), ['left', 'right']);
  for (const parent of joined.integrationInput.parents) { const item = goal.items.find(value => value.key === parent.key), producer = runs.find(run => run.id === parent.runId); assert.equal(item.status, 'approved'); assert.equal(candidateIdentity(item.candidate), candidateIdentity(parent.candidate)); assert.ok(producer && producer.epoch === parent.epoch && producer.status === 'completed'); assert.equal(candidateIdentity(producer.candidate), candidateIdentity(parent.candidate)); assert.ok(item.reviews.some(review => review.outcome === 'approved' && review.candidate?.refId === parent.candidate.refId)); assert.ok(models.some(run => run.taskKind === 'review' && run.planItemKey === parent.key && run.outcome === 'approved' && candidateIdentity(run.inputCandidate) === candidateIdentity(parent.candidate))); }
  assert.equal(goal.graph.delivery.status, 'ready'); assert.deepEqual([...goal.graph.sinkKeys].sort(), ['left', 'right']); assert.equal(candidateIdentity(goal.graph.delivery.candidate), candidateIdentity(report.candidate));
  let delivered = report.candidate, wholeGoalRepairRuns = 0;
  while (candidateIdentity(delivered) !== candidateIdentity(manifest.candidate)) {
    const next = models.filter(run => run.taskKind === 'build' && run.planItemKey === null && run.status === 'completed' && candidateIdentity(run.inputCandidate) === candidateIdentity(delivered) && candidateIdentity(run.candidate) !== candidateIdentity(delivered));
    assert.equal(next.length, 1, 'Final candidate must follow one explicit trusted whole-goal repair chain');
    delivered = next[0].candidate; assert.ok(++wholeGoalRepairRuns <= 5);
  }
  assert.equal(state.room.acceptedHead.goalId, goalId); assert.equal(candidateIdentity(state.room.acceptedHead.candidate), candidateIdentity(manifest.candidate));
  assert.ok(models.some(run => run.taskKind === 'final_review' && run.outcome === 'approved' && candidateIdentity(run.inputCandidate) === candidateIdentity(manifest.candidate)));
  const progressByRole = Object.fromEntries(['planner', 'builder', 'reviewer'].map(role => [role, progressEvents.filter(event => event.type === 'progress' && models.some(run => run.id === event.runId && run.role === role)).length]));
  assert.ok(Object.values(progressByRole).every(count => count > 0), 'Missing actual progress evidence for a model role');
  return { agentRuns: models.length, systemRuns: runs.length - models.length, modelRunIds: models.map(run => ({ id: run.id, epoch: run.epoch, role: run.role, taskKind: run.taskKind, sessionId: run.sessionId })), progressByRole, approvedDependencyShared: true, candidateBoundReview: true, wholeGoalRepairRuns, integrationAlgorithm: joined.integrationInput.algorithm };
}
export function validateModelUsage(apiRuns, evidence) {
  assert.equal(evidence.service.active, true); assert.equal(evidence.service.standardWorkerCommand, true);
  const selected = apiRuns.filter(run => run.executor === 'agent'), seen = new Set(); let requests = 0, inputBytes = 0, responseBytes = 0;
  for (const run of selected) {
    const matches = evidence.runs.filter(record => record.runId === run.id && record.epoch === run.epoch); assert.equal(matches.length, 1, 'Missing or ambiguous model journal entry');
    const record = matches[0]; assert.equal(record.role, run.role); assert.equal(record.phase, 'settled'); assert.equal(record.cleanupKnown, true); assert.equal(record.executor, 'agent');
    for (const key of ['requests', 'inputBytes', 'responseBytes']) assert.ok(Number.isSafeInteger(record.modelUsage?.[key]) && record.modelUsage[key] > 0, 'Missing real model proxy counters');
    seen.add(run.id); requests += record.modelUsage.requests; inputBytes += record.modelUsage.inputBytes; responseBytes += record.modelUsage.responseBytes;
  }
  assert.equal(evidence.runs.filter(record => record.executor === 'agent').length, seen.size);
  return { agentRuns: seen.size, proxyRequestAttempts: requests, inputBytes, responseBytes, providerTokens: null, source: 'trusted_worker_journal' };
}
