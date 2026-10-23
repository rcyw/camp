import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages/en";
import type { CampCandidate, CampGoal, CampIntegrationOperation } from "./campApi";
import CampCandidateReference from "./CampCandidateReference";
import { visibleSourceText } from "./campDisplay";
import { hasSharedBaseline } from "./campPlanMode";

const STATUS_LABELS: Record<string, MessageId> = {
  not_required: "camp.integration.status.not_required", not_run: "camp.integration.status.not_run", pending: "camp.integration.status.pending",
  queued: "camp.integration.status.queued", running: "camp.integration.status.running",
  merged: "camp.integration.status.merged", conflict: "camp.integration.status.conflict",
  rejected: "camp.integration.status.rejected", failed: "camp.integration.status.failed",
  cancelled: "camp.integration.status.cancelled", blocked: "camp.integration.status.blocked",
};

function statusLabel(status: string): MessageId { return STATUS_LABELS[status] ?? "camp.integration.status.unknown"; }

function CandidateIdentity({ candidate }: { candidate: CampCandidate }) {
  const { formatMessage: t } = useIntl();
  return <div className="min-w-0 text-xs">
    <CampCandidateReference candidate={candidate} />
    <dl className="mt-2 flex flex-col gap-1 text-foreground-hint">
      <div><dt className="inline">{t({ id: "camp.integration.project" })}: </dt><dd className="inline break-all font-mono">{candidate.projectId}</dd></div>
      <div><dt className="inline">{t({ id: "camp.result.root" })}: </dt><dd className="inline break-all font-mono">{candidate.rootId}</dd></div>
      {candidate.imageId && <div><dt className="inline">{t({ id: "camp.integration.image" })}: </dt><dd className="inline break-all font-mono">{candidate.imageId}</dd></div>}
    </dl>
  </div>;
}

