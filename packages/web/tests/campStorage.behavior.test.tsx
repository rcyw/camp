import assert from "node:assert/strict";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithIntl, TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import CampRoomPanel from "../src/components/camp/CampRoomPanel";
import CampStoragePanel, { storageCommand } from "../src/components/camp/CampStoragePanel";
import { campApi } from "../src/components/camp/campApi";
import type { CampCandidate, CampSnapshot, CampStorage, CampStorageOperation } from "../src/components/camp/campApi";
import type { Channel } from "../src/store/channelStore";

const originalApi = { ...campApi }, originalPost = api.post, originalGet = api.get;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL"), originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
afterEach(() => {
  cleanup(); Object.assign(campApi, originalApi); api.post = originalPost; api.get = originalGet;
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard); else Reflect.deleteProperty(navigator, "clipboard");
  for (const [key, descriptor] of [["createObjectURL", originalCreate], ["revokeObjectURL", originalRevoke]] as const) { if (descriptor) Object.defineProperty(URL, key, descriptor); else Reflect.deleteProperty(URL, key); }
});
const roomId = "11111111-1111-4111-8111-111111111111", operationId = "22222222-2222-4222-8222-222222222222";
const backupId = "33333333-3333-4333-8333-333333333333", time = "2026-10-23T00:00:00Z";
const source = "a".repeat(64), target = "b".repeat(64), manifestDigest = "c".repeat(64), planDigest = "d".repeat(64);
const candidate: CampCandidate = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "layer", refId: "32" + "e".repeat(64), layerId: "32" + "e".repeat(64), rootId: "f".repeat(64), imageId: "sha256:" + "0".repeat(64) };
const channel: Channel = { id: "storage-channel", name: "Storage", type: "channel", description: null, createdAt: time };
function operation(overrides: Partial<CampStorageOperation> = {}): CampStorageOperation {
  return { id: operationId, roomId, kind: "migration", phase: "prepared", plan: { schemaVersion: 1, operationId, roomId, kind: "migration", storageEpoch: 4, sourceStorageId: source, acceptedRevision: 3, acceptedCandidate: candidate, projectId: candidate.projectId, candidates: [candidate] }, planDigest, backupReceipt: null, restoreReceipt: null, createdAt: time, updatedAt: time, completedAt: null, canActivate: false, canCancel: true, canRestoreFromBackup: false, candidateCount: 1, inventoryTruncated: false, ...overrides };
}
function backupReceipt(id = operationId) {
  return { schemaVersion: 1 as const, operationId: id, manifestDigest, storeSha256: "1".repeat(64), bytes: 4096, toolchainDigest: "2".repeat(64), imageId: candidate.imageId!, candidateCount: 1, sourceStorageId: source, stopped: true as const, verified: true as const };
}
function storage(overrides: Partial<CampStorage> = {}): CampStorage {
  return { epoch: 4, storageId: source, maintenance: false, activeOperationId: null, operations: [], operationsTruncated: false, canBackup: true, canMigrate: true, blockers: [], ...overrides };
}
function snapshot(state?: CampStorage): CampSnapshot {
  return { room: { id: roomId, channelId: channel.id, name: "Storage", project: { name: "Project" }, roles: [], acceptedHead: { revision: 3, goalId: "accepted-goal", candidate } }, canManage: true, canSubmit: true, roomBusy: state?.maintenance ?? false, goals: [], tasks: [], runs: [], events: [], ...(state ? { storage: state } : {}) };
}
function mockRoom(read: () => CampSnapshot | Promise<CampSnapshot>) {
  campApi.roomForChannel = async () => snapshot().room;
  campApi.snapshot = async () => read();
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const unusedAction = async () => { throw new Error("Unexpected storage mutation"); };

test("old room snapshots do not invent storage capabilities or make storage requests", async () => {
  mockRoom(() => snapshot());
  renderWithIntl(<CampRoomPanel channel={channel} />);
  await waitFor(() => assert.ok(screen.getByTestId("camp-room-panel")));
  assert.equal(screen.queryByTestId("camp-storage-panel"), null);
});

test("storage blockers and permissions are server facts while accepted references remain inspectable", async () => {
  const state = storage({ canBackup: false, canMigrate: false, blockers: ["active_goal", "cleanup_unknown", "future_blocker"] });
  const current = snapshot(state); mockRoom(() => current);
  renderWithIntl(<CampRoomPanel channel={channel} />);
  await waitFor(() => assert.ok(screen.getByTestId("camp-storage-panel")));
  assert.equal((screen.getByRole("button", { name: "Prepare backup" }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole("button", { name: "Prepare migration" }) as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByText("Finish or stop the active goal first.")); assert.ok(screen.getByText("future_blocker"));
  assert.ok(screen.getByText(/does not back up PostgreSQL, model credentials or running processes/));
  assert.ok(within(screen.getByRole("region", { name: "Current accepted project version" })).getByText(candidate.refId));
});

test("preparing a backup uses the real response envelope, one request and an explicit frozen baseline", async () => {
  const pending = deferred<{ data: { operation: CampStorageOperation; storage: CampStorage } }>();
  let current = snapshot(storage()); mockRoom(() => current);
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  api.post = (async (path: string, body: Record<string, unknown>) => { writes.push({ path, body }); return pending.promise; }) as typeof api.post;
  renderWithIntl(<CampRoomPanel channel={channel} />);
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Prepare backup" })));
  const button = screen.getByRole("button", { name: "Prepare backup" });
  await act(async () => { fireEvent.click(button); fireEvent.click(button); });
  assert.equal(writes.length, 1); assert.equal(writes[0].path, `/camp/rooms/${roomId}/storage-operations`);
  assert.deepEqual(Object.keys(writes[0].body).sort(), ["expectedAcceptedRevision", "expectedEpoch", "kind", "requestId"]);
  assert.equal(writes[0].body.kind, "backup"); assert.equal(writes[0].body.expectedEpoch, 4); assert.equal(writes[0].body.expectedAcceptedRevision, 3);
  assert.match(String(writes[0].body.requestId), /^[a-f0-9-]{36}$/);
  const created = operation({ kind: "backup" });
  const next = storage({ maintenance: true, activeOperationId: operationId, canBackup: false, canMigrate: false, operations: [created] });
  current = snapshot(next);
  await act(async () => pending.resolve({ data: { operation: created, storage: next } }));
  await waitFor(() => assert.ok(screen.getByTestId("camp-storage-command-backup")));
  assert.ok(screen.getByTestId("camp-storage-maintenance"));
  assert.equal((screen.getByRole("button", { name: "Start team" }) as HTMLButtonElement).disabled, true);
});

test("an ambiguous create response reuses its request ID and a changed baseline starts a new intent", async () => {
  let current = snapshot(storage()), writes: Record<string, unknown>[] = [];
  mockRoom(() => current);
  api.post = (async (_path: string, body: Record<string, unknown>) => { writes.push(body); throw { response: { status: 503, data: { code: "unavailable", error: "Storage request unavailable" } } }; }) as typeof api.post;
  renderWithIntl(<CampRoomPanel channel={channel} />);
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Prepare migration" })));
  fireEvent.click(screen.getByRole("button", { name: "Prepare migration" }));
  await waitFor(() => assert.ok(screen.getByText("Storage request unavailable")));
  await waitFor(() => assert.equal((screen.getByRole("button", { name: "Prepare migration" }) as HTMLButtonElement).disabled, false));
  fireEvent.click(screen.getByRole("button", { name: "Prepare migration" }));
  await waitFor(() => assert.equal(writes.length, 2)); assert.equal(writes[0].requestId, writes[1].requestId);
  current = snapshot(storage({ epoch: 5 }));
  await waitFor(() => assert.equal((screen.getByRole("button", { name: "Prepare migration" }) as HTMLButtonElement).disabled, false));
  fireEvent.click(screen.getByRole("button", { name: "Refresh room" }));
  await waitFor(() => assert.ok(within(screen.getByTestId("camp-storage-panel")).getByText("5")));
  fireEvent.click(screen.getByRole("button", { name: "Prepare migration" }));
  await waitFor(() => assert.equal(writes.length, 3)); assert.notEqual(writes[0].requestId, writes[2].requestId); assert.equal(writes[2].expectedEpoch, 5);
});

test("commands contain only operation identity, use local env files, and switch after source verification", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  const view = renderWithIntl(<CampStoragePanel roomId={roomId} storage={storage({ operations: [operation()] })} acceptedRevision={3} canManage busy={false} onAction={unusedAction} />);
  const command = screen.getByTestId("camp-storage-command-backup");
  fireEvent.click(within(command).getByRole("button", { name: "Copy" }));
  await waitFor(() => assert.equal(copied.length, 1));
  assert.equal(copied[0], storageCommand(operationId, "backup")); assert.match(copied[0], /--env-file=\.camp\/storage-source.env/);
  assert.equal(copied[0].includes(candidate.refId), false); assert.equal(copied[0].includes("--bundle"), false); assert.equal(copied[0].includes("TOKEN="), false);
  view.rerender(<TestIntlProvider><CampStoragePanel roomId={roomId} storage={storage({ operations: [operation({ phase: "backup_ready", backupReceipt: backupReceipt() })] })} acceptedRevision={3} canManage busy={false} onAction={unusedAction} /></TestIntlProvider>);
  assert.equal(screen.queryByTestId("camp-storage-command-backup"), null);
  assert.match(screen.getByTestId("camp-storage-command-restore").textContent ?? "", /storage-target.env.*storage.mjs restore --operation/);
  assert.equal(storageCommand("$(cat /secret)", "backup"), null);
  assert.equal(screen.getByTestId("camp-storage-manifest-digest").textContent?.includes(manifestDigest), true);
  assert.equal(screen.getByTestId("camp-storage-manifest-digest").textContent?.includes(planDigest), false);
});

test("a missing source receipt has an explicit collapsed recovery command that cannot activate or recreate the source", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  renderWithIntl(<CampStoragePanel roomId={roomId} storage={storage({ operations: [operation()] })} acceptedRevision={3} canManage busy={false} onAction={unusedAction} />);
  const recovery = screen.getByTestId("camp-storage-report-recovery") as HTMLDetailsElement;
  assert.equal(recovery.open, false);
  await act(async () => { recovery.open = true; fireEvent(recovery, new window.Event("toggle")); });
  assert.ok(within(recovery).getByText(/does not recreate the source Store or switch storage automatically/));
  assert.match(within(recovery).getByTestId("camp-storage-command-report-backup").textContent ?? "", /storage-recovery.env.*storage.mjs report-backup --operation/);
  fireEvent.click(within(recovery).getByRole("button", { name: "Copy" }));
  await waitFor(() => assert.deepEqual(copied, [storageCommand(operationId, "report-backup")]));
  assert.equal(copied[0].includes(candidate.refId), false); assert.equal(copied[0].includes("--bundle"), false);
  assert.equal(within(recovery).queryByRole("button", { name: "Activate verified target" }), null);
});

test("private transfer commands pin the original backup for upload and the current migration for download without invoking transport", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  const migration = operation({ phase: "backup_ready", originBackupOperationId: backupId, backupReceipt: backupReceipt(backupId) });
  const view = renderWithIntl(<CampStoragePanel roomId={roomId} storage={storage({ operations: [migration] })} acceptedRevision={3} canManage busy={false} onAction={unusedAction} />);
  const transfer = screen.getByTestId("camp-storage-transfer") as HTMLDetailsElement; assert.equal(transfer.open, false);
  await act(async () => { transfer.open = true; fireEvent(transfer, new window.Event("toggle")); });
  const upload = within(transfer).getByTestId("camp-storage-command-upload"), download = within(transfer).getByTestId("camp-storage-command-download");
  assert.ok(upload.textContent?.includes(`artifacts.mjs upload --operation ${backupId}`));
  assert.ok(download.textContent?.includes(`artifacts.mjs download --operation ${operationId}`));
  fireEvent.click(within(upload).getByRole("button", { name: "Copy" })); fireEvent.click(within(download).getByRole("button", { name: "Copy" }));
  await waitFor(() => assert.deepEqual(copied, [storageCommand(backupId, "upload"), storageCommand(operationId, "download")]));
  assert.ok(within(transfer).getByText(/restore verification and explicit activation are still required/));
  for (const command of copied) { assert.equal(command.includes(candidate.refId), false); assert.equal(command.includes("TOKEN="), false); assert.equal(command.includes("--bundle"), false); }
  view.rerender(<TestIntlProvider><CampStoragePanel roomId={roomId} storage={storage({ operations: [migration] })} acceptedRevision={3} canManage={false} busy={false} onAction={unusedAction} /></TestIntlProvider>);
  assert.equal(screen.queryByTestId("camp-storage-transfer"), null);
});

