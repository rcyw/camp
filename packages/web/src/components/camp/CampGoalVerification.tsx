import { useIntl } from "react-intl";
import type { CampGoal } from "./campApi";
import CampCandidateReference from "./CampCandidateReference";
import { verificationStatusLabel } from "./CampVerificationReport";

export default function CampGoalVerificationView({ goal }: { goal: CampGoal }) {
  const { formatMessage: t } = useIntl();
  const verification = goal.verification;
  if (!verification) return null;
  return (
    <section className="rounded-lg border border-border-default p-4" aria-label={t({ id: "camp.verification.title" })} data-testid="camp-goal-verification">
      <h5 className="text-sm font-medium">{t({ id: "camp.verification.title" })}</h5>
      <p className="mt-2 text-sm font-medium" role="status">{t({ id: verificationStatusLabel(verification.status) })}</p>
      {!verification.required ? <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.verification.historicalContract" })}</p> : <>
        <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.verification.executionScope" })}</p>
        {goal.verificationPolicy && <p className="mt-2 text-xs">{goal.verificationPolicy.policy.name} · {t({ id: "camp.policy.revision" }, { revision: goal.verificationPolicy.policy.revision })}</p>}
        {verification.policyDigest && <p className="mt-1 break-all font-mono text-xs text-foreground-hint">{verification.policyDigest}</p>}
        <p className="mt-2 text-xs text-foreground-secondary">{t({ id: "camp.verification.repairs" }, { used: verification.repairsUsed, limit: verification.maxRepairAttempts })}</p>
        <ol className="mt-3 flex flex-col gap-2">{verification.operations.map(operation => <li key={operation.id} className="rounded border border-border-default p-3 text-xs" data-testid="camp-verification-operation">
          <p className="font-medium">{t({ id: "camp.verification.systemOperation" })} · {t({ id: verificationStatusLabel(operation.status === "completed" ? operation.receipt?.status ?? "unavailable" : operation.status) })}</p>
          <p className="mt-2"><CampCandidateReference candidate={operation.inputCandidate} /></p>
          {operation.receipt && <p className="mt-2 text-foreground-hint">{t({ id: "camp.verification.retainedChecks" }, { count: operation.receipt.checks.length })}</p>}
        </li>)}</ol>
        <p className="mt-3 text-xs text-foreground-hint">{t({ id: verification.status === "not_run" ? "camp.verification.notRunHelp" : "camp.verification.inspectHelp" })}</p>
      </>}
    </section>
  );
}
