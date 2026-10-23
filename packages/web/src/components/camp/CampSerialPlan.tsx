import { useMemo } from "react";
import { useIntl } from "react-intl";
import type { CampGoal, CampRun, CampTask, CampWorkItem } from "./campApi";
import { CampRunResults } from "./CampRunViews";
import { campTaskStatusLabel } from "./campStatus";
import CampCandidateReference from "./CampCandidateReference";

function ReviewHistory({ reviews }: { reviews: CampWorkItem["reviews"] }) {
  const { formatMessage: t } = useIntl();
  if (reviews.length === 0) return null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs font-medium">{t({ id: "camp.item.reviews" }, { count: reviews.length })}</summary>
      <ol className="mt-2 flex flex-col gap-2">
        {reviews.map((review, index) => (
          <li key={`${review.runId}-${index}`} className="rounded border border-border-default p-3 text-xs">
            <p className="font-medium">{t({ id: `camp.outcome.${review.outcome}` })}</p>
            <p className="mt-1 whitespace-pre-wrap break-words">{review.summary}</p>
            <p className="mt-2 whitespace-pre-wrap break-words text-foreground-hint">{Array.isArray(review.evidence) ? review.evidence.join("\n") : review.evidence}</p>
            {review.candidate && <p className="mt-2 text-foreground-hint"><CampCandidateReference candidate={review.candidate} /></p>}
          </li>
        ))}
      </ol>
    </details>
  );
}

function WorkItem({ item, tasks, runs, goal }: { item: CampWorkItem; tasks: CampTask[]; runs: CampRun[]; goal: CampGoal }) {
  const { formatMessage: t } = useIntl();
  const related = tasks.filter(task => task.planItemKey === item.key);
  const taskIds = new Set(related.map(task => task.id));
  const history = useMemo(() => {
    const ids = new Set(tasks.filter(task => task.planItemKey === item.key).map(task => task.id));
    return runs.filter(run => run.planItemKey === item.key || (run.taskId !== null && ids.has(run.taskId)));
  }, [tasks, runs, item.key]);
  const active = related.find(task => task.executionStatus === "running" || task.executionStatus === "waiting_question");
  const owner = active?.role ?? (item.status === "reviewing" ? "reviewer" : "builder");
  const questions = (goal.questions ?? []).filter(question => taskIds.has(question.taskId) && !["answered", "cancelled"].includes(question.status));
  const failure = item.status === "needs_attention" ? history.find(run => run.error || run.status === "failed") : undefined;
  return (
    <li className="rounded-lg border border-border-default bg-layer-canvas p-4" data-testid={`camp-plan-item-${item.key}`}>
      <header className="flex flex-wrap justify-between gap-2"><h6 className="min-w-0 break-words text-sm font-medium">{item.index + 1}. {item.title}</h6><span className="text-xs font-medium">{t({ id: `camp.item.status.${item.status}` })}</span></header>
      <p className="mt-1 text-xs text-foreground-hint">{t({ id: "camp.item.owner" }, { role: t({ id: `camp.role.${owner}` }) })}</p>
      {item.description && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground-secondary">{item.description}</p>}
      {goal.planMode === "same_baseline_pair" && <div className="mt-3 text-xs text-foreground-hint" data-testid="camp-item-shared-baseline"><p>{t({ id: "camp.integration.itemBaseHelp" })}</p>{goal.baseCandidate && <p className="mt-1"><CampCandidateReference candidate={goal.baseCandidate} /></p>}</div>}
      <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
        <div><dt className="font-medium">{t({ id: "camp.item.acceptance" })}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-foreground-secondary">{item.acceptance}</dd></div>
        <div><dt className="font-medium">{t({ id: "camp.item.verification" })}</dt><dd className="mt-1 whitespace-pre-wrap break-words font-mono text-foreground-secondary">{item.verification}</dd></div>
      </dl>
      {questions.length > 0 && <div className="mt-3 text-sm"><p className="font-medium">{t({ id: "camp.item.blocked" })}</p>{questions.map(question => <p key={question.id} className="mt-1 whitespace-pre-wrap break-words text-foreground-secondary">{question.content}</p>)}</div>}
      {failure && <p className="mt-3 whitespace-pre-wrap break-words text-sm text-danger-strong">{failure.error ?? failure.summary}</p>}
      {item.status === "pending" && questions.length === 0 && <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.item.waiting" })}</p>}
      {item.candidate && <p className="mt-3 text-xs text-foreground-hint">{t({ id: "camp.result.candidate" })}: <CampCandidateReference candidate={item.candidate} /></p>}
      <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.item.reworks" }, { count: item.reworkCount })}</p>
      <ReviewHistory reviews={item.reviews} />
      {history.length > 0 && <details className="mt-3"><summary className="mb-3 cursor-pointer text-xs text-foreground-hint">{t({ id: "camp.item.history" })}</summary><CampRunResults runs={history} /></details>}
    </li>
  );
}

export default function CampSerialPlan({ goal, tasks, runs }: { goal: CampGoal; tasks: CampTask[]; runs: CampRun[] }) {
  const { formatMessage: t } = useIntl();
  const finalTasks = useMemo(() => tasks.filter(task => task.kind === "final_review" || task.kind === "summary" || (task.kind === "build" && !task.planItemKey)), [tasks]);
  const finalRuns = useMemo(() => {
    const ids = new Set(finalTasks.map(task => task.id));
    return runs.filter(run => run.taskId !== null && ids.has(run.taskId));
  }, [runs, finalTasks]);
  return (
    <section aria-label={t({ id: "camp.plan.title" })} className="flex flex-col gap-3">
      {!goal.plan ? <p className="rounded-lg bg-layer-canvas p-3 text-sm text-foreground-hint">{t({ id: "camp.plan.pending" })}</p> : <details open className="rounded-lg border border-border-default p-4">
        <summary className="cursor-pointer text-sm font-medium">{t({ id: "camp.plan.items" }, { count: goal.items?.length ?? goal.plan.tasks.length })}</summary>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm text-foreground-secondary">{goal.plan.summary}</p>
        {goal.planMode === "same_baseline_pair" && <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.planMode.pairHelp" })}</p>}
        <ol className="mt-4 flex flex-col gap-3">{(goal.items ?? []).map(item => <WorkItem key={item.key} item={item} goal={goal} tasks={tasks} runs={runs} />)}</ol>
      </details>}
      {finalTasks.length > 0 && (
        <section aria-label={t({ id: "camp.plan.finalization" })} className="rounded-lg border border-border-default p-4">
          <h5 className="text-sm font-medium">{t({ id: "camp.plan.finalization" })}</h5>
          <ol className="mt-3 flex flex-col gap-2">
            {finalTasks.map(task => (
              <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span>{t({ id: task.kind === "final_review" ? "camp.plan.finalReview" : task.kind === "build" ? "camp.plan.overallRework" : "camp.plan.summary" })}</span>
                <span>{t({ id: `camp.role.${task.role}` })}</span>
                <span>{t({ id: campTaskStatusLabel(task, runs) })}</span>
              </li>
            ))}
          </ol>
          <CampRunResults runs={finalRuns} />
        </section>
      )}
    </section>
  );
}
