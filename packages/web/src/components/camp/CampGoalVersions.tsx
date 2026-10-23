import { useCallback, useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import { campApi, campError } from "./campApi";
import type { CampCandidate, CampGoal, CampVersion, CampVersionChanges, CampVersionVerification } from "./campApi";
import CampCandidateReference from "./CampCandidateReference";
import CampChangeSetView from "./CampChangeSet";
import CampVerificationReport, { sameDisplayedCandidate } from "./CampVerificationReport";

type Inspection = { changes: CampVersionChanges | null; verification: CampVersionVerification | null; changesError: string | null; verificationError: string | null };
const candidateIdentity = (candidate: CampCandidate) => JSON.stringify([candidate.projectId, candidate.imageId, candidate.refKind, candidate.refId, candidate.rootId]);

/** A keyed inspection never shows a previous version while a new request loads. */
function VersionInspection({ goal, version }: { goal: CampGoal; version: CampVersion }) {
  const { formatMessage: t } = useIntl();
  const [result, setResult] = useState<Inspection | null>(null);
  // Polling creates fresh objects for the same immutable facts. Only a change
  // in those facts should interrupt an in-flight inspection.
  const baseIdentity = goal.baseCandidate ? candidateIdentity(goal.baseCandidate) : null;
  const targetIdentity = candidateIdentity(version.candidate);
  useEffect(() => {
    if (!version.runId) return;
    const controller = new AbortController();
    void Promise.allSettled([
      campApi.versionChanges(goal.roomId, goal.id, version.runId, controller.signal),
      campApi.versionVerification(goal.roomId, goal.id, version.runId, controller.signal),
    ]).then(([diff, check]) => {
      if (controller.signal.aborted) return;
      let changes: CampVersionChanges | null = null, changesError: string | null = null;
      if (diff.status === "fulfilled") {
        if (targetIdentity !== candidateIdentity(diff.value.candidate) || (diff.value.changeSet && (targetIdentity !== candidateIdentity(diff.value.changeSet.target) || (baseIdentity && baseIdentity !== candidateIdentity(diff.value.changeSet.base))))) changesError = t({ id: "camp.versions.identityMismatch" });
        else changes = diff.value;
      } else changesError = campError(diff.reason) ?? t({ id: "camp.diff.loadFailed" });
      setResult({ changes, changesError, verification: check.status === "fulfilled" ? check.value : null, verificationError: check.status === "rejected" ? campError(check.reason) ?? t({ id: "camp.verification.loadFailed" }) : null });
    });
    return () => controller.abort();
  }, [goal.roomId, goal.id, baseIdentity, version.runId, targetIdentity, t]);
  if (!result) return <p className="text-sm text-foreground-hint" role="status">{t({ id: "camp.versions.loadingVersion" })}</p>;
  return <>
    {result.changesError && <p className="text-sm text-danger-strong" role="alert">{result.changesError}</p>}
    {result.changes?.available && result.changes.changeSet ? <CampChangeSetView changeSet={result.changes.changeSet} /> : result.changes && <p className="text-sm text-foreground-hint">{t({ id: "camp.diff.unavailable" })}</p>}
    {result.verificationError && <p className="text-sm text-danger-strong" role="alert">{result.verificationError}</p>}
    {result.verification && <CampVerificationReport status={result.verification.status} receipt={result.verification.receipt} candidate={version.candidate} policy={goal.verificationPolicy} />}
  </>;
}

function VersionHistory({ goal, selectedId, onSelect }: { goal: CampGoal; selectedId: string; onSelect(event: ChangeEvent<HTMLSelectElement>): void }) {
  const { formatMessage: t } = useIntl();
  const [response, setResponse] = useState<{ versions: CampVersion[]; error: string | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void campApi.versions(goal.roomId, goal.id, controller.signal).then(value => {
      if (!controller.signal.aborted) setResponse({ versions: value.versions, error: null });
    }).catch(failure => { if (!controller.signal.aborted) setResponse({ versions: [], error: campError(failure) ?? t({ id: "camp.versions.loadFailed" }) }); });
    return () => controller.abort();
  }, [goal.roomId, goal.id, t]);
  if (!response) return <p className="text-sm text-foreground-hint" role="status">{t({ id: "camp.versions.loading" })}</p>;
  if (response.error) return <p className="text-sm text-danger-strong" role="alert">{response.error}</p>;
  const versions = response.versions;
  if (versions.length === 0) return <p className="text-sm text-foreground-hint">{t({ id: "camp.versions.empty" })}</p>;
  const newest = [...versions].reverse(), currentCandidate = goal.finalCandidate ?? goal.currentCandidate;
  const selected = versions.find(version => version.id === selectedId) ?? newest.find(version => version.kind !== "baseline" && currentCandidate && sameDisplayedCandidate(version.candidate, currentCandidate)) ?? newest[0]!;
  return <>
    <label className="flex min-w-0 flex-col gap-2 text-sm">{t({ id: "camp.versions.select" })}<select value={selected.id} onChange={onSelect} className="max-w-full rounded border border-border-default bg-layer-canvas p-2 text-sm" data-testid="camp-version-select">{versions.map(version => <option key={version.id} value={version.id}>{t({ id: version.kind === "baseline" ? "camp.versions.baselineOption" : version.kind === "integration" ? "camp.integration.versionOption" : "camp.versions.runOption" }, { attempt: version.goalAttempt })}{version.planItemKey ? ` · ${version.planItemKey}` : ""} · {version.candidate.refId.slice(0, 16)}</option>)}</select></label>
    <p className="text-xs"><CampCandidateReference candidate={selected.candidate} /></p>
    <p className="break-all font-mono text-xs text-foreground-hint">{selected.candidate.rootId}</p>
    {selected.kind === "baseline" ? <p className="text-sm text-foreground-hint">{t({ id: "camp.versions.baselineHelp" })}</p> : <VersionInspection key={selected.id} goal={goal} version={selected} />}
  </>;
}

