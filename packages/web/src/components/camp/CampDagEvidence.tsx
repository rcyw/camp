import { useIntl } from "react-intl";
import { ArrowLeft } from "lucide-react";
import type { MessageId } from "../../i18n/messages/en";
import type { CampGoal, CampWorkItem } from "./campApi";
import CampCandidateReference from "./CampCandidateReference";
import { CampIntegrationOperationView } from "./CampGoalIntegration";

const RESOLUTION_LABELS: Record<NonNullable<CampWorkItem["inputResolution"]>, MessageId> = {
  baseline: "camp.graph.resolution.baseline", single_parent: "camp.graph.resolution.single_parent",
  same_ref: "camp.graph.resolution.same_ref", ancestor: "camp.graph.resolution.ancestor", integration: "camp.graph.resolution.integration",
};
export const dagItemAnchor = (goalId: string, key: string) => `camp-node-${encodeURIComponent(goalId)}-${encodeURIComponent(key)}`;

/** Layout only: execution readiness and blockers always come from the server. */
export function dagItemRows(items: CampWorkItem[]): CampWorkItem[][] {
  const pending = [...items], emitted = new Set<string>(), rows: CampWorkItem[][] = [];
  while (pending.length) {
    const row = pending.filter(item => (item.dependsOnKeys ?? []).every(key => emitted.has(key)));
    // Retained malformed historical data remains readable without inventing edges.
    if (!row.length) { rows.push(pending); break; }
    rows.push(row);
    for (const item of row) { emitted.add(item.key); pending.splice(pending.indexOf(item), 1); }
  }
  return rows;
}

function NodeLink({ goal, nodeKey }: { goal: CampGoal; nodeKey: string }) {
  const item = goal.items?.find(value => value.key === nodeKey);
  return item ? <a className="break-words underline underline-offset-2" href={`#${dagItemAnchor(goal.id, nodeKey)}`}>{item.title} <span className="font-mono">({nodeKey})</span></a> : <code className="break-all">{nodeKey}</code>;
}

export function CampDagInput({ goal, item }: { goal: CampGoal; item: CampWorkItem }) {
  const { formatMessage: t } = useIntl();
  const dependencies = item.dependsOnKeys ?? [], blocked = item.scheduling?.blockedByKeys ?? [];
  const operation = goal.integration?.operations.find(value => value.id === item.scopedIntegrationOperationId);
  const matchingOperation = operation && operation.scope === "node_input" && operation.planItemKey === item.key && operation.goalId === goal.id && operation.goalAttempt === goal.attempt;
  return <section className="mt-3 rounded border border-border-default p-3 text-xs" data-testid="camp-node-input" data-node-key={item.key}>
    <h6 className="font-medium">{t({ id: "camp.graph.dependencies" })}</h6>
    {dependencies.length ? <ul className="mt-2 flex flex-col gap-2">{dependencies.map(key => <li key={key} className="flex items-start gap-1"><ArrowLeft size={12} aria-hidden className="mt-0.5 shrink-0" /><NodeLink goal={goal} nodeKey={key} /></li>)}</ul> : <p className="mt-2 text-foreground-hint">{t({ id: "camp.graph.rootNode" })}</p>}
    {blocked.length > 0 && <div className="mt-3" data-testid="camp-node-blockers"><p className="font-medium">{t({ id: "camp.graph.blockedBy" })}</p><ul className="mt-2 flex flex-col gap-2">{blocked.map(key => <li key={key}><NodeLink goal={goal} nodeKey={key} /></li>)}</ul></div>}
    {(item.inputSources?.length ?? 0) > 0 && <details className="mt-3" data-testid="camp-node-sources"><summary className="cursor-pointer font-medium">{t({ id: "camp.graph.frozenSources" })}</summary><ol className="mt-3 flex flex-col gap-3">{item.inputSources!.map(source => <li key={source.key} className="rounded border border-border-default p-2" data-source-key={source.key}><NodeLink goal={goal} nodeKey={source.key} /><p className="mt-2"><CampCandidateReference candidate={source.candidate} /></p><p className="mt-2 break-all font-mono text-foreground-hint">{t({ id: "camp.integration.producer" })}: {source.runId} · {t({ id: "camp.attempt" }, { epoch: source.epoch })}</p></li>)}</ol></details>}
    {item.inputResolution && <p className="mt-3 text-foreground-secondary" data-testid="camp-node-input-resolution">{t({ id: RESOLUTION_LABELS[item.inputResolution] })}</p>}
    {item.inputCandidate && <div className="mt-3" data-testid="camp-node-effective-input"><p className="mb-2 font-medium">{t({ id: "camp.graph.effectiveInput" })}</p><CampCandidateReference candidate={item.inputCandidate} /></div>}
    {operation && !matchingOperation && <p role="alert" className="mt-3 text-danger-strong">{t({ id: "camp.integration.identityMismatch" })}</p>}
    {matchingOperation && <ol className="mt-3"><CampIntegrationOperationView operation={operation} /></ol>}
  </section>;
}

export function CampDagDelivery({ goal }: { goal: CampGoal }) {
  const { formatMessage: t } = useIntl();
  const graph = goal.graph;
  if (!graph) return null;
  return <section className="rounded-lg border border-border-default p-4" aria-label={t({ id: "camp.graph.delivery" })} data-testid="camp-graph-delivery" data-status={graph.delivery.status}>
    <h5 className="text-sm font-medium">{t({ id: "camp.graph.delivery" })}</h5>
    <p className="mt-2 text-sm" role="status">{t({ id: `camp.graph.delivery.${graph.delivery.status}` })}</p>
    <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.graph.deliveryHelp" })}</p>
    <div className="mt-3 text-xs"><p className="font-medium">{t({ id: "camp.graph.sinks" })}</p><ul className="mt-2 flex flex-col gap-2">{graph.sinkKeys.map(key => <li key={key}><NodeLink goal={goal} nodeKey={key} /></li>)}</ul></div>
    {graph.delivery.candidate && <p className="mt-3 text-xs"><CampCandidateReference candidate={graph.delivery.candidate} /></p>}
    {graph.delivery.sourceRunId && <p className="mt-2 break-all font-mono text-xs text-foreground-hint">{t({ id: "camp.integration.producer" })}: {graph.delivery.sourceRunId}</p>}
    {graph.delivery.operationId && <p className="mt-2 break-all font-mono text-xs text-foreground-hint">{t({ id: "camp.graph.deliveryOperation" })}: {graph.delivery.operationId}</p>}
  </section>;
}
