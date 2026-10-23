// Real API/PostgreSQL/Docker/LayerFS storage lifecycle; zero provider requests.
// Creates a completed, archived infrastructure fixture and leaves its old Store
// intact. CAMP_STORAGE_SOURCE_RECEIPT can select an unused completed fixture.
// Stop the live host manager before running this acceptance probe.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CampRuntime } from '../../packages/camp-runtime/src/index.mjs';
import { exportCandidate } from '../../packages/camp-runtime/src/export.mjs';
import { exportNativeStore } from '../../packages/camp-runtime/src/native-store.mjs';
import { createWorkerDeclaration } from '../../packages/camp-protocol/src/index.js';
import { superviseOwnedChild } from './owned-child.mjs';

if (!process.argv.includes('--real-infra')) throw new Error('Use --real-infra for this explicit zero-model storage probe');
const execute = promisify(execFile);
const apiUrl = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018';
const toolchain = resolve(process.env.CAMP_TOOLCHAIN_BUNDLE ?? 'packages/camp-runtime/.local/toolchain-bundle-review-0.6.0');
if (!process.env.CAMP_STORAGE_SOURCE_RECEIPT) {
  await execute(process.execPath, ['scripts/mvp/parallel-real-smoke.mjs', '--real-infra', '--case=complete'], {
    timeout: 420000, maxBuffer: 1024 * 1024,
    env: { ...process.env, CAMP_API_URL: apiUrl, CAMP_TOOLCHAIN_BUNDLE: toolchain, CAMP_IMAGE_RECEIPT: process.env.CAMP_IMAGE_RECEIPT ?? 'packages/camp-runtime/.local/parallel-review-image.json' },
  });
}
const prior = JSON.parse(await readFile(process.env.CAMP_STORAGE_SOURCE_RECEIPT ?? '.camp/parallel-infra-latest.json', 'utf8'));
const source = prior.cases.find(row => row.kind === 'complete');
assert.ok(source?.resultReady, 'A completed parallel infrastructure fixture is required');
const folder = resolve('.camp/storage', `camp-storage-${Date.now().toString(36)}`);
await mkdir(folder, { recursive: true, mode: 0o700 });
const sourceHome = join(source.folder, 'runtime'), targetHome = join(folder, 'restored-runtime');
const bundle = join(folder, 'backup'), imageId = prior.imageId;
const seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const login = await fetch(apiUrl + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }), redirect: 'error', signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 200);
const auth = await login.json();
async function human(path, body, expected = 200) {
  const response = await fetch(apiUrl + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + auth.accessToken, 'x-server-id': seed.server.id, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  assert.equal(response.status, expected, `Storage API ${path} returned ${response.status}: ${result.code ?? 'no code'}`);
  return result;
}
let token;
async function worker(path, body, expected = 200) {
  const response = await fetch(apiUrl + '/api/camp/worker' + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  assert.equal(response.status, expected, `Storage worker API ${path} returned ${response.status}: ${result.code ?? 'no code'}`);
  return result;
}
const storagePath = `/camp/rooms/${source.roomId}/storage`;
const operationsPath = `/camp/rooms/${source.roomId}/storage-operations`;
const envFor = (home, backup = bundle) => ({ PATH: process.env.PATH, LANG: 'C.UTF-8', CAMP_API_URL: apiUrl, CAMP_WORKER_TOKEN: token, CAMP_RUNTIME_HOME: home, CAMP_RUNTIME_IMAGE: imageId, CAMP_TOOLCHAIN_BUNDLE: toolchain, CAMP_STORAGE_BUNDLE: backup, CAMP_WORKER_ID: 'storage-acceptance', CAMP_VERIFICATION_HARNESSES: join(source.folder, 'harnesses.json') });
async function cli(command, operationId, home, backup = bundle) {
  return execute(process.execPath, ['packages/camp-runtime/scripts/storage.mjs', command, '--operation', operationId], { timeout: 180000, maxBuffer: 1024 * 1024, env: envFor(home, backup) });
}
let operationId, owner, sourceMoved = false, sourceHomeMoved = false, firstTargetMoved = false, success = false;
const sourcePath = join(source.folder, 'project'), unavailableSource = join(source.folder, 'project-unavailable-during-storage-proof');
const unavailableHome = join(source.folder, 'runtime-unavailable-during-storage-proof');
const unavailableTarget = join(folder, 'restored-runtime-unavailable-during-proof');
try {
  await human(`/channels/${source.channelId}/unarchive`, {});
  token = (await human(`/camp/rooms/${source.roomId}/worker-token`, {}, 201)).token;
  const before = await human(`/camp/rooms/${source.roomId}`), initial = await human(storagePath);
  assert.equal(initial.canBackup, true);
  const originalPool = before.goals.find(row => row.id === source.goalId).executionPool;
  const historical = before.goals.map(row => ({ id: row.id, status: row.status, finalCandidate: row.finalCandidate, executionPool: row.executionPool }));
  const requestId = randomUUID(), backupRequest = { requestId, kind: 'backup', expectedEpoch: initial.epoch, expectedAcceptedRevision: before.room.acceptedHead.revision };
  const admitted = await Promise.all([human(operationsPath, backupRequest, 201), human(operationsPath, backupRequest, 201)]);
  operationId = admitted[0].operation?.id ?? admitted[0].id;
  assert.ok(operationId); assert.equal(admitted[1].operation?.id ?? admitted[1].id, operationId);
  await human(`/camp/rooms/${source.roomId}/tasks`, { title: 'Must remain blocked by storage maintenance', planMode: 'parallel_pair' }, 409);
  const maintenanceClaim = await worker('/claim', { workerId: originalPool.workerIds[0], protocol: { ...createWorkerDeclaration(), executionPool: originalPool } });
  assert.equal(maintenanceClaim.run, null);
  const pendingBackup = await worker(`/storage-operations/${operationId}`);
  await assert.rejects(exportNativeStore({
    runtime: new CampRuntime({ home: sourceHome, imageId, toolchainBundle: toolchain }),
    plan: pendingBackup.plan, bundlePath: bundle,
    postReceipt: async () => { throw Object.assign(new Error('Injected source acknowledgement transport failure'), { code: 'camp_api_transport' }); },
  }), { code: 'camp_api_transport' });
  assert.equal((await worker(`/storage-operations/${operationId}`)).operation.phase, 'prepared');
  const immutableManifest = await readFile(join(bundle, 'manifest.json'));
  await rename(sourceHome, unavailableHome); sourceHomeMoved = true;
  const recoveryHome = join(folder, 'receipt-recovery-runtime');
  await cli('report-backup', operationId, recoveryHome);
  await cli('report-backup', operationId, recoveryHome);
  assert.deepEqual(await readFile(join(bundle, 'manifest.json')), immutableManifest);
  const afterBackup = await human(storagePath);
  const backupOperation = afterBackup.operations.find(row => row.id === operationId);
  assert.equal(backupOperation.phase, 'completed'); assert.ok(backupOperation.backupReceipt);
  assert.equal(afterBackup.maintenance, false);
  const migrationRequest = { requestId: randomUUID(), kind: 'migration', expectedEpoch: initial.epoch, expectedAcceptedRevision: before.room.acceptedHead.revision, backupOperationId: operationId };
  const migration = await human(operationsPath, migrationRequest, 201);
  const backupId = operationId;
  operationId = migration.operation?.id ?? migration.id;
  const discovery = await worker(`/storage-operations/${operationId}`);
  assert.equal(discovery.operation.phase, 'backup_ready');
  assert.equal(discovery.plan.backupOperationId, backupId);
  // A corrupt copied bundle cannot become a target receipt or replace a Store.
  const corrupt = join(folder, 'corrupt-backup'); await cp(bundle, corrupt, { recursive: true });
  const dbFile = await open(join(corrupt, 'store.sqlite'), 'r+');
  try { await dbFile.write(Buffer.from('corrupt'), 0, 7, 100); await dbFile.sync(); }
  finally { await dbFile.close(); }
  await assert.rejects(cli('restore', operationId, join(folder, 'corrupt-target'), corrupt));
  assert.equal((await worker(`/storage-operations/${operationId}`)).operation.phase, 'backup_ready');
  // The destination must not depend on the original host's checkout path.
  await rename(sourcePath, unavailableSource); sourceMoved = true;
  await cli('restore', operationId, targetHome);
  await cli('restore', operationId, targetHome);
  const restored = await worker(`/storage-operations/${operationId}`);
  assert.equal(restored.operation.phase, 'restore_ready');
  let receipt = restored.operation.restoreReceipt;
  assert.equal(receipt.verifiedCandidates, discovery.plan.candidates.length);
  assert.equal(receipt.historyVerified, true);
  assert.notEqual(receipt.targetStorageId, initial.storageId);
  await human(`${operationsPath}/${operationId}/activate`, { expectedEpoch: initial.epoch + 1, expectedTargetStorageId: receipt.targetStorageId }, 409);
  const activation = { expectedEpoch: initial.epoch, expectedTargetStorageId: receipt.targetStorageId };
  await human(`${operationsPath}/${operationId}/activate`, activation);
  await human(`${operationsPath}/${operationId}/activate`, activation);
  const activated = await human(`/camp/rooms/${source.roomId}`), activeStorage = await human(storagePath);
  assert.equal(activeStorage.epoch, initial.epoch + 1);
  assert.equal(activeStorage.storageId, receipt.targetStorageId);
  assert.deepEqual(activated.room.acceptedHead, before.room.acceptedHead);
  assert.deepEqual(activated.goals.map(row => ({ id: row.id, status: row.status, finalCandidate: row.finalCandidate, executionPool: row.executionPool })), historical);
  // Placement changes must not invalidate the only valid backup. Simulate
  // losing the first destination immediately after activation, before a new
  // backup or Goal can run, and restore the original artifact once more.
  const firstTargetStorageId = receipt.targetStorageId;
  await rename(targetHome, unavailableTarget); firstTargetMoved = true;
  const second = await human(operationsPath, { requestId: randomUUID(), kind: 'migration', expectedEpoch: activeStorage.epoch, expectedAcceptedRevision: before.room.acceptedHead.revision, backupOperationId: backupId }, 201);
  operationId = second.operation.id;
  const secondPlan = (await worker(`/storage-operations/${operationId}`)).plan;
  assert.equal(secondPlan.sourceStorageId, firstTargetStorageId);
  assert.equal(secondPlan.storageEpoch, initial.epoch + 1);
  const finalHome = join(folder, 'recovered-after-target-loss-runtime');
  await cli('restore', operationId, finalHome);
  const recovered = (await worker(`/storage-operations/${operationId}`)).operation;
  receipt = recovered.restoreReceipt;
  assert.equal(receipt.sourceStorageId, initial.storageId, 'The artifact retains its original physical provenance');
  assert.deepEqual(recovered.backupReceipt, backupOperation.backupReceipt);
  await human(`${operationsPath}/${operationId}/activate`, { expectedEpoch: initial.epoch + 1, expectedTargetStorageId: receipt.targetStorageId });
  const secondStorage = await human(storagePath);
  assert.equal(secondStorage.epoch, initial.epoch + 2);
  assert.equal(secondStorage.storageId, receipt.targetStorageId);
  assert.deepEqual((await human(`/camp/rooms/${source.roomId}`)).room.acceptedHead, before.room.acceptedHead);
  const middleClaim = await worker('/claim', { workerId: originalPool.workerIds[0], protocol: { ...createWorkerDeclaration(), executionPool: { ...originalPool, storageId: firstTargetStorageId } } });
  assert.equal(middleClaim.run, null); assert.equal(middleClaim.compatibility.code, 'storage_mismatch');
  const runtime = await new CampRuntime({ home: finalHome, imageId, toolchainBundle: toolchain }).ready();
  const output = join(folder, 'restored-files');
  await exportCandidate({ runtime, candidate: discovery.plan.acceptedCandidate, roomId: source.roomId, goalId: source.goalId, output });
  for (const side of ['left', 'right']) assert.equal(await readFile(join(output, side + '-note.txt'), 'utf8'), side + '\n');
  // Use an older serial contract so this actually exercises storage fencing,
  // rather than merely rejecting v1-v3 against a v4 parallel requirement.
  const serialTitle = 'Storage fencing probe for an older serial contract';
  const serial = await human(`/camp/rooms/${source.roomId}/tasks`, { title: serialTitle, planMode: 'sequential' }, 201);
  const serialGoal = serial.goals.find(row => row.title === serialTitle); assert.ok(serialGoal);
  assert.ok(serialGoal.protocolVersion < 4);
  const oldSerialClaim = await worker('/claim', { workerId: originalPool.workerIds[0], protocol: { ...createWorkerDeclaration(), executionPool: originalPool } });
  assert.equal(oldSerialClaim.run, null); assert.equal(oldSerialClaim.compatibility.code, 'storage_mismatch');
  const legacyClaim = await worker('/claim', { workerId: 'old-unpooled', protocol: { ...createWorkerDeclaration(), protocolVersions: [1, 2, 3] } });
  assert.equal(legacyClaim.run, null); assert.equal(legacyClaim.compatibility.code, 'pool_required');
  assert.equal((await human(`/camp/rooms/${source.roomId}`)).goals.find(row => row.id === serialGoal.id).usage.runs, 0);
  await human(`/camp/rooms/${source.roomId}/goals/${serialGoal.id}/cancel`, {});
  const title = 'Continue from the preserved candidate at a restored location';
  const submitted = await human(`/camp/rooms/${source.roomId}/tasks`, { title, planMode: 'parallel_pair' }, 201);
  const nextGoal = submitted.goals.find(row => row.title === title); assert.ok(nextGoal);
  const staleClaim = await worker('/claim', { workerId: originalPool.workerIds[0], protocol: { ...createWorkerDeclaration(), executionPool: originalPool } });
  assert.equal(staleClaim.run, null); assert.equal(staleClaim.compatibility.code, 'storage_mismatch');
  const inputPath = join(folder, 'child.json'); await writeFile(inputPath, JSON.stringify({ apiUrl, kind: 'complete' }), { mode: 0o600 });
  const log = await open(join(folder, 'continued-pool.log'), 'a', 0o600);
  const child = spawn(process.execPath, ['scripts/mvp/parallel-real-smoke.mjs', '--child', inputPath], { stdio: ['ignore', log.fd, log.fd], env: { ...envFor(finalHome), DEEPSEEK_API_KEY: 'synthetic-unused-no-provider-requests' } });
  owner = superviseOwnedChild(child, { group: false, handleSignals: true });
  let finished;
  try {
    const deadline = Date.now() + 360000;
    while (Date.now() < deadline) {
      const snapshot = await human(`/camp/rooms/${source.roomId}`), current = snapshot.goals.find(row => row.id === nextGoal.id);
      assert.ok(!['needs_attention', 'cancelled'].includes(current.status), 'Restored continuation stopped: ' + current.reason);
      if (current.status === 'completed') { finished = snapshot; break; }
      owner.assertRunning('Restored continuation'); await delay(500);
    }
    assert.ok(finished, 'Restored continuation exceeded its deadline');
    await owner.stop({ graceMs: 30000 }); owner = null;
  } finally { await owner?.stop({ graceMs: 30000 }); await log.close(); }
  assert.equal(finished.room.acceptedHead.revision, before.room.acceptedHead.revision + 1);
  const continued = finished.goals.find(row => row.id === nextGoal.id);
  assert.equal(continued.baseCandidate.refId, discovery.plan.acceptedCandidate.refId);
  assert.equal(continued.executionPool.storageId, receipt.targetStorageId);
  assert.notEqual(continued.executionPool.poolId, originalPool.poolId);
  const result = { event: 'storage_lifecycle_infrastructure_passed', at: new Date().toISOString(), modelCalls: 0, roomId: source.roomId, sourceGoalId: source.goalId, continuationGoalId: nextGoal.id, folder, sourceStorageId: initial.storageId, targetStorageId: receipt.targetStorageId, storageEpoch: secondStorage.epoch, preservedCandidates: receipt.verifiedCandidates, wholeHistoryVerified: true, corruptBundleRejected: true, sourceCheckoutUnavailable: true, sourceHomeUnavailable: true, lostBackupAcknowledgementRecovered: true, originalBackupReusedAfterTargetLoss: true, candidateFilesPreserved: true, backupAndRestoreReplayIdempotent: true, activationCasChecked: true, activationReplayIdempotent: true, historicalGoalsPreserved: true, oldLocationFenced: true, idleIntermediateLocationFenced: true, legacyBypassRejected: true, freshPoolContinuedFromAcceptedHead: true, actualHostCount: 1, independentVolumes: true };
  await writeFile('.camp/storage-infra-latest.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result)); success = true;
} finally {
  await owner?.stop({ graceMs: 30000 });
  if (sourceMoved) await rename(unavailableSource, sourcePath);
  if (sourceHomeMoved) await rename(unavailableHome, sourceHome);
  if (firstTargetMoved) await rename(unavailableTarget, targetHome);
  if (!success && operationId) await human(`${operationsPath}/${operationId}/cancel`, {}).catch(() => {});
  if (!success) {
    const snapshot = await human(`/camp/rooms/${source.roomId}`).catch(() => null);
    for (const goal of snapshot?.goals ?? []) if (goal.canCancel) await human(`/camp/rooms/${source.roomId}/goals/${goal.id}/cancel`, {}).catch(() => {});
  }
  await human(`/channels/${source.channelId}/archive`, {}).catch(() => {});
}