export function CampIntegrationOperationView({ operation }: { operation: CampIntegrationOperation }) {
  const { formatMessage: t, formatDate, formatTime } = useIntl();
  const input = operation.integrationInput, receipt = operation.integrationReport;
  const receiptMatches = receipt !== null && receipt.inputDigest === operation.inputDigest && receipt.operationId === operation.id
    && (!operation.latestRunId || receipt.runId === operation.latestRunId)
    && receipt.algorithm === input.algorithm && receipt.policy === input.policy
    && (receipt.status !== "merged" || (receipt.candidate?.projectId === input.base.projectId
      && (!input.base.imageId || receipt.candidate.imageId === input.base.imageId)));
  const recorded = receiptMatches ? receipt : null;
  const state = operation.status === "completed" ? recorded?.status ?? "unknown" : operation.status;
  const integratedAt = recorded ? new Date(recorded.integratedAt) : null;
  return <li className="rounded-lg border border-border-default p-3" data-testid="camp-integration-operation" data-operation-id={operation.id} data-status={state} data-scope={operation.scope ?? "goal"} data-item-key={operation.planItemKey}>
    <p className="text-sm font-medium">{t({ id: "camp.integration.systemOperation" })} · {t({ id: statusLabel(state) })}</p>
    {operation.scope === "node_input" && <p className="mt-2 break-words text-xs font-medium">{t({ id: "camp.graph.nodeIntegration" }, { key: visibleSourceText(operation.planItemKey ?? "") })}</p>}
    <p className="mt-1 text-xs text-foreground-hint">{t({ id: "camp.goalAttempt" }, { attempt: operation.goalAttempt })} · {t({ id: "camp.attempt" }, { epoch: operation.attempt })}</p>
    <details className="mt-3" data-testid="camp-integration-inputs">
      <summary className="cursor-pointer text-xs font-medium">{t({ id: "camp.integration.inputs" })}</summary>
      <div className="mt-3 rounded border border-border-default p-3" data-testid="camp-integration-base">
        <p className="mb-2 text-xs font-medium">{t({ id: "camp.integration.base" })}</p>
        <CandidateIdentity candidate={input.base} />
      </div>
      <ol className={`mt-3 grid gap-3 ${operation.scope === "node_input" ? "" : "sm:grid-cols-2"}`}>{input.parents.map((parent, index) => <li key={parent.key} className="min-w-0 rounded border border-border-default p-3" data-testid="camp-integration-parent" data-parent-key={parent.key}>
        <p className="mb-2 break-words text-xs font-medium">{t({ id: "camp.integration.parent" }, { index: index + 1, key: visibleSourceText(parent.key) })}</p>
        <CandidateIdentity candidate={parent.candidate} />
        <p className="mt-2 break-all font-mono text-xs text-foreground-hint">{t({ id: "camp.integration.producer" })}: {parent.runId} · {t({ id: "camp.attempt" }, { epoch: parent.epoch })}</p>
      </li>)}</ol>
      <dl className="mt-3 flex flex-col gap-1 text-xs text-foreground-hint">
        <div><dt className="inline">{t({ id: "camp.integration.algorithm" })}: </dt><dd className="inline break-all font-mono">{input.algorithm}</dd></div>
        <div><dt className="inline">{t({ id: "camp.integration.policy" })}: </dt><dd className="inline break-all font-mono">{input.policy}</dd></div>
        <div><dt className="inline">{t({ id: "camp.integration.inputDigest" })}: </dt><dd className="inline break-all font-mono">{operation.inputDigest}</dd></div>
      </dl>
    </details>
    {receipt && !receiptMatches && <p role="alert" className="mt-3 text-sm text-danger-strong">{t({ id: "camp.integration.identityMismatch" })}</p>}
    {recorded && <section className="mt-3 border-t border-border-default pt-3" data-testid="camp-integration-receipt" data-status={recorded.status} data-input-digest={recorded.inputDigest} data-candidate-ref={recorded.candidate?.refId}>
      <p className="text-xs font-medium">{t({ id: "camp.integration.receipt" })} · {t({ id: statusLabel(recorded.status) })}</p>
      {integratedAt && !Number.isNaN(integratedAt.getTime()) && <time dateTime={recorded.integratedAt} className="mt-1 block text-xs text-foreground-hint">{formatDate(integratedAt)} {formatTime(integratedAt)}</time>}
      {recorded.status === "merged" && recorded.candidate && <div className="mt-3" data-testid="camp-integration-result"><p className="mb-2 text-xs font-medium">{t({ id: "camp.integration.result" })}</p><CandidateIdentity candidate={recorded.candidate} /><p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.integration.mergedHelp" })}</p></div>}
      {recorded.status !== "merged" && <p className="mt-2 text-sm text-foreground-secondary">{t({ id: recorded.status === "conflict" ? "camp.integration.conflictHelp" : "camp.integration.rejectedHelp" })}</p>}
      {recorded.conflicts.length > 0 && <div className="mt-3"><h6 className="text-xs font-medium">{t({ id: "camp.integration.conflicts" })}</h6><ul className="mt-2 flex flex-col gap-2">{recorded.conflicts.map((conflict, index) => <li key={`${index}-${conflict.path}`} className="rounded border border-border-default p-2 text-xs" data-testid="camp-integration-conflict"><p className="break-all font-mono">{visibleSourceText(conflict.path)}</p><p className="mt-1 text-foreground-hint">{t({ id: "camp.integration.reasonCode" })}: <code>{visibleSourceText(conflict.reason)}</code></p></li>)}</ul></div>}
      {recorded.truncated && <p className="mt-2 text-xs text-foreground-hint" role="status">{t({ id: "camp.integration.truncated" })}</p>}
    </section>}
  </li>;
}

/** Operation receipts establish lineage; verification and acceptance remain separate gates. */
export default function CampGoalIntegration({ goal, history = [] }: { goal: CampGoal; history?: CampIntegrationOperation[] }) {
  const { formatMessage: t } = useIntl();
  const integration = goal.integration;
  if (!integration?.required && !hasSharedBaseline(goal.planMode)) return null;
  const graph = goal.planMode === "bounded_dag";
  const status = integration?.status ?? "pending", operations = (integration?.operations ?? []).filter(operation => operation.goalAttempt === goal.attempt && operation.scope !== "node_input");
  const previous = history.filter(operation => operation.goalId === goal.id && operation.goalAttempt !== goal.attempt);
  if (graph && operations.length === 0 && previous.length === 0) return null;
  return <section className="rounded-lg border border-border-default p-4" aria-label={t({ id: "camp.integration.title" })} data-testid="camp-goal-integration" data-status={status}>
    <h5 className="text-sm font-medium">{t({ id: graph ? "camp.graph.finalIntegration" : "camp.integration.title" })}</h5>
    <p className="mt-2 text-sm font-medium" role="status">{t({ id: statusLabel(status) })}</p>
    <p className="mt-2 text-xs text-foreground-hint">{t({ id: graph ? "camp.graph.finalIntegrationHelp" : "camp.integration.scope" })}</p>
    {operations.length === 0 && <p className="mt-2 text-sm text-foreground-hint">{t({ id: status === "not_run" ? "camp.integration.notRunHelp" : "camp.integration.waitingParents" })}</p>}
    {status === "blocked" && <p className="mt-2 text-sm text-foreground-secondary">{t({ id: "camp.integration.blockedHelp" })}</p>}
    {operations.length > 0 && <ol className="mt-3 flex flex-col gap-3">{operations.map(operation => <CampIntegrationOperationView key={operation.id} operation={operation} />)}</ol>}
    {previous.length > 0 && <details className="mt-3" data-testid="camp-integration-history"><summary className="cursor-pointer text-xs font-medium">{t({ id: "camp.integration.history" }, { count: previous.length })}</summary><ol className="mt-3 flex flex-col gap-3">{previous.map(operation => <CampIntegrationOperationView key={operation.id} operation={operation} />)}</ol></details>}
    {status !== "not_run" && <p className="mt-3 text-xs text-foreground-hint">{t({ id: "camp.integration.recoveryHelp" })}</p>}
  </section>;
}