test("restore readiness requires an explicit administrator activation using the verified target and source epoch", async () => {
  const restored = operation({ phase: "restore_ready", canActivate: true, backupReceipt: backupReceipt(), restoreReceipt: { ...backupReceipt(), targetStorageId: target, verifiedCandidates: 1, historyVerified: true } });
  let current = snapshot(storage({ maintenance: true, operations: [restored], canBackup: false, canMigrate: false }));
  mockRoom(() => current);
  const writes: Array<{ path: string; body: unknown }> = [];
  const pending = deferred<{ data: { operation: CampStorageOperation; storage: CampStorage } }>();
  api.post = (async (path: string, body: unknown) => { writes.push({ path, body }); return pending.promise; }) as typeof api.post;
  renderWithIntl(<CampRoomPanel channel={channel} />);
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Activate verified target" })));
  assert.deepEqual(writes, []); assert.ok(screen.getByText(/old host will be refused new claims/));
  const activate = screen.getByRole("button", { name: "Activate verified target" });
  await act(async () => { fireEvent.click(activate); fireEvent.click(activate); });
  assert.deepEqual(writes, [{ path: `/camp/rooms/${roomId}/storage-operations/${operationId}/activate`, body: { expectedEpoch: 4, expectedTargetStorageId: target } }]);
  const activated = { ...restored, phase: "activated" as const, canActivate: false, canCancel: false };
  const next = storage({ epoch: 5, storageId: target, operations: [activated] }); current = snapshot(next);
  await act(async () => pending.resolve({ data: { operation: activated, storage: next } }));
  await waitFor(() => assert.ok(screen.getByText("Migration activated")));
  assert.equal(screen.queryByRole("button", { name: "Activate verified target" }), null);
  assert.ok(within(screen.getByRole("region", { name: "Current accepted project version" })).getByText(candidate.refId));
});

