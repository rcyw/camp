import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Bot, CheckCircle2, LoaderCircle, Square } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import type { CampArtifact, CampRole, CampRun, CampTask } from "./campApi";
import { campTaskStatusLabel, leaseExpired } from "./campStatus";
import CampCandidateReference, { candidateRefId, candidateRefLabel } from "./CampCandidateReference";

export function CampRoleCard({ role, runs, canCancel, busy, onCancel }: {
  role: CampRole;
  runs: CampRun[];
  canCancel: boolean;
  busy: boolean;
  onCancel(runId: string): Promise<void>;
}) {
  const { formatMessage: t } = useIntl();
  // The API returns attempts newest first. A running attempt takes precedence.
  const current = runs.find(run => (!run.executor || run.executor === "agent") && run.role === role && run.status === "running");
  const latest = current ?? runs.find(run => (!run.executor || run.executor === "agent") && run.role === role);
  const expired = leaseExpired(current);
  const cancel = useCallback(() => {
    if (current) void onCancel(current.id);
  }, [current, onCancel]);
  const label = expired ? t({ id: "camp.status.leaseExpired" }) : current?.cancelRequestedAt
    ? t({ id: "camp.status.cancelling" })
    : latest ? t({ id: `camp.status.${latest.status}` }) : t({ id: "camp.idle" });

  return (
    <article className="rounded-xl border border-border-default bg-layer-surface p-4" data-testid={`camp-role-${role}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium"><Bot size={16} />{t({ id: `camp.role.${role}` })}</span>
        {current && !expired && <LoaderCircle size={14} className="animate-spin" />}
      </div>
      <p className="mt-3 text-sm text-foreground-secondary" role="status">{label}</p>
      {latest?.cleanupState === "unknown" && <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.cleanupUnknown" })}</p>}
      {latest?.summary && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-foreground-hint">{latest.summary}</p>}
      {current && canCancel && (
        <Button className="mt-3" variant="ghost" size="sm" disabled={busy || Boolean(current.cancelRequestedAt)} onClick={cancel}>
          <Square size={11} />{t({ id: "camp.cancel" })}
        </Button>
      )}
    </article>
  );
}

export function CampTaskList({ tasks, runs }: { tasks: CampTask[]; runs: CampRun[] }) {
  const { formatMessage: t } = useIntl();
  return (
    <section aria-label={t({ id: "camp.tasks" })}>
      <h3 className="mb-3 font-medium">{t({ id: "camp.tasks" })}</h3>
      {tasks.length === 0 ? <p className="text-sm text-foreground-hint">{t({ id: "camp.noTasks" })}</p> : (
        <div className="overflow-hidden rounded-xl border border-border-default">
          {tasks.map(task => {
            const stateLabel = campTaskStatusLabel(task, runs);
            return (
              <div key={task.id} className="flex items-center justify-between gap-3 border-b border-border-default px-4 py-3 last:border-b-0">
                <div className="min-w-0">
                  <p className="truncate text-sm">{task.title}</p>
                  <p className="mt-1 text-xs text-foreground-hint">
                    {t({ id: `camp.role.${task.role}` })}
                    {task.dependsOn.length > 0 && <span className="ml-2">{t({ id: "camp.dependencies" }, { count: task.dependsOn.length })}</span>}
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-1.5 text-xs">
                  {task.executionStatus === "completed" && <CheckCircle2 size={13} />}
                  {t({ id: stateLabel })}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CampArtifactDetails({ artifact }: { artifact: CampArtifact }) {
  const { formatMessage: t } = useIntl();
  const fields = [
    ["camp.artifactPath", artifact.path],
    ["camp.branch", artifact.branch],
    [candidateRefLabel(artifact), candidateRefId(artifact)],
    ["camp.sandbox", artifact.sandboxId],
    ["camp.reviewProject", artifact.candidate?.projectId],
  ] as const;
  return (
    <div className="mt-3 min-w-0 border-t border-border-default pt-3">
      {artifact.outcome && <p className="text-sm font-medium">{t({ id: `camp.outcome.${artifact.outcome}` })}</p>}
      {artifact.summary && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground-secondary">{artifact.summary}</p>}
      <dl className="mt-2 grid gap-1 text-xs text-foreground-hint">
        {fields.map(([label, value]) => value && (
          <div key={label}><dt className="inline">{t({ id: label })}: </dt><dd className="inline break-all font-mono">{value}</dd></div>
        ))}
        {artifact.candidate && candidateRefId(artifact.candidate) && <div><dt className="inline">{t({ id: "camp.reviewCandidate" })}: </dt><dd className="inline"><CampCandidateReference candidate={artifact.candidate} /></dd></div>}
        {artifact.evidence && <div><dt className="font-medium">{t({ id: "camp.evidence" })}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{Array.isArray(artifact.evidence) ? artifact.evidence.join("\n") : artifact.evidence}</dd></div>}
      </dl>
    </div>
  );
}

export function CampRunResults({ runs }: { runs: CampRun[] }) {
  const { formatMessage: t } = useIntl();
  const results = runs.filter(run => run.artifacts.length > 0 || run.error || run.outcome || run.cleanupState === "unknown");
  if (results.length === 0) return null;
  return (
    <section>
      <h3 className="mb-3 font-medium">{t({ id: "camp.results" })}</h3>
      <div className="flex flex-col gap-3">
        {results.map(run => (
          <article key={run.id} className="min-w-0 rounded-xl border border-border-default p-4">
            <p className="mb-2 text-sm font-medium">{t({ id: run.executor === "integration" ? "camp.integration.systemOperation" : run.executor === "verification" ? "camp.verification.systemOperation" : run.role === null ? "camp.integration.unknownSystemOperation" : `camp.role.${run.role}` })} · {t({ id: "camp.attempt" }, { epoch: run.epoch })}</p>
            {run.outcome && <p className="mb-2 text-sm font-medium">{t({ id: `camp.outcome.${run.outcome}` })}</p>}
            {run.cleanupState === "unknown" && <p className="mb-2 text-xs text-foreground-hint">{t({ id: "camp.cleanupUnknown" })}</p>}
            {run.summary && <p className="whitespace-pre-wrap break-words text-sm text-foreground-secondary">{run.summary}</p>}
            {run.error && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-danger-strong">{run.error}</p>}
            {run.artifacts.map((artifact, index) => <CampArtifactDetails key={`${artifact.type}-${index}`} artifact={artifact} />)}
          </article>
        ))}
      </div>
    </section>
  );
}
