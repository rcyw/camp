import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages/en";
import type { CampPreflightCheckId, CampReadiness } from "./campApi";

const CHECK_LABELS: Record<CampPreflightCheckId, MessageId> = {
  platform: "camp.setup.check.platform", node: "camp.setup.check.node", host_tools: "camp.setup.check.host_tools",
  runtime_home: "camp.setup.check.runtime_home", toolchain: "camp.setup.check.toolchain", docker: "camp.setup.check.docker",
  fuse: "camp.setup.check.fuse", image: "camp.setup.check.image", plugin: "camp.setup.check.plugin", harnesses: "camp.setup.check.harnesses",
  source: "camp.setup.check.source", capacity: "camp.setup.check.capacity", api: "camp.setup.check.api", resource_policy: "camp.setup.check.resource_policy", model: "camp.setup.check.model",
};

export default function CampPreflightReportView({ readiness, projectDigest }: { readiness: CampReadiness | null; projectDigest: string }) {
  const { formatMessage: t, formatDate, formatTime } = useIntl();
  if (!readiness) return <div className="mt-4 text-sm text-foreground-secondary" data-testid="camp-preflight-report"><p>{t({ id: "camp.setup.noReport" })}</p><p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.setup.reportHelp" })}</p></div>;
  const observed = new Date(readiness.observedAt), knownTime = !Number.isNaN(observed.getTime()), current = readiness.projectDigest === projectDigest;
  const failed = readiness.report.checks.some(check => check.status === "failed");
  return <section aria-label={t({ id: "camp.setup.preflight" })} className="mt-4 rounded-lg border border-border-default p-3" data-testid="camp-preflight-report" data-project-current={current}>
    <h4 className="text-sm font-medium">{t({ id: "camp.setup.preflight" })}</h4>
    <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.setup.reportHelp" })}</p>
    {!current && <p role="status" className="mt-2 text-sm text-danger-strong">{t({ id: "camp.setup.oldProjectReport" })}</p>}
    <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
      <div><dt className="text-foreground-hint">{t({ id: "camp.setup.reportedBy" })}</dt><dd className="break-all font-mono">{readiness.workerId}</dd></div>
      <div><dt className="text-foreground-hint">{t({ id: "camp.setup.reportedAt" })}</dt><dd>{knownTime ? <time dateTime={readiness.observedAt}>{formatDate(observed)} {formatTime(observed, { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time> : t({ id: "camp.workers.unknownTime" })}</dd></div>
      <div><dt className="text-foreground-hint">{t({ id: "camp.setup.mode" })}</dt><dd>{t({ id: readiness.report.mode === "agent" ? "camp.setup.modeAgent" : "camp.setup.modeVerification" })}</dd></div>
      <div><dt className="text-foreground-hint">{t({ id: "camp.setup.model" })}</dt><dd>{t({ id: readiness.report.modelConfigured ? "camp.setup.modelConfigured" : "camp.setup.modelMissing" })}</dd></div>
      <div><dt className="text-foreground-hint">{t({ id: "camp.workers.version" })}</dt><dd className="font-mono">{readiness.report.workerVersion}</dd></div>
      {readiness.report.imageId && <div className="min-w-0"><dt className="text-foreground-hint">{t({ id: "camp.setup.imageId" })}</dt><dd className="break-all font-mono">{readiness.report.imageId}</dd></div>}
    </dl>
    {readiness.report.mode === "verification" && <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.setup.modeVerificationHelp" })}</p>}
    <p className="mt-3 text-sm">{t({ id: failed ? "camp.setup.reportFailed" : "camp.setup.reportPassed" })}</p>
    <ul className="mt-2 grid gap-2 sm:grid-cols-2">{readiness.report.checks.map(check => <li key={check.id} className="rounded border border-border-default p-2 text-xs" data-testid="camp-preflight-check" data-check-id={check.id} data-status={check.status}><p className="font-medium">{t({ id: CHECK_LABELS[check.id] })} · {t({ id: `camp.setup.checkStatus.${check.status}` })}</p><code className="mt-1 block break-all text-foreground-hint">{check.code}</code></li>)}</ul>
  </section>;
}