test("members inspect history and preserved references but receive no operational commands or buttons", async () => {
  const completed = operation({ id: backupId, phase: "completed", kind: "backup", canCancel: false, canRestoreFromBackup: true, backupReceipt: backupReceipt() });
  renderWithIntl(<CampStoragePanel roomId={roomId} storage={storage({ operations: [operation(), completed] })} acceptedRevision={3} canManage={false} busy={false} onAction={unusedAction} />);
  assert.equal(screen.queryByRole("button"), null); assert.equal(screen.queryByTestId("camp-storage-command-backup"), null);
  const inventory = screen.getAllByTestId("camp-storage-inventory")[1] as HTMLDetailsElement;
  await act(async () => { inventory.open = true; fireEvent(inventory, new window.Event("toggle")); });
  assert.ok(within(inventory).getByText(candidate.refId)); assert.ok(within(inventory).getByText(candidate.rootId));
});

test("restore-from-backup uses only a server-approved completed operation and preserves the original receipt", async () => {
  const completed = operation({ id: backupId, phase: "completed", kind: "backup", canCancel: false, canRestoreFromBackup: true, backupReceipt: backupReceipt(backupId) });
  let current = snapshot(storage({ operations: [completed] })); mockRoom(() => current);
  const writes: Record<string, unknown>[] = [];
  api.post = (async (_path: string, body: Record<string, unknown>) => {
    writes.push(body);
    const migrated = operation({ phase: "backup_ready", originBackupOperationId: backupId, backupReceipt: backupReceipt(backupId) });
    const next = storage({ maintenance: true, operations: [migrated, completed], canBackup: false, canMigrate: false }); current = snapshot(next);
    return { data: { operation: migrated, storage: next } };
  }) as typeof api.post;
  renderWithIntl(<CampRoomPanel channel={channel} />);
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Restore or migrate from this backup" })));
  fireEvent.click(screen.getByRole("button", { name: "Restore or migrate from this backup" }));
  await waitFor(() => assert.equal(writes.length, 1));
  assert.equal(writes[0].kind, "migration"); assert.equal(writes[0].backupOperationId, backupId);
  await waitFor(() => assert.ok(screen.getByTestId("camp-storage-command-restore")));
  const migrated = screen.getAllByTestId("camp-storage-operation")[0];
  assert.ok(within(migrated).getByText(backupId)); assert.ok(within(migrated).getByText(manifestDigest));
});

