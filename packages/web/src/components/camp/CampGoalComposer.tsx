import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import { Button, Input, Textarea } from "@botiverse/raft-ui";
import { CAMP_LIMITS, DEFAULT_CAMP_BUDGET } from "../../../../camp-protocol/src/index.js";
import type { CampBudget, CampPlanMode } from "./campApi";
import { planModeHelp, planModePipeline } from "./campPlanMode";

export default function CampGoalComposer({ channelId, busy, onSubmit, defaultBudget, fromGoal, onClearFromGoal, canSubmit = true, roomBusy = false, verificationConfigured = true, continuationStale = false, supportedPlanModes }: {
  channelId: string;
  busy: boolean;
  onSubmit(description: string, budget: CampBudget, planMode: CampPlanMode): Promise<boolean>;
  defaultBudget?: CampBudget;
  fromGoal?: { id: string; title: string } | null;
  onClearFromGoal?(): void;
  canSubmit?: boolean;
  roomBusy?: boolean;
  verificationConfigured?: boolean;
  continuationStale?: boolean;
  supportedPlanModes?: CampPlanMode[];
}) {
  const { formatMessage: t } = useIntl();
  const [goal, setGoal] = useState("");
  const [planMode, setPlanMode] = useState<CampPlanMode>("sequential");
  const supportsPair = supportedPlanModes?.includes("same_baseline_pair") === true;
  const supportsParallel = supportedPlanModes?.includes("parallel_pair") === true;
  const supportsDag = supportedPlanModes?.includes("bounded_dag") === true;
  const unsupportedMode = planMode !== "sequential" && !supportedPlanModes?.includes(planMode);
  const [maxRuns, setMaxRuns] = useState(String(defaultBudget?.maxRuns ?? DEFAULT_CAMP_BUDGET.maxRuns));
  const [maxReviewRounds, setMaxReviewRounds] = useState(String(defaultBudget?.maxReviewRounds ?? DEFAULT_CAMP_BUDGET.maxReviewRounds));
  const [maxMinutes, setMaxMinutes] = useState(String(Math.ceil((defaultBudget?.maxDurationSeconds ?? DEFAULT_CAMP_BUDGET.maxDurationSeconds) / 60)));
  const submitting = useRef(false);
  const editGoal = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setGoal(event.target.value), []);
  const editMode = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    if (value === "sequential" || (value === "same_baseline_pair" && supportsPair) || (value === "parallel_pair" && supportsParallel) || (value === "bounded_dag" && supportsDag)) setPlanMode(value);
  }, [supportsPair, supportsParallel, supportsDag]);
  const editRuns = useCallback((event: ChangeEvent<HTMLInputElement>) => setMaxRuns(event.target.value), []);
  const editReviewRounds = useCallback((event: ChangeEvent<HTMLInputElement>) => setMaxReviewRounds(event.target.value), []);
  const editMinutes = useCallback((event: ChangeEvent<HTMLInputElement>) => setMaxMinutes(event.target.value), []);
  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !canSubmit || roomBusy || !verificationConfigured || continuationStale || unsupportedMode || submitting.current || !goal.trim()) return;
    const limits = [Number(maxRuns), Number(maxReviewRounds), Number(maxMinutes)];
    if (limits.some(value => !Number.isSafeInteger(value) || value < 1)) return;
    if (limits[0]! > 100 || limits[1]! > 20 || limits[2]! > 1440) return;
    const description = goal.trim();
    submitting.current = true;
    try {
      const accepted = await onSubmit(description, { maxRuns: limits[0]!, maxReviewRounds: limits[1]!, maxDurationSeconds: limits[2]! * 60 }, planMode);
      if (accepted) {
        setGoal(current => current.trim() === description ? "" : current);
        setPlanMode(current => current === planMode ? "sequential" : current);
      }
    } finally { submitting.current = false; }
  }, [busy, canSubmit, roomBusy, verificationConfigured, continuationStale, unsupportedMode, goal, maxRuns, maxReviewRounds, maxMinutes, planMode, onSubmit]);

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border border-border-default bg-layer-surface p-5">
      <label htmlFor={`camp-goal-${channelId}`} className="font-medium">{t({ id: "camp.goal" })}</label>
      <Textarea id={`camp-goal-${channelId}`} value={goal} onChange={editGoal} placeholder={t({ id: "camp.goalPlaceholder" })} rows={3} maxLength={CAMP_LIMITS.text} required />
      <p className="text-xs text-foreground-hint">{t({ id: "camp.commandHint" })}</p>
      {(supportsPair || supportsParallel || supportsDag || unsupportedMode) && <div className="flex flex-col gap-2 rounded-lg border border-border-default p-3">
        <label className="flex flex-col gap-2 text-sm">{t({ id: "camp.planMode.label" })}<select value={planMode} onChange={editMode} disabled={busy} className="rounded border border-border-default bg-layer-canvas p-2 text-sm" data-testid="camp-plan-mode">
          <option value="sequential">{t({ id: "camp.planMode.sequential" })}</option>
          <option value="same_baseline_pair" disabled={!supportsPair}>{t({ id: "camp.planMode.same_baseline_pair" })}</option>
          {(supportsParallel || planMode === "parallel_pair") && <option value="parallel_pair" disabled={!supportsParallel}>{t({ id: "camp.planMode.parallel_pair" })}</option>}
          {(supportsDag || planMode === "bounded_dag") && <option value="bounded_dag" disabled={!supportsDag}>{t({ id: "camp.planMode.bounded_dag" })}</option>}
        </select></label>
        <p className="text-xs text-foreground-hint">{t({ id: planModeHelp(planMode) })}</p>
        {unsupportedMode && <p className="text-xs text-danger-strong" role="status">{t({ id: "camp.planMode.unavailable" })}</p>}
      </div>}
      {(!canSubmit || roomBusy) && <p className="text-xs text-foreground-hint" role="status">{t({ id: roomBusy ? "camp.room.busy" : "camp.room.postRequired" })}</p>}
      {!verificationConfigured && <p className="text-xs text-foreground-hint" role="status">{t({ id: "camp.policy.submitBlocked" })}</p>}
      {fromGoal && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-default p-3 text-sm" data-testid="camp-continuation-base">
          <p>{t({ id: "camp.continueFrom" }, { title: fromGoal.title })}</p>
          {continuationStale && <p role="status" className="w-full text-danger-strong">{t({ id: "camp.continuationChanged" })}</p>}
          {onClearFromGoal && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClearFromGoal}>{t({ id: "camp.clearContinuation" })}</Button>}
        </div>
      )}
      <details className="rounded-lg border border-border-default p-3">
        <summary className="cursor-pointer text-sm font-medium">{t({ id: "camp.limits" })}</summary>
        <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.limitsHelp" })}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs">{t({ id: "camp.maxRuns" })}<Input type="number" value={maxRuns} onChange={editRuns} min={1} max={100} step={1} required /></label>
          <label className="flex flex-col gap-1 text-xs">{t({ id: "camp.maxReviewRounds" })}<Input type="number" value={maxReviewRounds} onChange={editReviewRounds} min={1} max={20} step={1} required /></label>
          <label className="flex flex-col gap-1 text-xs">{t({ id: "camp.maxMinutes" })}<Input type="number" value={maxMinutes} onChange={editMinutes} min={1} max={1440} step={1} required /></label>
        </div>
      </details>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-foreground-hint">{t({ id: planModePipeline(planMode) })}</p>
        <Button type="submit" disabled={busy || !canSubmit || roomBusy || !verificationConfigured || continuationStale || unsupportedMode || !goal.trim()}>{t({ id: "camp.submit" })}</Button>
      </div>
    </form>
  );
}
