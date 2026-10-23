import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import type { MessageId } from "../../i18n/messages/en";
import { campApi } from "./campApi";
import type { CampStorage, CampStorageOperation } from "./campApi";
import CampCandidateReference from "./CampCandidateReference";

type StorageAction = (action: () => Promise<CampStorage>) => Promise<boolean>;
type StorageCommandAction = "backup" | "restore" | "report-backup" | "upload" | "download";
const COMMAND_LABELS: Record<StorageCommandAction, MessageId> = { backup: "camp.storage.sourceCommand", restore: "camp.storage.targetCommand", "report-backup": "camp.storage.recoveryCommand", upload: "camp.storage.uploadCommand", download: "camp.storage.downloadCommand" };
const COMMAND_CONFIG: Record<StorageCommandAction, MessageId> = { backup: "camp.storage.sourceConfig", restore: "camp.storage.targetConfig", "report-backup": "camp.storage.recoveryConfig", upload: "camp.storage.uploadConfig", download: "camp.storage.downloadConfig" };
const BLOCKERS: Partial<Record<string, MessageId>> = {
  storage_not_bound: "camp.storage.blocker.storage_not_bound",
  accepted_candidate_required: "camp.storage.blocker.accepted_candidate_required",
  unsupported_project: "camp.storage.blocker.unsupported_project",
  active_goal: "camp.storage.blocker.active_goal",
  active_run: "camp.storage.blocker.active_run",
  cleanup_unknown: "camp.storage.blocker.cleanup_unknown",
  integration_inspection_required: "camp.storage.blocker.integration_inspection_required",
  maintenance_active: "camp.storage.blocker.maintenance_active",
};

/** Paths and credentials belong to the local env file, never to this command. */
export function storageCommand(operationId: string, action: StorageCommandAction): string | null {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId)) return null;
  const environment = action === "backup" || action === "upload" ? "source" : action === "restore" || action === "download" ? "target" : "recovery";
  const script = action === "upload" || action === "download" ? "artifacts" : "storage";
  return `node --env-file=.camp/storage-${environment}.env packages/camp-runtime/scripts/${script}.mjs ${action} --operation ${operationId}`;
}