test("a server-approved backup survives storage relocation and a new migration uses the current binding CAS", async () => {
  const oldBackup = operation({ id: backupId, phase: "completed", kind: "backup", canCancel: false, canRestoreFromBackup: true, backupReceipt: backupReceipt(backupId) });
  let current = snapshot(storage({ epoch: 5, storageId: target, operations: [oldBackup] })); mockRoom(() => current);
  const writes: Record<string, unknown>[] = [];
  api.post = (async (_path: string, body: Record<string, unknown>) => {
    writes.push(body);
    const migration = operation({ phase: "backup_ready", originBackupOperationId: backupId, plan: { ...oldBackup.plan, operationId, kind: "migration", storageEpoch: 5, sourceStorageId: target, backupOperationId: backupId }, backupReceipt: backupReceipt(backupId) });
    const next = storage({ epoch: 5, storageId: target, maintenance: true, operations: [migration, oldBackup], canBackup: false, canMigrate: false }); current = snapshot(next);
    return { data: { operation: migration, storage: next } };
  }) as typeof api.post;
  renderWithIntl(<CampRoomPanel channel={channel} />);
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Restore or migrate from this backup" })));
  assert.ok(screen.getByText(/changed storage location does not invalidate it/));
  const restore = screen.getByRole("button", { name: "Restore or migrate from this backup" }) as HTMLButtonElement;
  assert.equal(restore.disabled, false); fireEvent.click(restore);
  await waitFor(() => assert.equal(writes.length, 1));
  assert.equal(writes[0].expectedEpoch, 5); assert.equal(writes[0].expectedAcceptedRevision, 3); assert.equal(writes[0].backupOperationId, backupId);
  await waitFor(() => assert.ok(screen.getByTestId("camp-storage-command-restore")));
  const migration = screen.getAllByTestId("camp-storage-operation")[0]; assert.ok(within(migration).getByText(manifestDigest));
});

