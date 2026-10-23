// Real browser and authentication, with isolated Camp HTTP responses. No
// Store, backup, migration, Run or model is created by this fixture check.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { parseCandidate } from '../../packages/camp-protocol/src/index.js';

const api = process.env.CAMP_API_URL ?? 'http://127.0.0.1:13018', web = process.env.CAMP_WEB_URL ?? 'http://localhost:15190';
const origin = new URL(web).origin, seed = JSON.parse(await readFile('.dev-env-camp.json', 'utf8'));
const login = await fetch(api + '/api/auth/login', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed.user.email, password: seed.user.password }) });
assert.equal(login.status, 200); const auth = await login.json();
const roomId = randomUUID(), backupId = randomUUID(), migrationId = randomUUID(), recoveryMigrationId = randomUUID(), now = new Date().toISOString();
const source = 'a'.repeat(64), target = 'b'.repeat(64), manifestDigest = 'c'.repeat(64), planDigest = 'd'.repeat(64);
const candidate = parseCandidate({ type: 'layerfs', projectId: 'p-' + 'a'.repeat(16), refKind: 'layer', refId: '32' + 'a'.repeat(64), rootId: 'e'.repeat(64), imageId: 'sha256:' + 'f'.repeat(64) });
const backupReceipt = { schemaVersion: 1, operationId: backupId, manifestDigest, storeSha256: '1'.repeat(64), bytes: 1048576, toolchainDigest: '2'.repeat(64), imageId: candidate.imageId, candidateCount: 12, sourceStorageId: source, stopped: true, verified: true };
function operation(id, kind, phase, extra = {}) {
  return { id, roomId, requestId: randomUUID(), kind, phase, plan: { schemaVersion: 1, operationId: id, roomId, kind, storageEpoch: storage.epoch, sourceStorageId: storage.storageId, acceptedRevision: 3, acceptedCandidate: candidate, projectId: candidate.projectId, candidates: [candidate] }, planDigest, candidateCount: 12, inventoryTruncated: true, backupReceipt: null, restoreReceipt: null, originBackupOperationId: null, createdAt: now, updatedAt: now, completedAt: null, canActivate: false, canCancel: true, canRestoreFromBackup: false, ...extra };
}
const storage = { epoch: 4, storageId: source, maintenance: false, activeOperationId: null, operations: [], operationsTruncated: false, canBackup: true, canMigrate: true, blockers: [] };
const state = { room: { id: roomId, channelId: seed.channel.id, name: 'Storage UI fixture', project: { name: 'storage-fixture' }, roles: [], storageId: source, acceptedHead: { revision: 3, goalId: null, candidate } }, storage, goals: [], tasks: [], runs: [], events: [], canManage: true, canSubmit: true, roomBusy: false };
const writes = [], errors = [], downloads = [];
const folder = resolve('.camp/storage-ui', Date.now().toString(36)); await mkdir(folder, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US', acceptDownloads: true });
  await context.addInitScript(({ accessToken, refreshToken, origin }) => { if (location.origin !== origin) return; localStorage.setItem('slock_access_token', accessToken); localStorage.setItem('slock_refresh_token', refreshToken); localStorage.setItem('slock_locale', 'en'); }, { ...auth, origin });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.route('**/api/camp/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice('/api/camp'.length), method = request.method();
    assert.ok(request.headers().authorization === 'Bearer ' + auth.accessToken, 'Fixture requests require the authenticated session');
    assert.equal(request.headers()['x-server-id'], seed.server.id);
    let data;
    if (path === '/rooms' && method === 'GET') data = { rooms: [state.room] };
    else if (path === '/rooms/' + roomId && method === 'GET') data = state;
    else if (path === `/rooms/${roomId}/storage-operations` && method === 'POST') {
      const body = request.postDataJSON(); writes.push({ path, body });
      assert.match(body.requestId, /^[a-f0-9-]{36}$/); assert.equal(body.expectedEpoch, storage.epoch); assert.equal(body.expectedAcceptedRevision, 3);
      if (body.kind === 'backup') {
        assert.equal(body.backupOperationId, undefined); storage.operations = [operation(backupId, 'backup', 'prepared')]; storage.activeOperationId = backupId;
      } else {
        assert.equal(body.kind, 'migration'); assert.equal(body.backupOperationId, backupId);
        const id = storage.epoch === 4 ? migrationId : recoveryMigrationId;
        storage.operations.unshift(operation(id, 'migration', 'backup_ready', { backupReceipt, originBackupOperationId: backupId })); storage.activeOperationId = id;
      }
      Object.assign(storage, { maintenance: true, canBackup: false, canMigrate: false, blockers: ['maintenance_active'] }); state.roomBusy = true;
      data = { operation: storage.operations[0], storage };
    } else if (path === `/rooms/${roomId}/storage-operations/${migrationId}/activate` && method === 'POST') {
      const body = request.postDataJSON(); writes.push({ path, body });
      assert.deepEqual(body, { expectedEpoch: 4, expectedTargetStorageId: target });
      Object.assign(storage.operations[0], { phase: 'activated', canActivate: false, canCancel: false, completedAt: now });
      Object.assign(storage, { epoch: 5, storageId: target, maintenance: false, activeOperationId: null, canBackup: true, canMigrate: true, blockers: [] });
      state.room.storageId = target; state.roomBusy = false; data = { operation: storage.operations[0], storage };
    } else throw new Error('Unexpected storage fixture request: ' + method + ' ' + path);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const url = `${web}/s/${seed.server.slug}/channel/${seed.channel.id}?tab=camp`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const panel = page.getByTestId('camp-room-panel'), storagePanel = panel.getByTestId('camp-storage-panel');
  await storagePanel.waitFor({ state: 'visible', timeout: 45000 });
  const refresh = () => panel.getByRole('button', { name: 'Refresh room', exact: true }).click();
  await storagePanel.getByRole('button', { name: 'Prepare backup', exact: true }).click();
  const sourceCommand = storagePanel.getByTestId('camp-storage-command-backup'); await sourceCommand.waitFor();
  const command = await sourceCommand.locator('code').innerText();
  assert.equal(command, `node --env-file=.camp/storage-source.env packages/camp-runtime/scripts/storage.mjs backup --operation ${backupId}`);
  assert.equal(command.includes(candidate.refId), false); assert.equal(command.includes(auth.accessToken), false);
  await sourceCommand.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'backup-prepared.png'), fullPage: true });
  const recovery = storagePanel.getByTestId('camp-storage-report-recovery');
  assert.equal(await recovery.getAttribute('open'), null); await recovery.locator('summary').click();
  const recoveryCommand = recovery.getByTestId('camp-storage-command-report-backup');
  assert.equal(await recoveryCommand.locator('code').innerText(), `node --env-file=.camp/storage-recovery.env packages/camp-runtime/scripts/storage.mjs report-backup --operation ${backupId}`);
  await recovery.getByText(/does not recreate the source Store or switch storage automatically/).waitFor();
  assert.equal(writes.length, 1, 'Viewing backup recovery guidance must not mutate storage');
  await recoveryCommand.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'backup-receipt-recovery.png'), fullPage: true });

  Object.assign(storage.operations[0], { phase: 'completed', canCancel: false, canRestoreFromBackup: true, backupReceipt, completedAt: now });
  Object.assign(storage, { maintenance: false, activeOperationId: null, canBackup: true, canMigrate: true, blockers: [] }); state.roomBusy = false;
  await refresh();
  await storagePanel.getByRole('button', { name: 'Restore or migrate from this backup', exact: true }).click();
  const restoreCommand = storagePanel.getByTestId('camp-storage-command-restore'); await restoreCommand.waitFor();
  assert.equal(await restoreCommand.locator('code').innerText(), `node --env-file=.camp/storage-target.env packages/camp-runtime/scripts/storage.mjs restore --operation ${migrationId}`);
  assert.equal(await storagePanel.getByTestId('camp-storage-command-backup').count(), 0);
  const migration = storagePanel.locator(`[data-testid=camp-storage-operation][data-operation-id="${migrationId}"]`);
  const transfer = migration.getByTestId('camp-storage-transfer'); await transfer.locator('summary').click();
  assert.equal(await transfer.getByTestId('camp-storage-command-upload').locator('code').innerText(), `node --env-file=.camp/storage-source.env packages/camp-runtime/scripts/artifacts.mjs upload --operation ${backupId}`);
  assert.equal(await transfer.getByTestId('camp-storage-command-download').locator('code').innerText(), `node --env-file=.camp/storage-target.env packages/camp-runtime/scripts/artifacts.mjs download --operation ${migrationId}`);
  assert.equal(writes.length, 2, 'Viewing transfer commands must not start a transfer or activate storage');
  await transfer.getByText(/restore verification and explicit activation are still required/).waitFor();
  await migration.getByText(backupId, { exact: true }).waitFor();
  const inventory = migration.getByTestId('camp-storage-inventory'); await inventory.locator('summary').click();
  await inventory.getByText('Showing 1 of 12 references. The backup and validation use the complete frozen inventory.', { exact: true }).waitFor();
  assert.equal(await inventory.locator('li').count(), 1);
  assert.equal(await migration.getByTestId('camp-storage-manifest-digest').locator('dd').innerText(), manifestDigest);
  await restoreCommand.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'migration-backup-ready.png'), fullPage: true });

  Object.assign(storage.operations[0], { phase: 'restore_ready', canActivate: true, restoreReceipt: { ...backupReceipt, operationId: migrationId, targetStorageId: target, verifiedCandidates: 12, historyVerified: true } });
  await refresh(); const activate = migration.getByRole('button', { name: 'Activate verified target', exact: true }); await activate.waitFor();
  assert.equal(writes.length, 2, 'Restore readiness must not activate automatically');
  await migration.getByText(/old host will be refused new claims/).waitFor();
  await activate.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'restore-ready.png'), fullPage: true });
  await activate.click(); await migration.getByText('Migration activated', { exact: true }).waitFor();
  assert.equal(writes.length, 3); assert.equal(await migration.getByRole('button', { name: 'Activate verified target', exact: true }).count(), 0);
  await panel.getByRole('region', { name: 'Current accepted project version' }).getByText(candidate.refId, { exact: true }).waitFor();
  await migration.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'migration-activated.png'), fullPage: true });

  const originalBackup = storagePanel.locator(`[data-testid=camp-storage-operation][data-operation-id="${backupId}"]`);
  await originalBackup.getByText(/changed storage location does not invalidate it/).waitFor();
  await originalBackup.getByRole('button', { name: 'Restore or migrate from this backup', exact: true }).click();
  const relocatedRestore = storagePanel.locator(`[data-testid=camp-storage-operation][data-operation-id="${recoveryMigrationId}"]`);
  await relocatedRestore.getByTestId('camp-storage-command-restore').waitFor();
  assert.equal(writes.length, 4); assert.equal(writes[3].body.expectedEpoch, 5); assert.equal(writes[3].body.backupOperationId, backupId);
  assert.equal(storage.operations[0].plan.sourceStorageId, target); assert.equal(storage.operations[0].backupReceipt.sourceStorageId, source);
  await relocatedRestore.getByTestId('camp-storage-command-restore').scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'old-backup-new-location.png'), fullPage: true });

  storage.operations.unshift(operation(randomUUID(), 'migration', 'prepared')); state.canManage = false; await refresh();
  await storagePanel.getByText(/room administrator must prepare or activate/).waitFor();
  assert.equal(await storagePanel.getByTestId('camp-storage-command-backup').count(), 0);
  assert.equal(await storagePanel.getByTestId('camp-storage-command-restore').count(), 0);
  assert.equal(await storagePanel.getByTestId('camp-storage-command-report-backup').count(), 0);
  assert.equal(await storagePanel.getByTestId('camp-storage-transfer').count(), 0);
  for (const name of ['Prepare backup', 'Prepare migration', 'Activate verified target', 'Cancel storage operation', 'Restore or migrate from this backup']) assert.equal(await storagePanel.getByRole('button', { name, exact: true }).count(), 0);
  await storagePanel.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(folder, 'member-read-only.png'), fullPage: true });
  assert.equal(await panel.getByTestId('camp-room-error').count(), 0); assert.deepEqual(errors, []); assert.deepEqual(downloads, []);
  const receipt = { event: 'storage_ui_fixture_passed', url, realBrowser: true, realHttpAuth: true, campApiIntercepted: true, roleOutputs: 'none', campDatabaseMutations: 0, modelCalls: 0, storageOperationsExecuted: 0, fixtureMutations: writes.length, preparedBackupCommand: true, lostReceiptRecoveryGuidance: true, completedBackupRestore: true, backupSurvivesStorageRelocation: true, explicitPrivateTransferCommands: true, explicitTargetActivation: true, frozenPlanAndBundleDigestsSeparated: true, boundedInventoryCount: true, acceptedCandidatePreserved: true, memberReadOnly: true, folder };
  await writeFile('.camp/storage-ui-latest.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(receipt, null, 2));
} finally { await browser.close(); }
