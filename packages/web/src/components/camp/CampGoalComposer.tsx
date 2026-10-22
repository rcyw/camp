import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import { Button, Input, Textarea } from "@botiverse/raft-ui";
import type { CampBudget } from "./campApi";

export default function CampGoalComposer({ channelId, busy, onSubmit }: {
  channelId: string;
  busy: boolean;
  onSubmit(description: string, budget: CampBudget): Promise<boolean>;
}) {
  const { formatMessage: t } = useIntl();
  const [goal, setGoal] = useState("");
  const [maxRuns, setMaxRuns] = useState("12");
  const [maxReviewRounds, setMaxReviewRounds] = useState("3");
  const [maxMinutes, setMaxMinutes] = useState("30");
  const submitting = useRef(false);
  const editGoal = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setGoal(event.target.value), []);
  const editRuns = useCallback((event: ChangeEvent<HTMLInputElement>) => setMaxRuns(event.target.value), []);
  const editReviewRounds = useCallback((event: ChangeEvent<HTMLInputElement>) => setMaxReviewRounds(event.target.value), []);
  const editMinutes = useCallback((event: ChangeEvent<HTMLInputElement>) => setMaxMinutes(event.target.value), []);
  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (busy || submitting.current || !goal.trim()) return;
    const limits = [Number(maxRuns), Number(maxReviewRounds), Number(maxMinutes)];
    if (limits.some(value => !Number.isSafeInteger(value) || value < 1)) return;
    if (limits[0]! > 100 || limits[1]! > 20 || limits[2]! > 1440) return;
    const description = goal.trim();
    submitting.current = true;
    try {
      const accepted = await onSubmit(description, { maxRuns: limits[0]!, maxReviewRounds: limits[1]!, maxDurationSeconds: limits[2]! * 60 });
      if (accepted) setGoal(current => current.trim() === description ? "" : current);
    } finally { submitting.current = false; }
  }, [busy, goal, maxRuns, maxReviewRounds, maxMinutes, onSubmit]);

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border border-border-default bg-layer-surface p-5">
      <label htmlFor={`camp-goal-${channelId}`} className="font-medium">{t({ id: "camp.goal" })}</label>
      <Textarea id={`camp-goal-${channelId}`} value={goal} onChange={editGoal} placeholder={t({ id: "camp.goalPlaceholder" })} rows={3} maxLength={16000} required />
      <p className="text-xs text-foreground-hint">{t({ id: "camp.commandHint" })}</p>
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
        <p className="text-xs text-foreground-hint">{t({ id: "camp.pipeline" })}</p>
        <Button type="submit" disabled={busy || !goal.trim()}>{t({ id: "camp.submit" })}</Button>
      </div>
    </form>
  );
}
