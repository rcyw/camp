import { useIntl } from "react-intl";
import type { CampWorkerRecord } from "./campApi";

const REASON_LABELS = {
  protocol_required: "camp.workers.reason.protocolRequired",
  protocol_unsupported: "camp.workers.reason.protocolUnsupported",
  capability_missing: "camp.workers.reason.capabilityMissing",
  legacy_unversioned: "camp.workers.reason.legacy",
  pool_required: "camp.workers.reason.poolRequired",
  pool_mismatch: "camp.workers.reason.poolMismatch",
  storage_mismatch: "camp.workers.reason.storageMismatch",
  lane_not_registered: "camp.workers.reason.laneNotRegistered",
} as const;

function WorkerReport({ worker }: { worker: CampWorkerRecord }) {
  const { formatMessage: t, formatDate, formatTime } = useIntl();
  const compatibility = worker.compatibility;
  const missing = compatibility ? [
    ["camp.workers.missingTasks", compatibility.missingTaskKinds],
    ["camp.workers.missingRefs", compatibility.missingRefKinds],
    ["camp.workers.missingCapabilities", compatibility.missingCapabilities],
    ["camp.workers.missingHarnesses", compatibility.missingHarnesses ?? []],
  ] as const : [];
  const reason = compatibility?.code;
  const poolProblem = reason === "pool_required" || reason === "pool_mismatch" || reason === "storage_mismatch" || reason === "lane_not_registered";
  const reasonId = reason ? REASON_LABELS[reason as keyof typeof REASON_LABELS] : undefined;
  const reported = new Date(worker.lastSeenAt);
  const validDate = !Number.isNaN(reported.getTime());
  return (
    <li className="rounded-lg border border-border-default bg-layer-canvas p-3" data-testid="camp-worker-report">
      <header className="flex flex-wrap justify-between gap-2 text-sm">
        <p className="break-all font-mono">{worker.workerId}</p>
        <p className={compatibility?.status === "incompatible" ? "text-danger-strong" : "text-foreground-secondary"}>
          {t({ id: compatibility?.status === "compatible" ? "camp.workers.compatible" : compatibility?.status === "incompatible" ? "camp.workers.incompatible" : compatibility?.status === "legacy" ? "camp.workers.legacy" : "camp.workers.unchecked" })}
        </p>
      </header>
      {reasonId && <p className="mt-2 text-xs text-foreground-secondary">{t({ id: reasonId })}</p>}
      {compatibility?.status === "incompatible" && <p className="mt-2 text-xs text-foreground-hint">{t({ id: poolProblem ? "camp.workers.poolHelp" : "camp.workers.upgradeHelp" })}</p>}
      <dl className="mt-2 grid gap-1 text-xs text-foreground-hint">
        <div><dt className="inline">{t({ id: "camp.workers.lastReport" })}: </dt><dd className="inline">{validDate ? <time dateTime={worker.lastSeenAt}>{formatDate(reported, { year: "numeric", month: "short", day: "numeric" })} {formatTime(reported, { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time> : t({ id: "camp.workers.unknownTime" })}</dd></div>
        {worker.declaration ? <>
          <div><dt className="inline">{t({ id: "camp.workers.version" })}: </dt><dd className="inline break-all font-mono">{worker.declaration.workerVersion}</dd></div>
          <div><dt className="inline">{t({ id: "camp.workers.protocols" })}: </dt><dd className="inline font-mono">{worker.declaration.protocolVersions.join(", ")}</dd></div>
          {worker.declaration.executionPool && <><div><dt className="inline">{t({ id: "camp.pool.id" })}: </dt><dd className="inline break-all font-mono">{worker.declaration.executionPool.poolId}</dd></div><div><dt className="inline">{t({ id: "camp.pool.storage" })}: </dt><dd className="inline break-all font-mono">{worker.declaration.executionPool.storageId}</dd></div></>}
        </> : <div><dd>{t({ id: "camp.workers.noDeclaration" })}</dd></div>}
        {missing.map(([label, values]) => values.length > 0 && <div key={label}><dt className="inline">{t({ id: label })}: </dt><dd className="inline break-words font-mono">{values.join(", ")}</dd></div>)}
      </dl>
    </li>
  );
}

/** Reports the server's last claim check, never infers presence or scheduling. */
export default function CampWorkerDiagnostics({ workers }: { workers?: CampWorkerRecord[] }) {
  const { formatMessage: t } = useIntl();
  if (workers === undefined) return null;
  return (
    <section aria-label={t({ id: "camp.workers.title" })} className="rounded-xl border border-border-default p-4" data-testid="camp-worker-diagnostics">
      <h3 className="text-sm font-medium">{t({ id: "camp.workers.title" })}</h3>
      <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.workers.help" })}</p>
      {workers.length === 0 ? <p className="mt-3 text-sm text-foreground-secondary">{t({ id: "camp.workers.empty" })}</p> : <ol className="mt-3 flex flex-col gap-2">{workers.map(worker => <WorkerReport key={worker.workerId} worker={worker} />)}</ol>}
    </section>
  );
}
