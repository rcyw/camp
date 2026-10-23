import { useIntl } from "react-intl";
import type { CampSnapshot } from "./campApi";
import CampProjectConfig from "./CampProjectConfig";
import CampPreflightReportView from "./CampPreflightReport";
import CampVerificationPolicyConfig from "./CampVerificationPolicy";
import CampWorkerConnection from "./CampWorkerConnection";

export default function CampRoomSetup({ snapshot, canManage, onChanged }: { snapshot: CampSnapshot; canManage: boolean; onChanged(): void }) {
  const { formatMessage: t } = useIntl();
  const setup = snapshot.setup;
  if (!setup) return null;
  const report = setup.readiness;
  const checksClear = report?.projectDigest === setup.projectDigest && report.report.mode === "agent" && report.report.modelConfigured && !report.report.checks.some(check => check.status === "failed");
  const steps = [
    { key: "project", done: Boolean(snapshot.room.project.repoPath) },
    { key: "policy", done: Boolean(snapshot.room.verificationPolicy) },
    { key: "worker", done: checksClear },
    { key: "goal", done: (snapshot.goals?.length ?? 0) > 0 },
  ] as const;
  return <section aria-label={t({ id: "camp.setup.title" })} className="flex flex-col gap-4" data-testid="camp-room-setup">
    <h3 className="font-medium">{t({ id: "camp.setup.title" })}</h3>
    <ol className="grid gap-2 text-sm sm:grid-cols-4">{steps.map((step, index) => <li key={step.key} className="rounded border border-border-default p-3" data-testid={`camp-setup-step-${step.key}`} data-complete={Boolean(step.done)}><p className="font-medium">{index + 1}. {t({ id: `camp.setup.step.${step.key}` })}</p><p className="mt-1 text-xs text-foreground-hint">{t({ id: step.done ? "camp.setup.stepComplete" : "camp.setup.stepPending" })}</p></li>)}</ol>
    <CampProjectConfig room={snapshot.room} setup={setup} canManage={canManage} onChanged={onChanged} />
    {snapshot.room.verificationPolicy !== undefined && <CampVerificationPolicyConfig roomId={snapshot.room.id} current={snapshot.room.verificationPolicy} canManage={canManage} onSaved={onChanged} />}
    <section aria-label={t({ id: "camp.setup.step.worker" })}>
      {canManage ? <CampWorkerConnection key={snapshot.room.id} roomId={snapshot.room.id} expanded={!checksClear} supportsParallel={snapshot.supportedPlanModes?.includes("parallel_pair")} /> : <p className="text-sm text-foreground-hint">{t({ id: "camp.setup.connectAdmin" })}</p>}
      <CampPreflightReportView readiness={setup.readiness} projectDigest={setup.projectDigest} />
    </section>
    <p className="text-xs text-foreground-hint">{t({ id: "camp.setup.queueHelp" })}</p>
  </section>;
}