test("stale backup and activation affordances follow server permissions even when phases look eligible", () => {
  const restored = operation({ phase: "restore_ready", canActivate: false, canCancel: false, restoreReceipt: { ...backupReceipt(), targetStorageId: target, verifiedCandidates: 1, historyVerified: true } });
  const oldBackup = operation({ id: backupId, kind: "backup", phase: "completed", canCancel: false, canRestoreFromBackup: false });
  renderWithIntl(<CampStoragePanel roomId={roomId} storage={storage({ operations: [restored, oldBackup] })} acceptedRevision={3} canManage busy={false} onAction={unusedAction} />);
  assert.equal(screen.queryByRole("button", { name: "Activate verified target" }), null);
  assert.equal((screen.getByRole("button", { name: "Restore or migrate from this backup" }) as HTMLButtonElement).disabled, true);
});

test("cancelling an operation addresses its own identity and shows the returned terminal state", async () => {
  let current = snapshot(storage({ maintenance: true, operations: [operation()], canBackup: false, canMigrate: false })); mockRoom(() => current);
  const writes: Array<{ path: string; body: unknown }> = [];
  api.post = (async (path: string, body: unknown) => {
    writes.push({ path, body }); const cancelled = operation({ phase: "cancelled", canCancel: false });
    const next = storage({ operations: [cancelled] }); current = snapshot(next); return { data: { operation: cancelled, storage: next } };
  }) as typeof api.post;
  renderWithIntl(<CampRoomPanel channel={channel} />);
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Cancel storage operation" })));
  fireEvent.click(screen.getByRole("button", { name: "Cancel storage operation" }));
  await waitFor(() => assert.ok(screen.getByText("Storage operation cancelled")));
  assert.deepEqual(writes, [{ path: `/camp/rooms/${roomId}/storage-operations/${operationId}/cancel`, body: {} }]);
});