export default function CampGoalVersions({ goal }: { goal: CampGoal }) {
  const { formatMessage: t } = useIntl();
  const [open, setOpen] = useState(false), [revision, setRevision] = useState(0), [selectedId, setSelectedId] = useState("");
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const select = useCallback((event: ChangeEvent<HTMLSelectElement>) => setSelectedId(event.target.value), []);
  const operationRevision = goal.verification?.operations.map(operation => `${operation.id}:${operation.status}:${operation.latestRunId}`).join("|");
  const integrationRevision = goal.integration?.operations.map(operation => `${operation.id}:${operation.status}:${operation.latestRunId}:${operation.integrationReport?.status}`).join("|");
  // Parallel items publish independently while the global candidate remains
  // the shared baseline. Their immutable milestones also refresh the list.
  const itemRevision = JSON.stringify(goal.items?.map(item => [item.key, item.status, item.reworkCount, item.candidate ? candidateIdentity(item.candidate) : null, item.reviews.at(-1)?.runId]));
  const historyKey = `${goal.attempt}:${goal.status}:${(goal.finalCandidate ?? goal.currentCandidate)?.refId}:${operationRevision}:${integrationRevision}:${itemRevision}:${revision}`;
  return (
    <details className="min-w-0 rounded-lg border border-border-default p-4" onToggle={event => setOpen(event.currentTarget.open)} data-testid={`camp-versions-${goal.id}`}>
      <summary className="cursor-pointer text-sm font-medium">{t({ id: "camp.versions.title" })}</summary>
      {open && <div className="mt-3 flex min-w-0 flex-col gap-4" data-testid="camp-delivery-evidence">
        <p className="text-xs text-foreground-hint">{t({ id: "camp.versions.help" })}</p>
        <div><Button type="button" variant="ghost" size="sm" onClick={refresh}>{t({ id: "camp.versions.refresh" })}</Button></div>
        <VersionHistory key={historyKey} goal={goal} selectedId={selectedId} onSelect={select} />
      </div>}
    </details>
  );
}
