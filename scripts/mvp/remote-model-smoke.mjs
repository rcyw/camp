// Preparation, explicit paid submission and read-only acceptance for a separate
// persistent remote service. No session factory, model key or manager control.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from '../../packages/camp-runtime/src/durable-state.mjs';
import { checkedAlias, checkedPath, sshJson } from './two-host-support.mjs';
import { hash, modelFixture, modelContract, modelGoal, editableFiles, candidateIdentity, validateModelDelivery, validateModelUsage } from './remote-model-fixture.mjs';

export function remoteModelOptions(env, id) {
  const workerUrl = new URL(env.CAMP_REMOTE_MODEL_API_URL);
  if (workerUrl.protocol !== 'https:' || workerUrl.username || workerUrl.password || workerUrl.pathname !== '/' || workerUrl.search || workerUrl.hash || ['localhost', '127.0.0.1', '[::1]'].includes(workerUrl.hostname)) throw new Error('Remote real-model execution requires a stable HTTPS origin');
  const alias = checkedAlias(env.CAMP_REMOTE_SSH), release = checkedPath(env.CAMP_REMOTE_ROOT), toolchain = checkedPath(env.CAMP_REMOTE_TOOLCHAIN_BUNDLE);
  assert.match(env.CAMP_REMOTE_RELEASE_SHA256 ?? '', /^[a-f0-9]{64}$/);
  const operation = checkedPath(join(checkedPath(env.CAMP_REMOTE_MODEL_OPERATIONS_ROOT ?? release + '.model-operations'), id));
  assert.ok(!operation.startsWith(release + '/'));
  const serviceName = env.CAMP_REMOTE_MODEL_SERVICE ?? id + '.service'; assert.match(serviceName, /^[A-Za-z0-9][A-Za-z0-9@_.-]{0,159}\.service$/);
  const protectedRooms = env.CAMP_REMOTE_MODEL_PROTECTED_ROOMS ? env.CAMP_REMOTE_MODEL_PROTECTED_ROOMS.split(',') : [];
  for (const room of protectedRooms) assert.match(room, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.equal(new Set(protectedRooms).size, protectedRooms.length);
  return { alias, release, releaseDigest: env.CAMP_REMOTE_RELEASE_SHA256, toolchain, operation, workerApiUrl: workerUrl.origin, serviceName, protectedRooms };
}
export function remoteModelArguments(args) {
  if (args.length === 1 && args[0] === 'prepare') return { action: 'prepare' };
  if (args.length === 3 && args[0] === 'verify' && args[1] === '--context') return { action: 'verify', context: args[2] };
  if (args.length === 4 && args[0] === 'submit' && args[1] === '--real-model' && args[2] === '--context') return { action: 'submit', context: args[3] };
  throw new Error('Use prepare | submit --real-model --context PRIVATE_JSON | verify --context PRIVATE_JSON');
}
export function remoteModelChannelName(id) {
  assert.match(id, /^remote-model-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  return 'model-' + id.slice('remote-model-'.length).replaceAll('-', '').slice(0, 24);
}
export function remoteModelTargetArguments(operation, action) {
  checkedPath(operation); assert.ok(['prepare', 'service', 'evidence'].includes(action));
  // The control certificate is in the host's system trust store. This probe
  // never loads the separate model environment or a provider credential.
  return ['timeout', '--signal=TERM', '--kill-after=15s', '120s', 'node', '--use-system-ca', join(operation, 'probe/scripts/mvp/remote-model-target.mjs'), action, operation];
}
export function validateRemoteModelDeployment(context, evidence) {
  assert.match(context.releaseDigest, /^[a-f0-9]{64}$/);
  assert.equal(evidence.releaseDigest, context.releaseDigest, 'The live release differs from the reviewed local context');
  assert.equal(evidence.service?.name, context.serviceName);
  assert.equal(evidence.service.active, true);
  assert.equal(evidence.service.standardWorkerCommand, true);
}
const fact = state => ({ head: state.room.acceptedHead, storageId: state.room.storageId, storageEpoch: state.room.storageEpoch, runs: state.runs.map(run => ({ id: run.id, status: run.status, epoch: run.epoch, candidate: run.candidate, completedAt: run.completedAt })).sort((a, b) => a.id.localeCompare(b.id)) });
async function apiClient(env) {
  const url = new URL(env.CAMP_API_URL ?? 'http://127.0.0.1:13018');
  assert.ok(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash);
  assert.ok(url.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  const seed = JSON.parse(await readFile(env.CAMP_MODEL_LOGIN_FILE ?? '.dev-env-camp.json', 'utf8'));
  const login = await fetch(url.origin + '/api/auth/login', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }), signal: AbortSignal.timeout(15000) });
  assert.equal(login.status, 200); const auth = await login.json();
  return async (path, body, method) => {
    const response = await fetch(url.origin + '/api' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'error', headers: { authorization: 'Bearer ' + auth.accessToken, 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, 'Remote model control request rejected: ' + path + ' (' + response.status + ')'); return response.json();
  };
}
export async function remoteModelMain(args = process.argv.slice(2), env = process.env) {
  const options = remoteModelArguments(args), api = await apiClient(env);
  if (options.action === 'prepare') return prepare(api, env);
  const contextPath = resolve(options.context), context = JSON.parse(await readFile(contextPath, 'utf8'));
  assert.equal(context.schemaVersion, 1); assert.equal(context.mode, 'externalPersistentWorker');
  const target = (action, input) => sshJson(context.alias, remoteModelTargetArguments(context.operation, action), input, { timeoutMs: 150000 });
  if (options.action === 'submit') {
    validateRemoteModelDeployment(context, await target('service'));
    const snapshot = await api('/camp/rooms/' + context.roomId);
    let goal = snapshot.goals.find(value => value.id === context.goalId);
    if (!goal) {
      const matches = snapshot.goals.filter(value => value.title === context.goalInput.title && value.description === context.goalInput.description && value.planMode === 'bounded_dag'); assert.ok(matches.length <= 1);
      goal = matches[0];
      if (!goal) {
        if (context.submissionIntent) throw new Error('Submission outcome is ambiguous; inspect the existing Room before another paid request');
        context.submissionIntent = new Date().toISOString(); await atomicJson(contextPath, context);
        const created = await api('/camp/rooms/' + context.roomId + '/tasks', context.goalInput);
        goal = created.goals.find(value => value.title === context.goalInput.title); assert.ok(goal);
      }
      context.goalId = goal.id; await atomicJson(contextPath, context);
    }
    console.log(JSON.stringify({ event: 'remote_model_goal_submitted', roomId: context.roomId, goalId: goal.id, serviceName: context.serviceName, context: contextPath })); return;
  }
  assert.ok(context.goalId, 'Submit a paid goal explicitly before verification');
  const eventsPath = join(context.folder, 'progress-events.json'), progress = new Map();
  try { for (const event of JSON.parse(await readFile(eventsPath, 'utf8'))) progress.set(event.id, event); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const deadline = Date.now() + 35 * 60 * 1000; let snapshot, goal, previous;
  for (;;) {
    snapshot = await api('/camp/rooms/' + context.roomId); goal = snapshot.goals.find(value => value.id === context.goalId); assert.ok(goal);
    for (const event of snapshot.events) if (event.type === 'progress') progress.set(event.id, { id: event.id, runId: event.runId, type: event.type });
    assert.ok(progress.size <= 10000); await atomicJson(eventsPath, [...progress.values()]); await atomicJson(join(context.folder, 'latest-state.json'), snapshot);
    const status = { status: goal.status, reason: goal.reason, runs: goal.usage.runs, approved: goal.metrics.itemsApproved, integration: goal.integration.status, verification: goal.verification.status };
    if (JSON.stringify(status) !== previous) { console.log(JSON.stringify({ event: 'remote_model_progress', ...status })); previous = JSON.stringify(status); }
    if (goal.status === 'completed') break;
    assert.ok(!['needs_attention', 'cancelled'].includes(goal.status), 'Remote model goal needs operator attention: ' + goal.reason);
    assert.ok(!goal.questions.some(value => value.status === 'awaiting_human'), 'This acceptance requires autonomous role coordination');
    assert.ok(Date.now() < deadline, 'Remote model verification deadline elapsed; service and Goal remain intact'); await delay(1000);
  }
  const manifest = await api(`/camp/rooms/${context.roomId}/goals/${context.goalId}/result`);
  const delivery = validateModelDelivery({ state: snapshot, manifest, goalId: context.goalId, progressEvents: [...progress.values()] });
  const selected = snapshot.runs.filter(value => value.goalId === context.goalId && value.goalAttempt === goal.attempt);
  for (const run of selected.filter(value => value.taskKind === 'build' || value.executor === 'integration')) {
    const delta = await api(`/camp/rooms/${context.roomId}/goals/${context.goalId}/versions/${run.id}/changes`);
    assert.equal(delta.available, true); assert.equal(candidateIdentity(delta.candidate), candidateIdentity(run.candidate));
    assert.equal(candidateIdentity(delta.changeSet.base), candidateIdentity(goal.baseCandidate)); assert.equal(candidateIdentity(delta.changeSet.target), candidateIdentity(run.candidate));
    assert.equal(delta.changeSet.truncated, false);
    assert.ok(delta.changeSet.entries.every(entry => editableFiles.includes(entry.path)), 'A protected file appeared in a produced candidate Diff');
  }
  let evidence, usage;
  for (let attempt = 0; attempt < 5; attempt++) {
    evidence = await target('evidence', { goalId: context.goalId });
    validateRemoteModelDeployment(context, evidence);
    try { usage = validateModelUsage(selected, evidence); break; } catch (error) { if (attempt === 4) throw error; await delay(500); }
  }
  assert.equal(evidence.originalSourceUnchanged, true); assert.equal(evidence.externalHarnessUnchanged, true);
  assert.equal(goal.executionPool.poolId, evidence.poolId); assert.equal(goal.executionPool.storageId, evidence.storageId); assert.equal(snapshot.room.storageId, evidence.storageId);
  for (const key of ['machineIdHash', 'bootIdHash', 'dockerIdHash']) assert.notEqual(evidence.host[key], context.localHost[key], 'The Worker must run on an independent host');
  for (const [roomId, before] of Object.entries(context.protectedFacts)) assert.deepEqual(fact(await api('/camp/rooms/' + roomId)), before, 'An existing protected Room changed');
  const result = { event: 'remote_dsh_model_passed', at: new Date().toISOString(), mode: context.mode, actualHostCount: 2, realDsh: true, roleOutputs: 'real_model', roomId: context.roomId, goalId: context.goalId, service: evidence.service, imageId: context.imageId, toolchainDigest: context.toolchainDigest, releaseDigest: context.releaseDigest, workerApiUrl: context.workerApiUrl, host: evidence.host, ...delivery, modelUsage: usage, operatorInterventions: context.operatorInterventions ?? [], cleanAcceptance: (context.operatorInterventions ?? []).length === 0, resultReady: true, protectedExistingRooms: Object.keys(context.protectedFacts).length, sourceUnchanged: true, protectedTestsAndMetadataUnchanged: true, archived: false, credentialRevoked: false, persistentServiceLeftRunning: true };
  await atomicJson(join(context.folder, 'manifest.json'), manifest); await atomicJson(join(context.folder, 'journal-evidence.json'), evidence); await atomicJson(join(context.folder, 'result.json'), result); await atomicJson('.camp/remote-model-latest.json', result);
  console.log(JSON.stringify(result)); return result;
}
async function prepare(api, env) {
  const id = 'remote-model-' + randomUUID(), deployment = remoteModelOptions(env, id), fixture = modelFixture(id), contract = modelContract(fixture);
  const image = JSON.parse(await readFile(env.CAMP_IMAGE_RECEIPT ?? 'packages/camp-runtime/.local/dag-image-0.7.0.json', 'utf8')); assert.match(image.imageId, /^sha256:[a-f0-9]{64}$/); assert.match(image.toolchainDigest, /^[a-f0-9]{64}$/);
  const folder = resolve('.camp/remote-model', id); await mkdir(folder, { recursive: true, mode: 0o700 });
  const protectedFacts = {}; for (const room of deployment.protectedRooms) protectedFacts[room] = fact(await api('/camp/rooms/' + room));
  const execute = promisify(execFile), dockerId = (await execute('docker', ['info', '--format', '{{.ID}}'], { timeout: 10000 })).stdout.trim();
  const localHost = { machineIdHash: hash((await readFile('/etc/machine-id', 'utf8')).trim()), bootIdHash: hash((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()), dockerIdHash: hash(dockerId) };
  let channelId, room, token;
  try {
    const channel = await api('/channels/', { name: remoteModelChannelName(id), visibility: 'public', description: 'Real remote DSH roles, reviewed DAG dependencies and independent protected acceptance.' }); channelId = channel.channel?.id ?? channel.id;
    room = await api('/camp/rooms', { channelId, name: id, project: { name: id, repoPath: join(deployment.operation, 'source') } });
    const harness = { id: fixture.harnessId, sha256: hash(contract) };
    await api(`/camp/rooms/${room.id}/verification-policy`, { expectedDigest: null, policy: { id: 'remote-dsh-model', revision: 1, name: 'Provided suite and protected remote contract', maxRepairAttempts: 1, checks: [{ id: 'project', label: 'All six provided tests', argv: ['node', '--test'], timeoutMs: 60000 }, { id: 'external', label: 'Protected inventory and complete behavior', argv: ['node', '/camp-checks/' + harness.id], harness, timeoutMs: 30000 }] } }, 'PUT');
    token = await api(`/camp/rooms/${room.id}/worker-token`, {});
    const credentialFile = join(deployment.operation, 'credential.json');
    const config = { ...deployment, name: id, roomId: room.id, workerId: id, imageId: image.imageId, toolchainDigest: image.toolchainDigest, harnessId: harness.id, harnessSha256: harness.sha256 };
    const files = {}; for (const name of ['remote-model-target.mjs', 'remote-model-fixture.mjs']) files[name] = (await readFile(new URL(name, import.meta.url))).toString('base64');
    const workerEnv = { CAMP_API_URL: deployment.workerApiUrl, CAMP_WORKER_ID: id, CAMP_WORKER_ROOM_ID: room.id, CAMP_WORKER_CREDENTIAL_FILE: credentialFile, CAMP_RUNTIME_HOME: join(deployment.operation, 'runtime'), CAMP_RUNTIME_IMAGE: image.imageId, CAMP_TOOLCHAIN_BUNDLE: deployment.toolchain, CAMP_VERIFICATION_HARNESSES: join(deployment.operation, 'harnesses.json') };
    await sshJson(deployment.alias, ['node', '--input-type=module', '-e', remoteModelBootstrap, deployment.release, deployment.operation], { files, config, workerEnv, credential: token });
    const ready = await sshJson(deployment.alias, remoteModelTargetArguments(deployment.operation, 'prepare')); assert.equal(ready.prepared, true); assert.deepEqual(ready.sourceHashes, fixture.sourceHashes);
    const context = { schemaVersion: 1, mode: 'externalPersistentWorker', ...config, channelId, tokenId: token.tokenId, folder, protectedFacts, localHost, workerEnvPath: join(deployment.operation, 'worker.env'), credentialFile, harnessPath: join(deployment.operation, 'contract.mjs'), harnessManifestPath: join(deployment.operation, 'harnesses.json'), runtimeHome: join(deployment.operation, 'runtime'), operatorInterventions: [], goalInput: { ...modelGoal(), title: modelGoal().title + ': ' + id }, goalId: null };
    const contextPath = join(folder, 'context.json'); await atomicJson(contextPath, context);
    console.log(JSON.stringify({ event: 'remote_model_prepared', roomId: room.id, serviceName: deployment.serviceName, workerId: id, workerEnvPath: context.workerEnvPath, credentialFile, harnessPath: context.harnessPath, harnessManifestPath: context.harnessManifestPath, runtimeHome: context.runtimeHome, sourcePath: join(deployment.operation, 'source'), context: contextPath, modelKeysCopied: false, managerStarted: false, goalSubmitted: false })); return context;
  } catch (error) {
    if (token) await api(`/camp/rooms/${room.id}/worker-tokens/${token.tokenId}/revoke`, {}).catch(() => {});
    if (channelId) await api(`/channels/${channelId}/archive`, {}).catch(() => {});
    throw error;
  }
}
export const remoteModelBootstrap = String.raw`
import{mkdir,lstat,realpath,writeFile,symlink}from'node:fs/promises';import{join,dirname,resolve}from'node:path';
let raw='';for await(const bytes of process.stdin){raw+=bytes;if(Buffer.byteLength(raw)>512*1024)throw Error('payload bound');}const payload=JSON.parse(raw),[release,operation]=process.argv.slice(1);
const safe=x=>typeof x==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(x)&&resolve(x)===x&&x!=='/';if(!safe(release)||!safe(operation)||operation===release||operation.startsWith(release+'/')||await realpath(release)!==release)throw Error('unsafe layout');
const credential=payload.credential,uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);if(!credential||Object.keys(credential).sort().join()!==['schemaVersion','token','tokenId','roomId','expiresAt','renewUntil'].sort().join()||credential.schemaVersion!==1||!uuid(credential.tokenId)||!uuid(credential.roomId)||credential.roomId!==payload.config?.roomId||!/^camp_worker_[A-Za-z0-9_-]{43}$/.test(credential.token)||typeof credential.expiresAt!=='string'||typeof credential.renewUntil!=='string'||!Number.isFinite(Date.parse(credential.expiresAt))||!Number.isFinite(Date.parse(credential.renewUntil))||Date.parse(credential.expiresAt)>Date.parse(credential.renewUntil)||Buffer.byteLength(JSON.stringify(credential))>16384)throw Error('invalid Room credential');
const keys=['CAMP_API_URL','CAMP_WORKER_ID','CAMP_WORKER_ROOM_ID','CAMP_WORKER_CREDENTIAL_FILE','CAMP_RUNTIME_HOME','CAMP_RUNTIME_IMAGE','CAMP_TOOLCHAIN_BUNDLE','CAMP_VERIFICATION_HARNESSES'];if(Object.keys(payload.workerEnv).sort().join()!==keys.sort().join()||payload.workerEnv.CAMP_WORKER_ROOM_ID!==credential.roomId||payload.workerEnv.CAMP_WORKER_CREDENTIAL_FILE!==join(operation,'credential.json'))throw Error('worker environment inventory');
for(const value of Object.values(payload.workerEnv))if(typeof value!=='string'||!/^[A-Za-z0-9_./:@-]+$/.test(value))throw Error('unsafe environment value');
const parent=dirname(operation);await mkdir(parent,{recursive:true,mode:0o700});const st=await lstat(parent);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||st.mode&0o077||await realpath(parent)!==parent)throw Error('private operation parent');
await mkdir(operation,{mode:0o700});await mkdir(join(operation,'probe/scripts/mvp'),{recursive:true,mode:0o700});await symlink(join(release,'packages'),join(operation,'probe/packages'),'dir');
const names=['remote-model-target.mjs','remote-model-fixture.mjs'];if(Object.keys(payload.files).sort().join()!==names.sort().join())throw Error('overlay inventory');for(const name of names)await writeFile(join(operation,'probe/scripts/mvp',name),Buffer.from(payload.files[name],'base64'),{flag:'wx',mode:0o600});
await writeFile(join(operation,'credential.json'),JSON.stringify(credential)+'\n',{flag:'wx',mode:0o600});await writeFile(join(operation,'worker.env'),Object.entries(payload.workerEnv).map(([k,v])=>k+'='+v).join('\n')+'\n',{flag:'wx',mode:0o600});await writeFile(join(operation,'config.json'),JSON.stringify(payload.config),{flag:'wx',mode:0o600});console.log(JSON.stringify({installed:true,credentialWritten:true,modelKeyWritten:false}));
`;
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) remoteModelMain().catch(() => { console.error(JSON.stringify({ event: 'remote_model_acceptance_failed', statePreserved: true })); process.exitCode = 1; });
