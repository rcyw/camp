import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, CheckCircle2, RotateCcw, Square } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import type { CampGoal, CampIntegrationOperation, CampRun, CampTask } from "./campApi";
import { CampRunExecution, CampRunResults } from "./CampRunViews";
import { campTaskStatusLabel } from "./campStatus";
import type { MessageId } from "../../i18n/messages/en";
import CampSerialPlan from "./CampSerialPlan";
import CampGoalResult from "./CampGoalResult";
import CampGoalVerificationView from "./CampGoalVerification";
import CampGoalVersions from "./CampGoalVersions";
import CampGoalIntegration from "./CampGoalIntegration";
import CampExecutionPool from "./CampExecutionPool";
import { hasSharedBaseline, planModeLabel } from "./campPlanMode";

const REASON_LABELS: Partial<Record<string, MessageId>> = {
  run_failed: "camp.reason.run_failed",
  run_cancelled: "camp.reason.run_cancelled",
  run_attempts_exhausted: "camp.reason.run_attempts_exhausted",
  run_budget_exhausted: "camp.reason.run_budget_exhausted",
  review_budget_exhausted: "camp.reason.review_budget_exhausted",
  duration_budget_exhausted: "camp.reason.duration_budget_exhausted",
  dependency_blocked: "camp.reason.dependency_blocked",
  role_unavailable: "camp.reason.role_unavailable",
  channel_unavailable: "camp.reason.channel_unavailable",
  cancel_requested: "camp.reason.cancel_requested",
  cancelled_by_human: "camp.reason.cancelled_by_human",
  stale_baseline: "camp.reason.stale_baseline",
  integration_conflict: "camp.reason.integration_conflict",
  integration_rejected: "camp.reason.integration_rejected",
  integration_inspection_required: "camp.reason.integration_inspection_required",
  integration_error: "camp.reason.integration_error",
};

