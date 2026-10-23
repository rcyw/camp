// Explicit two-machine, zero-provider acceptance. SSH/tunnel deployment and
// reviewed runtime release/image installation are operator prerequisites.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CampRuntime } from '../../packages/camp-runtime/src/index.mjs';
import { exportNativeStore } from '../../packages/camp-runtime/src/native-store.mjs';
import { privateArtifactRequest, uploadPrivateBundle } from '../../packages/camp-runtime/src/private-artifacts.mjs';
import { createWorkerDeclaration } from '../../packages/camp-protocol/src/index.js';
import { checkedAlias, checkedPath, checkedLoopback, digest, sshJson, sshGatedJson, bootstrapSource, settleTwoHostProbe, compensateProbe, managedTunnelOwner } from './two-host-support.mjs';
import { createSshWorkerTunnel } from './ssh-worker-tunnel.mjs';

export function remoteConfiguration(env, id) {
  const alias = checkedAlias(env.CAMP_REMOTE_SSH), release = checkedPath(env.CAMP_REMOTE_ROOT), apiUrl = checkedLoopback(env.CAMP_REMOTE_API_URL), toolchain = checkedPath(env.CAMP_REMOTE_TOOLCHAIN_BUNDLE);
  const operation = checkedPath(env.CAMP_REMOTE_PROBE_ROOT ? join(checkedPath(env.CAMP_REMOTE_PROBE_ROOT), id) : `${release}.operations/${id}`);
  assert.ok(operation !== release && !operation.startsWith(release + '/'), 'Probe workspace must be outside the immutable release');
  assert.equal(typeof env.CAMP_REMOTE_RELEASE_SHA256, 'string', 'CAMP_REMOTE_RELEASE_SHA256 must pin the reviewed release manifest');
  assert.match(env.CAMP_REMOTE_RELEASE_SHA256, /^[a-f0-9]{64}$/);
  for (const flag of ['CAMP_REMOTE_MANAGED_TUNNEL', 'CAMP_REMOTE_NETWORK_FAULT']) if (env[flag] !== undefined && !['0', '1'].includes(env[flag])) throw new Error('Remote acceptance flags must be 0 or 1');
  const managedTunnel = env.CAMP_REMOTE_MANAGED_TUNNEL === '1', networkFault = env.CAMP_REMOTE_NETWORK_FAULT === '1';
  if (networkFault && !managedTunnel) throw new Error('Real network faults require the owned managed tunnel');
  if (managedTunnel && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(alias) || Number(new URL(apiUrl).port) < 1024)) throw new Error('Managed tunnel requires a plain SSH alias and remote port >=1024');
  return { alias, release, apiUrl, toolchain, operation, releaseDigest: env.CAMP_REMOTE_RELEASE_SHA256, managedTunnel, networkFault };
}
export async function twoHostMain(env = process.env) {
  if (!process.argv.includes('--real-infra')) throw new Error('Use --real-infra for the explicit two-host acceptance');
  const id = 'two-host-' + randomUUID(), remote = remoteConfiguration(env, id), execute = promisify(execFile);
  const apiUrl = checkedLoopback(env.CAMP_API_URL ?? 'http://127.0.0.1:13018');
  const bundle = resolve(env.CAMP_TOOLCHAIN_BUNDLE ?? 'packages/camp-runtime/.local/toolchain-bundle-dag-0.7.0');
  const imageReceipt = env.CAMP_IMAGE_RECEIPT ?? 'packages/camp-runtime/.local/dag-image-0.7.0.json';
  if (!env.CAMP_STORAGE_SOURCE_RECEIPT) await execute(process.execPath, ['scripts/mvp/parallel-real-smoke.mjs', '--real-infra', '--case=complete'], { timeout: 480000, maxBuffer: 1024 * 1024, env: { ...env, CAMP_API_URL: apiUrl, CAMP_TOOLCHAIN_BUNDLE: bundle, CAMP_IMAGE_RECEIPT: imageReceipt } });
  const prior = JSON.parse(await readFile(env.CAMP_STORAGE_SOURCE_RECEIPT ?? '.camp/parallel-infra-latest.json', 'utf8'));
  const source = prior.cases.find(row => row.kind === 'complete'); assert.ok(source?.resultReady);
  const folder = resolve('.camp/two-host', id); await mkdir(folder, { recursive: true, mode: 0o700 });
  const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
  const login = await fetch(apiUrl + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }), redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(login.status, 200); const auth = await login.json();
  async function human(path, body, expected = 200, method) {
    const response = await fetch(apiUrl + '/api' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: 'Bearer ' + auth.accessToken, 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15000) });
    const value = await response.json(); assert.equal(response.status, expected, `Two-host control request rejected: ${path} (${response.status}, ${value.code ?? 'unknown'})`); return value;
  }
  let credential, operationId, foreignChannelId, foreignRoomId, foreignCredential, bootstrapped = false, activated = false, success = false, revoked = false, credentialRemoved = false;
  const moved = [];
  const helper = join(remote.operation, 'probe/scripts/mvp/two-host-target.mjs');
  const runRemote = (action, input, timeoutMs = 300000) => sshJson(remote.alias, ['timeout', '--signal=TERM', '--kill-after=45s', action === 'continue' ? '450s' : '240s', 'node', helper, action, remote.operation], input, { timeoutMs });
  const interruptedSignal = new AbortController();
  const onStop = () => interruptedSignal.abort(new Error('Two-host managed acceptance interrupted'));
  const stopSignals = remote.managedTunnel ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : [];
  const tunnel = managedTunnelOwner({ enabled: remote.managedTunnel, factory: createSshWorkerTunnel, options: { hostAlias: remote.alias, localApiPort: Number(new URL(apiUrl).port), remotePort: Number(new URL(remote.apiUrl).port), signal: interruptedSignal.signal }, apiUrl: remote.apiUrl });
  const storagePath = `/camp/rooms/${source.roomId}/storage`, operationsPath = `/camp/rooms/${source.roomId}/storage-operations`;
  const sourceHome = join(source.folder, 'runtime'), sourceCheckout = join(source.folder, 'project'), sourceBundle = join(folder, 'backup');
  const runtime = new CampRuntime({ home: sourceHome, imageId: prior.imageId, toolchainBundle: bundle });
  const phases = [];
  async function phase(name, facts = {}) { phases.push({ name, at: new Date().toISOString(), ...facts }); await writeFile(join(folder, 'phases.json'), JSON.stringify(phases, null, 2), { mode: 0o600 }); }
  for (const name of stopSignals) process.on(name, onStop);
  try {
    await tunnel.start();
    await human(`/channels/${source.channelId}/unarchive`, {});
    credential = await human(`/camp/rooms/${source.roomId}/worker-token`, {}, 201);
    const localEnv = { PATH: env.PATH, LANG: 'C.UTF-8', CAMP_API_URL: apiUrl, CAMP_WORKER_TOKEN: credential.token, CAMP_RUNTIME_HOME: sourceHome, CAMP_RUNTIME_IMAGE: prior.imageId, CAMP_TOOLCHAIN_BUNDLE: bundle };
    const worker = async (path, body) => {
      const response = await fetch(apiUrl + '/api/camp/worker' + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + credential.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15000) }); assert.equal(response.status, 200); return response.json();
    };
    const before = await human(`/camp/rooms/${source.roomId}`), initial = await human(storagePath);
    assert.equal(initial.canBackup, true);
    const historical = before.goals.map(row => ({ id: row.id, finalCandidate: row.finalCandidate, executionPool: row.executionPool, status: row.status }));
    const oldPool = before.goals.find(row => row.id === source.goalId).executionPool;
    const original = await human(`/camp/rooms/${source.roomId}/goals/${source.goalId}/result`);
    assert.equal(original.resultReady, true);
    const backup = await human(operationsPath, { requestId: randomUUID(), kind: 'backup', expectedEpoch: initial.epoch, expectedAcceptedRevision: before.room.acceptedHead.revision }, 201);
    operationId = backup.operation.id;
    const plan = (await worker(`/storage-operations/${operationId}`)).plan;
    const backupReceipt = await exportNativeStore({ runtime, plan, bundlePath: sourceBundle, postReceipt: value => worker(`/storage-operations/${operationId}/backup`, value) });
    const artifact = await uploadPrivateBundle({ request: privateArtifactRequest(localEnv), operationId, receipt: backupReceipt, bundlePath: sourceBundle }); assert.equal(artifact.state, 'ready');
    const migration = await human(operationsPath, { requestId: randomUUID(), kind: 'migration', expectedEpoch: initial.epoch, expectedAcceptedRevision: before.room.acceptedHead.revision, backupOperationId: operationId }, 201);
    operationId = migration.operation.id;
    await human(`/camp/rooms/${source.roomId}/tasks`, { title: 'Maintenance must reject work', planMode: 'parallel_pair' }, 409);
    const notePrefix = 'remote-' + randomUUID().slice(0, 8);
    const harness = `import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';for(const side of ['left','right']){assert.equal(await readFile('/workspace/'+side+'-note.txt','utf8'),side+'\\n');assert.equal(await readFile('/workspace/${notePrefix}-'+side+'-note.txt','utf8'),side+'\\n');}console.log('Original and remote-only files verified');\n`;
    const files = {};
    for (const name of ['two-host-target.mjs', 'two-host-support.mjs', 'parallel-real-smoke.mjs', 'owned-child.mjs']) files[name] = (await readFile(new URL(name, import.meta.url))).toString('base64');
    const remoteEnv = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', CAMP_API_URL: remote.apiUrl, CAMP_WORKER_TOKEN: credential.token, CAMP_RUNTIME_HOME: join(remote.operation, 'runtime'), CAMP_RUNTIME_IMAGE: prior.imageId, CAMP_TOOLCHAIN_BUNDLE: remote.toolchain, CAMP_STORAGE_BUNDLE: join(remote.operation, 'backup'), CAMP_WORKER_ID: id, CAMP_VERIFICATION_HARNESSES: join(remote.operation, 'harnesses.json') };
    await sshJson(remote.alias, ['node', '--input-type=module', '-e', bootstrapSource, remote.release, remote.operation], { files, env: remoteEnv, harness, input: { release: remote.release, releaseDigest: remote.releaseDigest, operationId, roomId: source.roomId, notePrefix, toolchainDigest: prior.toolchainDigest, baseline: original, absentPaths: [sourceHome, sourceCheckout, sourceBundle] } });
    bootstrapped = true;
    const remoteFacts = await runRemote('preflight');
    const localFacts = { machineIdHash: digest((await readFile('/etc/machine-id', 'utf8')).trim()), bootIdHash: digest((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()), dockerIdHash: digest((await runtime.dockerCall(['info', '--format', '{{.ID}}'])).stdout.trim()) };
    for (const field of ['machineIdHash', 'bootIdHash', 'dockerIdHash']) assert.notEqual(remoteFacts[field], localFacts[field], 'Two-host acceptance requires independent machine/kernel/Docker identities');
    assert.equal(remoteFacts.imageId, prior.imageId); assert.equal(remoteFacts.toolchainDigest, prior.toolchainDigest);
    await phase('two_independent_hosts_verified', { source: localFacts, target: remoteFacts });
    // Channel handles share Raft's 32-character name contract.
    const isolationName = 'camp-auth-' + randomUUID().replaceAll('-', '').slice(0, 20);
    const foreignChannel = await human('/channels/', { name: isolationName, visibility: 'public', description: 'Scoped credential isolation probe' });
    foreignChannelId = foreignChannel.channel?.id ?? foreignChannel.id;
    const foreignRoom = await human('/camp/rooms', { channelId: foreignChannelId, name: isolationName, project: { name: 'Isolated credential probe' } }, 201);
    foreignRoomId = foreignRoom.id;
    foreignCredential = await human(`/camp/rooms/${foreignRoomId}/worker-token`, {}, 201);
    await runRemote('auth-wrong-room', { token: foreignCredential.token });
    for (const path of [sourceHome, sourceCheckout, sourceBundle]) { const hidden = path + '-unavailable-' + id; await rename(path, hidden); moved.push([hidden, path]); }
    let interrupted;
    if (remote.networkFault) {
      interrupted = await sshGatedJson(remote.alias, ['timeout', '--signal=TERM', '--kill-after=45s', '240s', 'node', helper, 'download-network-fault', remote.operation], { signal: interruptedSignal.signal, onPhase: async facts => { await phase('remote_first_part_persisted', facts); await tunnel.close(); await phase('owned_api_tunnel_closed'); } });
      assert.equal(interrupted.realNetworkInterrupted, true);
      assert.equal(interrupted.artifactId, artifact.id); assert.equal(interrupted.transferManifestDigest, artifact.manifestDigest);
      await tunnel.start();
      await phase('owned_api_tunnel_reconnected');
    } else {
      interrupted = await runRemote('download-interrupted'); assert.equal(interrupted.requestHookInterrupted, true);
    }
    const downloaded = await runRemote('download'); assert.equal(downloaded.artifactId, artifact.id);
    const restored = await runRemote('restore');
    assert.equal(restored.receipt.verifiedCandidates, plan.candidates.length); assert.equal(restored.receipt.historyVerified, true);
    assert.notEqual(restored.receipt.targetStorageId, initial.storageId);
    await runRemote('export-baseline');
    await human(`${operationsPath}/${operationId}/activate`, { expectedEpoch: initial.epoch + 1, expectedTargetStorageId: restored.receipt.targetStorageId }, 409);
    const activation = { expectedEpoch: initial.epoch, expectedTargetStorageId: restored.receipt.targetStorageId };
    await human(`${operationsPath}/${operationId}/activate`, activation); await human(`${operationsPath}/${operationId}/activate`, activation); activated = true;
    const active = await human(`/camp/rooms/${source.roomId}`), storage = await human(storagePath);
    assert.equal(storage.epoch, initial.epoch + 1); assert.deepEqual(active.room.acceptedHead, before.room.acceptedHead);
    assert.deepEqual(active.goals.map(row => ({ id: row.id, finalCandidate: row.finalCandidate, executionPool: row.executionPool, status: row.status })), historical);
    const oldClaim = () => worker('/claim', { workerId: oldPool.workerIds[0], protocol: { ...createWorkerDeclaration(), executionPool: oldPool } });
    const idleFence = await oldClaim(); assert.equal(idleFence.run, null); assert.equal(idleFence.compatibility.code, 'storage_mismatch');
    const legacy = await worker('/claim', { workerId: 'two-host-unpooled', protocol: { ...createWorkerDeclaration(), protocolVersions: [1, 2, 3] } }); assert.equal(legacy.run, null); assert.equal(legacy.compatibility.code, 'pool_required');
    const currentPolicy = active.room.verificationPolicy;
    await human(`/camp/rooms/${source.roomId}/verification-policy`, { expectedDigest: currentPolicy.digest, policy: { ...currentPolicy.policy, revision: currentPolicy.policy.revision + 1, checks: [{ id: 'notes', label: 'Original and new remote notes', argv: ['node', '/camp-checks/pair-contract'], timeoutMs: 30000, harness: { id: 'pair-contract', sha256: createHash('sha256').update(harness).digest('hex') } }] } }, 200, 'PUT');
    const title = 'Continue on the second host: ' + id;
    const submitted = await human(`/camp/rooms/${source.roomId}/tasks`, { title, planMode: 'parallel_pair' }, 201); const goal = submitted.goals.find(row => row.title === title); assert.ok(goal);
    const readyFence = await oldClaim(); assert.equal(readyFence.run, null); assert.equal(readyFence.compatibility.code, 'storage_mismatch');
    assert.equal((await human(`/camp/rooms/${source.roomId}`)).goals.find(row => row.id === goal.id).usage.runs, 0);
    const execution = await runRemote('continue', undefined, 480000);
    const finished = await human(`/camp/rooms/${source.roomId}`), result = await human(`/camp/rooms/${source.roomId}/goals/${goal.id}/result`);
    assert.equal(result.resultReady, true); assert.equal(result.verification.receipt.status, 'passed');
    assert.notEqual(result.candidate.refId, original.candidate.refId); assert.notEqual(result.candidate.rootId, original.candidate.rootId);
    assert.equal(finished.room.acceptedHead.revision, before.room.acceptedHead.revision + 1);
    const delivered = finished.goals.find(row => row.id === goal.id); assert.equal(delivered.executionPool.storageId, restored.receipt.targetStorageId); assert.notEqual(delivered.executionPool.poolId, oldPool.poolId);
    await runRemote('record-result', result); const exported = await runRemote('export-result');
    const final = await runRemote('final'); assert.equal(final.releaseDigest, remoteFacts.releaseDigest);
    const receipt = { event: 'two_host_storage_passed', at: new Date().toISOString(), actualHostCount: 2, modelCalls: 0, roleOutputs: 'synthetic', managedTunnel: remote.managedTunnel, roomId: source.roomId, sourceGoalId: source.goalId, continuationGoalId: goal.id, imageId: prior.imageId, toolchainDigest: prior.toolchainDigest, source: localFacts, target: remoteFacts, sourceStorageId: initial.storageId, targetStorageId: restored.receipt.targetStorageId, storageEpoch: storage.epoch, artifactId: artifact.id, manifestDigest: backupReceipt.manifestDigest, wholeHistoryVerified: true, preservedCandidates: restored.receipt.verifiedCandidates, sourcePathsUnavailable: true, corruptBundleRejected: true, activationCasAndReplay: true, oldIdleAndReadyHostFenced: true, legacyBypassRejected: true, ...interrupted, ...execution, ...exported, ...final, wrongRoomCredentialRejected: true, revokedCredentialRejected: true, ownedRemoteProcessStopped: true, remoteCredentialRemoved: true };
    return await settleTwoHostProbe({
      stopOwned: async () => { const stopped = await runRemote('stop-owned'); assert.ok(stopped.ownedProcessAbsent || stopped.ownedProcessStopped); },
      restoreSources: async () => { while (moved.length) { const [hidden, originalPath] = moved.at(-1); await rename(hidden, originalPath); moved.pop(); } },
      revokeCredential: async () => { await human(`/camp/rooms/${source.roomId}/worker-tokens/${credential.tokenId}/revoke`, {}); revoked = true; },
      probeRevoked: () => runRemote('auth-revoked'),
      removeCredential: async () => { await runRemote('clear-credential'); credentialRemoved = true; },
      revokeForeign: async () => { await human(`/camp/rooms/${foreignRoomId}/worker-tokens/${foreignCredential.tokenId}/revoke`, {}); foreignCredential = null; },
      archiveFixtures: async () => { await human(`/channels/${foreignChannelId}/archive`, {}); foreignChannelId = null; await human(`/channels/${source.channelId}/archive`, {}); },
      closeTunnel: async () => { await tunnel.close(); interruptedSignal.signal.throwIfAborted(); },
      publish: async () => { await phase('passed', { activated, evidencePreserved: true, cleanupUnknown: false }); await writeFile(join(folder, 'result.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); await writeFile('.camp/two-host-storage-latest.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); success = true; console.log(JSON.stringify(receipt)); return receipt; },
    });
  } finally {
    for (const name of stopSignals) process.off(name, onStop);
    // Stop only the PID attested by this operation, and preserve all Store and
    // journal evidence. Failure to reconnect is cleanup-unknown, never success.
    if (!success) {
      const failed = await compensateProbe([
        ['remote_process', async () => { if (bootstrapped && !credentialRemoved) await runRemote('stop-owned'); }],
        ...[...moved].reverse().map(([hidden, originalPath], index) => ['source_path_' + index, () => rename(hidden, originalPath)]),
        ['cancel_operation', async () => { if (!activated && operationId) await human(`${operationsPath}/${operationId}/cancel`, {}); }],
        ['cancel_goals', async () => { const snapshot = await human(`/camp/rooms/${source.roomId}`); const failures = await compensateProbe(snapshot.goals.filter(goal => goal.canCancel).map(goal => [goal.id, () => human(`/camp/rooms/${source.roomId}/goals/${goal.id}/cancel`, {})])); assert.equal(failures.length, 0); }],
        ['revoke_credential', async () => { if (credential && !revoked) await human(`/camp/rooms/${source.roomId}/worker-tokens/${credential.tokenId}/revoke`, {}); }],
        ['revoke_foreign', async () => { if (foreignCredential) await human(`/camp/rooms/${foreignRoomId}/worker-tokens/${foreignCredential.tokenId}/revoke`, {}); }],
        ['remove_credential', async () => { if (bootstrapped && !credentialRemoved) await runRemote('clear-credential'); }],
        ['archive_foreign', async () => { if (foreignChannelId) await human(`/channels/${foreignChannelId}/archive`, {}); }],
        ['archive_source', () => human(`/channels/${source.channelId}/archive`, {})],
        ['close_owned_tunnel', () => tunnel.close()],
      ]);
      await phase('failed', { activated, evidencePreserved: true, cleanupUnknown: true, physicalResourcesVerified: false, failedCleanup: failed });
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) twoHostMain().catch(() => { console.error(JSON.stringify({ event: 'two_host_storage_failed', evidence: '.camp/two-host' })); process.exitCode = 1; });