function StorageCommand({ operationId, action }: { operationId: string; action: StorageCommandAction }) {
  const { formatMessage: t } = useIntl();
  const [copied, setCopied] = useState(false), [failed, setFailed] = useState(false);
  const command = storageCommand(operationId, action);
  const copy = useCallback(async () => {
    if (!command) return;
    try { await navigator.clipboard.writeText(command); setCopied(true); setFailed(false); }
    catch { setFailed(true); }
  }, [command]);
  if (!command) return null;
  return <div className="mt-3 rounded border border-border-default p-3" data-testid={`camp-storage-command-${action}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs font-medium">{t({ id: COMMAND_LABELS[action] })}</p>
      <Button size="sm" variant="ghost" onClick={copy}>{t({ id: copied ? "camp.copied" : "camp.copy" })}</Button>
    </div>
    <pre className="mt-2 overflow-x-auto whitespace-pre text-xs"><code>{command}</code></pre>
    <p className="mt-2 text-xs text-foreground-hint">{t({ id: COMMAND_CONFIG[action] })}</p>
    {failed && <p className="mt-2 text-xs text-danger-strong" role="alert">{t({ id: "camp.copyError" })}</p>}
  </div>;
}

function StorageEvidence({ operation }: { operation: CampStorageOperation }) {
  const { formatMessage: t, formatNumber } = useIntl();
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [downloading, setDownloading] = useState(false), [downloadError, setDownloadError] = useState(false);
  const downloadInFlight = useRef(false);
  const downloadController = useRef<AbortController | null>(null);
  useEffect(() => () => downloadController.current?.abort(), []);
  const download = useCallback(async () => {
    if (downloadInFlight.current) return;
    downloadInFlight.current = true; setDownloading(true); setDownloadError(false);
    const controller = new AbortController(); downloadController.current = controller;
    try {
      const full = await campApi.storageOperation(operation.roomId, operation.id, controller.signal);
      if (controller.signal.aborted) return;
      if (full.id !== operation.id || full.roomId !== operation.roomId || full.planDigest !== operation.planDigest || full.inventoryTruncated || full.candidateCount !== full.plan.candidates.length) throw new Error("storage_inventory_mismatch");
      const url = URL.createObjectURL(new Blob([`${JSON.stringify({ planDigest: full.planDigest, plan: full.plan }, null, 2)}\n`], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `camp-storage-plan-${operation.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch { if (!controller.signal.aborted) setDownloadError(true); }
    finally { downloadInFlight.current = false; setDownloading(false); }
  }, [operation.roomId, operation.id, operation.planDigest]);
  const backup = operation.backupReceipt, restore = operation.restoreReceipt;
  return <>
    <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
      <div><dt className="text-foreground-hint">{t({ id: "camp.storage.source" })}</dt><dd className="mt-1 break-all font-mono">{operation.plan.sourceStorageId}</dd></div>
      <div><dt className="text-foreground-hint">{t({ id: "camp.storage.candidateCount" })}</dt><dd className="mt-1">{formatNumber(operation.candidateCount)}</dd></div>
      <div><dt className="text-foreground-hint">{t({ id: "camp.storage.baseline" })}</dt><dd className="mt-1">{formatNumber(operation.plan.storageEpoch)} / {formatNumber(operation.plan.acceptedRevision)}</dd></div>
      {operation.originBackupOperationId && <div><dt className="text-foreground-hint">{t({ id: "camp.storage.originBackup" })}</dt><dd className="mt-1 break-all font-mono">{operation.originBackupOperationId}</dd></div>}
      <div><dt className="text-foreground-hint">{t({ id: "camp.storage.planHash" })}</dt><dd className="mt-1 break-all font-mono">{operation.planDigest}</dd></div>
      {backup && <>
        <div data-testid="camp-storage-manifest-digest"><dt className="text-foreground-hint">{t({ id: "camp.storage.manifestHash" })}</dt><dd className="mt-1 break-all font-mono">{backup.manifestDigest}</dd></div>
        <div><dt className="text-foreground-hint">{t({ id: "camp.storage.storeHash" })}</dt><dd className="mt-1 break-all font-mono">{backup.storeSha256}</dd></div>
        <div><dt className="text-foreground-hint">{t({ id: "camp.storage.bytes" })}</dt><dd className="mt-1">{formatNumber(backup.bytes)}</dd></div>
        <div><dt className="text-foreground-hint">{t({ id: "camp.storage.toolchain" })}</dt><dd className="mt-1 break-all font-mono">{backup.toolchainDigest}</dd></div>
        <div><dt className="text-foreground-hint">{t({ id: "camp.storage.image" })}</dt><dd className="mt-1 break-all font-mono">{backup.imageId}</dd></div>
      </>}
      {restore && <>
        <div><dt className="text-foreground-hint">{t({ id: "camp.storage.target" })}</dt><dd className="mt-1 break-all font-mono" data-testid="camp-storage-target">{restore.targetStorageId}</dd></div>
        <div><dt className="text-foreground-hint">{t({ id: "camp.storage.restoredCandidates" })}</dt><dd className="mt-1">{formatNumber(restore.verifiedCandidates)}</dd></div>
      </>}
    </dl>
    {backup && <p className="mt-3 text-xs text-foreground-secondary">{t({ id: "camp.storage.backupVerified" })}</p>}
    {restore && <p className="mt-2 text-xs text-foreground-secondary">{t({ id: "camp.storage.restoreVerified" })}</p>}
    <details className="mt-3" data-testid="camp-storage-inventory" onToggle={event => setInventoryOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs font-medium">{t({ id: "camp.storage.inventory" }, { count: operation.candidateCount })}</summary>
      {inventoryOpen && operation.inventoryTruncated && <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.storage.inventoryTruncated" }, { shown: operation.plan.candidates.length, count: operation.candidateCount })}</p>}
      {inventoryOpen && <ol className="mt-3 flex max-h-64 flex-col gap-3 overflow-y-auto">{operation.plan.candidates.map(candidate => <li key={candidate.refId} className="text-xs"><CampCandidateReference candidate={candidate} /><p className="mt-1 break-all font-mono text-foreground-hint">{candidate.rootId}</p></li>)}</ol>}
      {inventoryOpen && operation.inventoryTruncated && <Button className="mt-3" size="sm" variant="outline" disabled={downloading} onClick={download}>{t({ id: "camp.storage.downloadInventory" })}</Button>}
      {inventoryOpen && downloadError && <p className="mt-2 text-xs text-danger-strong" role="alert">{t({ id: "camp.storage.inventoryDownloadFailed" })}</p>}
    </details>
  </>;
}

function StorageOperation({ operation, busy, canManage, onAction, canRestore, onRestore }: { operation: CampStorageOperation; busy: boolean; canManage: boolean; onAction: StorageAction; canRestore: boolean; onRestore(operationId: string): Promise<void> }) {
  const { formatMessage: t, formatDate, formatTime } = useIntl();
  const inFlight = useRef(false);
  const act = useCallback(async (action: "activate" | "cancel") => {
    if (inFlight.current || busy || !canManage) return;
    if (action === "activate" && (!operation.canActivate || !operation.restoreReceipt)) return;
    if (action === "cancel" && !operation.canCancel) return;
    inFlight.current = true;
    try {
      await onAction(() => action === "activate"
        ? campApi.activateStorageOperation(operation.roomId, operation.id, operation.plan.storageEpoch, operation.restoreReceipt!.targetStorageId)
        : campApi.cancelStorageOperation(operation.roomId, operation.id));
    } finally { inFlight.current = false; }
  }, [busy, canManage, operation, onAction]);
  const activate = useCallback(() => { void act("activate"); }, [act]);
  const cancel = useCallback(() => { void act("cancel"); }, [act]);
  const restore = useCallback(() => { if (canRestore && !busy) void onRestore(operation.id); }, [canRestore, busy, onRestore, operation.id]);
  return <li className="rounded-lg border border-border-default bg-layer-canvas p-4" data-testid="camp-storage-operation" data-operation-id={operation.id} data-phase={operation.phase}>
    <header className="flex flex-wrap items-start justify-between gap-2"><h4 className="text-sm font-medium">{t({ id: operation.kind === "backup" ? "camp.storage.backup" : "camp.storage.migration" })}</h4><p className="text-xs font-medium" role="status">{t({ id: `camp.storage.phase.${operation.phase}` })}</p></header>
    <p className="mt-2 break-all font-mono text-xs text-foreground-hint">{operation.id}</p>
    <time className="mt-1 block text-xs text-foreground-hint" dateTime={operation.updatedAt}>{formatDate(operation.updatedAt)} {formatTime(operation.updatedAt)}</time>
    <StorageEvidence operation={operation} />
    {canManage && operation.backupReceipt && operation.phase !== "cancelled" && <details className="mt-3 rounded border border-border-default p-3" data-testid="camp-storage-transfer"><summary className="cursor-pointer text-xs font-medium">{t({ id: "camp.storage.transferTitle" })}</summary><p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.storage.transferHelp" })}</p><StorageCommand operationId={operation.backupReceipt.operationId} action="upload" /><StorageCommand operationId={operation.id} action="download" /></details>}
    {canManage && operation.phase === "prepared" && <StorageCommand operationId={operation.id} action="backup" />}
    {canManage && operation.phase === "prepared" && <details className="mt-3 rounded border border-border-default p-3" data-testid="camp-storage-report-recovery"><summary className="cursor-pointer text-xs font-medium">{t({ id: "camp.storage.recoveryTitle" })}</summary><p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.storage.recoveryHelp" })}</p><StorageCommand operationId={operation.id} action="report-backup" /></details>}
    {canManage && operation.kind === "migration" && operation.phase === "backup_ready" && <StorageCommand operationId={operation.id} action="restore" />}
    {operation.phase === "restore_ready" && <div className="mt-3 rounded border border-border-default p-3">
      <p className="text-sm">{t({ id: "camp.storage.activateHelp" })}</p>
      {canManage && operation.canActivate && operation.restoreReceipt && <Button className="mt-3" size="sm" disabled={busy} onClick={activate} data-testid="camp-storage-activate">{t({ id: "camp.storage.activate" })}</Button>}
    </div>}
    {canManage && operation.kind === "backup" && operation.phase === "completed" && <div className="mt-3"><Button size="sm" variant="outline" disabled={busy || !canRestore} onClick={restore}>{t({ id: "camp.storage.restoreBackup" })}</Button><p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.storage.restoreBackupHelp" })}</p></div>}
    {canManage && operation.canCancel && <Button className="mt-3" size="sm" variant="ghost" disabled={busy} onClick={cancel}>{t({ id: "camp.storage.cancel" })}</Button>}
  </li>;
}

export default function CampStoragePanel({ roomId, storage, acceptedRevision, canManage, busy, onAction }: { roomId: string; storage?: CampStorage; acceptedRevision: number; canManage: boolean; busy: boolean; onAction: StorageAction }) {
  if (!storage) return null;
  return <StoragePanelState key={roomId} roomId={roomId} storage={storage} acceptedRevision={acceptedRevision} canManage={canManage} busy={busy} onAction={onAction} />;
}

function StoragePanelState({ roomId, storage, acceptedRevision, canManage, busy, onAction }: { roomId: string; storage: CampStorage; acceptedRevision: number; canManage: boolean; busy: boolean; onAction: StorageAction }) {
  const { formatMessage: t, formatNumber } = useIntl();
  const inFlight = useRef(false);
  const requests = useRef<Map<string, { key: string; id: string }>>(new Map());
  const create = useCallback(async (kind: CampStorageOperation["kind"], backupOperationId?: string) => {
    if (inFlight.current || busy || !canManage || !(kind === "backup" ? storage.canBackup : storage.canMigrate)) return;
    const key = `${storage.epoch}:${acceptedRevision}`;
    const requestKey = `${kind}:${backupOperationId ?? ""}`;
    let request = requests.current.get(requestKey);
    if (!request || request.key !== key) { request = { key, id: crypto.randomUUID() }; requests.current.set(requestKey, request); }
    inFlight.current = true;
    try {
      const succeeded = await onAction(() => campApi.createStorageOperation(roomId, { requestId: request.id, kind, expectedEpoch: storage.epoch, expectedAcceptedRevision: acceptedRevision, ...(backupOperationId ? { backupOperationId } : {}) }));
      if (succeeded) requests.current.delete(requestKey);
    } finally { inFlight.current = false; }
  }, [busy, canManage, storage.canBackup, storage.canMigrate, storage.epoch, acceptedRevision, onAction, roomId]);
  const backup = useCallback(() => { void create("backup"); }, [create]);
  const migrate = useCallback(() => { void create("migration"); }, [create]);
  const restoreBackup = useCallback((operationId: string) => create("migration", operationId), [create]);
  return <section className="rounded-xl border border-border-default p-4" aria-label={t({ id: "camp.storage.title" })} data-testid="camp-storage-panel">
    <h3 className="text-sm font-medium">{t({ id: "camp.storage.title" })}</h3>
    <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.storage.scope" })}</p>
    <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.storage.locationHelp" })}</p>
    <dl className="mt-3 text-xs"><div><dt className="inline text-foreground-hint">{t({ id: "camp.pool.storage" })}: </dt><dd className="inline break-all font-mono">{storage.storageId ?? t({ id: "camp.storage.unbound" })}</dd></div><div className="mt-1"><dt className="inline text-foreground-hint">{t({ id: "camp.storage.epoch" })}: </dt><dd className="inline">{formatNumber(storage.epoch)}</dd></div></dl>
    {storage.maintenance && <p className="mt-3 rounded border border-border-default p-3 text-sm" role="status" data-testid="camp-storage-maintenance">{t({ id: "camp.storage.maintenance" })}</p>}
    {storage.blockers.length > 0 && <ul className="mt-3 flex list-inside list-disc flex-col gap-1 text-xs text-foreground-secondary" data-testid="camp-storage-blockers">{storage.blockers.map(code => <li key={code}>{BLOCKERS[code] ? t({ id: BLOCKERS[code] }) : <code className="break-all">{code}</code>}</li>)}</ul>}
    {canManage ? <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || !storage.canBackup} onClick={backup} data-testid="camp-storage-create-backup">{t({ id: "camp.storage.createBackup" })}</Button><Button size="sm" variant="outline" disabled={busy || !storage.canMigrate} onClick={migrate} data-testid="camp-storage-create-migration">{t({ id: "camp.storage.createMigration" })}</Button></div> : <p className="mt-3 text-xs text-foreground-hint">{t({ id: "camp.storage.adminRequired" })}</p>}
    {storage.operations.length > 0 ? <ol className="mt-4 flex flex-col gap-3">{storage.operations.map(operation => <StorageOperation key={operation.id} operation={operation} busy={busy} canManage={canManage} onAction={onAction} canRestore={operation.canRestoreFromBackup && storage.canMigrate} onRestore={restoreBackup} />)}</ol> : <p className="mt-3 text-xs text-foreground-hint">{t({ id: "camp.storage.empty" })}</p>}
    {storage.operationsTruncated && <p className="mt-3 text-xs text-foreground-hint">{t({ id: "camp.storage.operationsTruncated" })}</p>}
  </section>;
}