/** The step cards show actual prerequisites, including blocked dependencies. */
function GoalSteps({ tasks, runs }: { tasks: CampTask[]; runs: CampRun[] }) {
  const { formatMessage: t } = useIntl();
  const byId = new Map(tasks.map(task => [task.id, task]));
  return (
    <ol className="grid gap-3 sm:grid-cols-3" aria-label={t({ id: "camp.goalSteps" })}>
      {tasks.map(task => (
        <li key={task.id} className="min-w-0 rounded-lg border border-border-default bg-layer-canvas p-3">
          <p className="text-xs font-medium text-foreground-hint">{t({ id: `camp.role.${task.role}` })}</p>
          <p className="mt-1 break-words text-sm">{task.title}</p>
          <p className="mt-2 flex items-center gap-1 text-xs text-foreground-secondary">
            {task.executionStatus === "completed" && <CheckCircle2 size={12} />}
            {t({ id: campTaskStatusLabel(task, runs) })}
          </p>
          {task.dependsOn.length > 0 && (
            <div className="mt-3 border-t border-border-default pt-2 text-xs text-foreground-hint">
              <p>{t({ id: "camp.requires" })}</p>
              <ul className="mt-1 flex flex-col gap-1">
                {task.dependsOn.map(id => <li key={id} className="flex items-start gap-1"><ArrowLeft size={12} className="mt-0.5 shrink-0" /><span className="break-words">{byId.get(id)?.title ?? t({ id: "camp.externalDependency" })}</span></li>)}
              </ul>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

export default function CampGoalCard({ goal, tasks, runs, busy, onRetry, onCancel, canContinue = false, onContinue, staleBaseline = false, integrationHistory }: {
  goal: CampGoal;
  tasks: CampTask[];
  runs: CampRun[];
  busy: boolean;
  onRetry(goal: CampGoal): Promise<void>;
  onCancel(goal: CampGoal): Promise<void>;
  canContinue?: boolean;
  onContinue?(goal: CampGoal): void;
  staleBaseline?: boolean;
  integrationHistory?: CampIntegrationOperation[];
}) {
  const { formatMessage: t, formatNumber } = useIntl();
  const currentTasks = useMemo(() => tasks.filter(task => task.goalAttempt === goal.attempt), [tasks, goal.attempt]);
  const currentRuns = useMemo(() => runs.filter(run => run.goalAttempt === goal.attempt), [runs, goal.attempt]);
  const retry = useCallback(() => { if (goal.canRetry) void onRetry(goal); }, [goal, onRetry]);
  const cancel = useCallback(() => { if (goal.canCancel) void onCancel(goal); }, [goal, onCancel]);
  const minutes = (seconds: number) => formatNumber(seconds / 60, { maximumFractionDigits: 1 });
  const hasHistory = runs.some(run => run.artifacts.length > 0 || run.error || run.outcome || run.cleanupState === "unknown");
  const inspectionRequired = goal.integrationInspectionRequired || goal.reason === "integration_inspection_required";
  const stoppingRuns = currentRuns.filter(run => run.cancelRequestedAt || run.status === "cancelled" || run.cleanupState === "unknown" || (run.status === "running" && ["cancelling", "cancelled", "needs_attention"].includes(goal.status)));

  return (
    <article className="flex flex-col gap-4 rounded-xl border border-border-default bg-layer-surface p-4 md:p-5" data-testid={`camp-goal-${goal.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="break-words font-medium">{goal.title}</h4>
          <p className="mt-1 text-xs text-foreground-hint">{t({ id: "camp.goalAttempt" }, { attempt: goal.attempt })}</p>
          {goal.workflow === "serial" && <p className="mt-1 text-xs text-foreground-hint" data-testid="camp-goal-plan-mode">{t({ id: planModeLabel(goal.planMode) })}</p>}
        </div>
        <p className="text-sm font-medium" role="status">{t({ id: `camp.goalStatus.${goal.status}` })}</p>
      </header>
      {goal.description && goal.description !== goal.title && <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm text-foreground-secondary">{goal.description}</p>}
      <dl className="grid gap-2 rounded-lg bg-layer-canvas p-3 text-xs sm:grid-cols-3">
        <div><dt className="text-foreground-hint">{t({ id: "camp.runBudget" })}</dt><dd className="mt-1 font-medium">{t({ id: "camp.usedLimit" }, { used: goal.usage.runs, limit: goal.budget.maxRuns })}</dd></div>
        <div><dt className="text-foreground-hint">{t({ id: "camp.reviewBudget" })}</dt><dd className="mt-1 font-medium">{t({ id: "camp.usedLimit" }, { used: goal.usage.reviewRounds, limit: goal.budget.maxReviewRounds })}</dd></div>
        <div><dt className="text-foreground-hint">{t({ id: "camp.timeBudget" })}</dt><dd className="mt-1 font-medium">{t({ id: "camp.minutesUsedLimit" }, { used: minutes(goal.usage.elapsedSeconds), limit: minutes(goal.budget.maxDurationSeconds) })}</dd></div>
      </dl>
      <p className="text-xs text-foreground-hint">{t({ id: "camp.activeRuns" }, { count: goal.activeRuns })}</p>
      <CampExecutionPool goal={goal} />
      {goal.planMode === "parallel_pair" && stoppingRuns.length > 0 && <section className="rounded-lg border border-border-default p-4" aria-label={t({ id: "camp.parallel.cleanupTitle" })} data-testid="camp-parallel-cleanup"><h5 className="text-sm font-medium">{t({ id: "camp.parallel.cleanupTitle" })}</h5><p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.parallel.cleanupHelp" })}</p><div className="mt-3 grid gap-3 sm:grid-cols-2">{stoppingRuns.map(run => <CampRunExecution key={run.id} run={run} pool={goal.executionPool} />)}</div></section>}
      {runs.some(run => run.cleanupState === "unknown") && <p className="text-xs text-foreground-hint">{t({ id: "camp.goalCleanupUnknown" })}</p>}
      {(goal.reason || goal.status === "needs_attention") && (
        <p className="rounded-lg border border-border-default p-3 text-sm text-foreground-secondary" role={goal.status === "needs_attention" ? "alert" : undefined}>
          {t({ id: (goal.reason ? REASON_LABELS[goal.reason] : undefined) ?? "camp.reason.unknown" })}
        </p>
      )}
      {goal.status === "cancelling" && <p className="text-xs text-foreground-hint">{t({ id: "camp.goalStoppingHelp" })}</p>}
      {goal.status === "needs_attention" && !goal.canRetry && goal.activeRuns > 0 && <p className="text-xs text-foreground-hint">{t({ id: "camp.recoveryPending" })}</p>}
      {staleBaseline && ["needs_attention", "cancelled"].includes(goal.status) && <p className="text-xs text-foreground-hint">{t({ id: "camp.reason.stale_baseline" })}</p>}
      {inspectionRequired && <p className="text-xs text-foreground-hint">{t({ id: "camp.integration.inspectionHelp" })}</p>}
      {goal.status === "needs_attention" && !goal.canRetry && goal.activeRuns === 0 && !staleBaseline && !inspectionRequired && <p className="text-xs text-foreground-hint">{t({ id: "camp.recoveryAdminRequired" })}</p>}
      {goal.metrics && <section aria-label={t({ id: "camp.metrics.title" })} className="grid gap-2 text-xs sm:grid-cols-3"><p>{t({ id: "camp.metrics.items" })}: {goal.metrics.itemsApproved} / {goal.metrics.itemsTotal}</p><p>{t({ id: "camp.metrics.questions" })}: {goal.metrics.questionsAnswered} / {goal.metrics.questionsAsked}</p><p>{t({ id: "camp.metrics.reworks" })}: {goal.metrics.reworks}</p><p>{t({ id: "camp.metrics.humanAnswers" })}: {goal.metrics.humanAnswers}</p><p>{t({ id: "camp.metrics.agentAnswers" })}: {goal.metrics.agentAnswers}</p><p>{t({ id: "camp.metrics.manualRetries" })}: {goal.metrics.manualRetries}</p></section>}
      {goal.workflow === "serial" ? <CampSerialPlan goal={goal} tasks={currentTasks} runs={currentRuns} /> : <GoalSteps tasks={currentTasks} runs={currentRuns} />}
      <CampGoalIntegration goal={goal} history={integrationHistory} />
      <CampGoalVerificationView goal={goal} />
      <CampGoalResult goal={goal} canContinue={canContinue} onContinue={onContinue} />
      {goal.workflow === "serial" && <CampGoalVersions goal={goal} />}
      {(goal.canRetry || goal.canCancel) && (
        <div className="flex flex-wrap items-center gap-2">
          {goal.canRetry && <Button variant="outline" size="sm" disabled={busy} onClick={retry}><RotateCcw size={13} />{t({ id: "camp.retryGoal" })}</Button>}
          {goal.canCancel && <Button variant="ghost" size="sm" disabled={busy} onClick={cancel}><Square size={12} />{t({ id: "camp.cancelGoal" })}</Button>}
          {goal.canRetry && <p className="text-xs text-foreground-hint">{t({ id: hasSharedBaseline(goal.planMode) ? "camp.integration.retryGoalHelp" : "camp.retryGoalHelp" })}</p>}
        </div>
      )}
      {(hasHistory || (goal.planMode === "parallel_pair" && runs.length > 0)) && <details className="border-t border-border-default pt-3" data-testid="camp-goal-history"><summary className="mb-3 cursor-pointer text-sm">{t({ id: "camp.goalHistory" })}</summary><CampRunResults runs={runs} showExecution={goal.planMode === "parallel_pair"} pool={goal.executionPool} /></details>}
    </article>
  );
}