test("bounded previews show the complete count and fetch a matching full inventory only on explicit download", async () => {
  const extra: CampCandidate = { ...candidate, refId: "32" + "9".repeat(64), layerId: "32" + "9".repeat(64) };
  const preview = operation({ candidateCount: 2, inventoryTruncated: true });
  const full = { ...preview, inventoryTruncated: false, plan: { ...preview.plan, candidates: [candidate, extra] } };
  const reads: string[] = [], blobs: Blob[] = [];
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  api.get = (async (path: string) => { reads.push(path); return { data: full }; }) as typeof api.get;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (blob: Blob) => { blobs.push(blob); return "blob:storage-plan"; } });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  renderWithIntl(<CampStoragePanel roomId={roomId} storage={storage({ operations: [preview], operationsTruncated: true })} acceptedRevision={3} canManage={false} busy={false} onAction={unusedAction} />);
  assert.deepEqual(reads, []); assert.ok(screen.getByText(/Older operations are omitted/));
  const inventory = screen.getByTestId("camp-storage-inventory") as HTMLDetailsElement;
  await act(async () => { inventory.open = true; fireEvent(inventory, new window.Event("toggle")); });
  assert.deepEqual(reads, []); assert.ok(screen.getByText("Showing 1 of 2 references. The backup and validation use the complete frozen inventory."));
  assert.equal(within(inventory).getAllByRole("listitem").length, 1);
  fireEvent.click(screen.getByRole("button", { name: "Download complete reference inventory" }));
  await waitFor(() => assert.equal(blobs.length, 1));
  assert.deepEqual(reads, [`/camp/rooms/${roomId}/storage-operations/${operationId}`]);
  const contents = JSON.parse(await blobs[0].text()); assert.equal(contents.planDigest, planDigest); assert.equal(contents.plan.candidates.length, 2);
  assert.equal(clicked.mock.calls.length, 1);
});

test("a mismatched full inventory is never downloaded and an in-flight read is aborted when leaving the room", async () => {
  const preview = operation({ candidateCount: 2, inventoryTruncated: true });
  const pending = deferred<CampStorageOperation>(); let signal: AbortSignal | undefined, downloads = 0;
  campApi.storageOperation = async (_room, _operation, selectedSignal) => { signal = selectedSignal; return pending.promise; };
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => { downloads++; return "blob:bad-plan"; } });
  const view = renderWithIntl(<CampStoragePanel roomId={roomId} storage={storage({ operations: [preview] })} acceptedRevision={3} canManage={false} busy={false} onAction={unusedAction} />);
  const inventory = screen.getByTestId("camp-storage-inventory") as HTMLDetailsElement;
  await act(async () => { inventory.open = true; fireEvent(inventory, new window.Event("toggle")); });
  fireEvent.click(screen.getByRole("button", { name: "Download complete reference inventory" }));
  view.rerender(<TestIntlProvider><CampStoragePanel roomId="another-room" storage={storage()} acceptedRevision={3} canManage={false} busy={false} onAction={unusedAction} /></TestIntlProvider>);
  assert.equal(signal?.aborted, true);
  await act(async () => pending.resolve({ ...preview, planDigest: "0".repeat(64) })); assert.equal(downloads, 0);
});

test("a full inventory with another plan digest fails visibly instead of exporting substituted evidence", async () => {
  const preview = operation({ candidateCount: 2, inventoryTruncated: true }); let downloads = 0;
  campApi.storageOperation = async () => ({ ...preview, inventoryTruncated: false, planDigest: "0".repeat(64) });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => { downloads++; return "blob:bad-plan"; } });
  renderWithIntl(<CampStoragePanel roomId={roomId} storage={storage({ operations: [preview] })} acceptedRevision={3} canManage={false} busy={false} onAction={unusedAction} />);
  const inventory = screen.getByTestId("camp-storage-inventory") as HTMLDetailsElement;
  await act(async () => { inventory.open = true; fireEvent(inventory, new window.Event("toggle")); });
  fireEvent.click(screen.getByRole("button", { name: "Download complete reference inventory" }));
  await waitFor(() => assert.ok(screen.getByRole("alert"))); assert.equal(downloads, 0);
});
