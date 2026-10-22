import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import { LoaderCircle, RefreshCw, Workflow } from "lucide-react";
import { Button, Input } from "@botiverse/raft-ui";
import type { Channel } from "../../store/channelStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { campApi, campError } from "./campApi";
import type { CampBudget, CampGoal, CampRole, CampSnapshot } from "./campApi";
import { CampRoleCard, CampRunResults, CampTaskList } from "./CampRunViews";
import CampWorkerConnection from "./CampWorkerConnection";
import CampGoalCard from "./CampGoalCard";
import CampGoalComposer from "./CampGoalComposer";

const ROLES: CampRole[] = ["planner", "builder", "reviewer"];

export default function CampRoomPanel({ channel }: { channel: Channel }) {
  const { formatMessage: t, formatTime } = useIntl();
  const { isAdminOrOwner } = useServerPermissions();
  const [snapshot, setSnapshot] = useState<CampSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [projectName, setProjectName] = useState(channel.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 48) || "camp-project");
  const [repoPath, setRepoPath] = useState("");
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let roomId: string | null = null;
    async function poll() {
      try {
        if (!roomId) roomId = (await campApi.roomForChannel(channel.id, controller.signal))?.id ?? null;
        const next = roomId ? await campApi.snapshot(roomId, controller.signal) : null;
        if (!controller.signal.aborted) {
          setSnapshot(next);
          setLoadError(null);
        }
      } catch (failure) {
        if (!controller.signal.aborted) setLoadError(campError(failure) ?? t({ id: "camp.loadError" }));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => void poll(), 2500);
        }
      }
    }
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [channel.id, revision, t]);

  const act = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); refresh(); return true; }
    catch (failure) { setError(campError(failure) ?? t({ id: "camp.actionError" })); refresh(); return false; }
    finally { setBusy(false); }
  }, [refresh, t]);

  const create = useCallback((event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    void act(async () => { await campApi.create(channel.id, channel.name, { name: projectName.trim(), repoPath: repoPath.trim() }); });
  }, [busy, act, channel.id, channel.name, projectName, repoPath]);
  const submit = useCallback(async (description: string, budget: CampBudget) => {
    if (busy || !snapshot) return false;
    return act(() => campApi.submit(snapshot.room.id, description.split("\n")[0].slice(0, 160), description, budget));
  }, [busy, snapshot, act]);
  const cancel = useCallback(async (runId: string) => {
    if (!busy && snapshot) await act(() => campApi.cancel(snapshot.room.id, runId));
  }, [busy, snapshot, act]);
  const editProjectName = useCallback((event: ChangeEvent<HTMLInputElement>) => setProjectName(event.target.value), []);
  const editRepoPath = useCallback((event: ChangeEvent<HTMLInputElement>) => setRepoPath(event.target.value), []);
  const retryGoal = useCallback(async (goal: CampGoal) => {
    if (!busy && snapshot) await act(async () => setSnapshot(await campApi.retryGoal(snapshot.room.id, goal.id, goal.attempt)));
  }, [busy, snapshot, act]);
  const cancelGoal = useCallback(async (goal: CampGoal) => {
    if (!busy && snapshot) await act(async () => setSnapshot(await campApi.cancelGoal(snapshot.room.id, goal.id)));
  }, [busy, snapshot, act]);
  const groupedGoals = useMemo(() => {
    if (!snapshot) return [];
    return (snapshot.goals ?? []).map(goal => {
      const tasks = snapshot.tasks.filter(task => task.goalId === goal.id);
      const taskIds = new Set(tasks.map(task => task.id));
      const runs = snapshot.runs.filter(run => run.goalId === goal.id || taskIds.has(run.taskId));
      return { goal, tasks, runs };
    });
  }, [snapshot]);
  const legacy = useMemo(() => {
    const goalIds = new Set((snapshot?.goals ?? []).map(goal => goal.id));
    const tasks = snapshot?.tasks.filter(task => !task.goalId || !goalIds.has(task.goalId)) ?? [];
    const taskIds = new Set(tasks.map(task => task.id));
    return { tasks, runs: snapshot?.runs.filter(run => taskIds.has(run.taskId)) ?? [] };
  }, [snapshot]);

  if (loading) {
    return <div className="flex h-full items-center justify-center gap-2 text-foreground-hint" role="status"><LoaderCircle className="animate-spin" size={16} />{t({ id: "camp.loading" })}</div>;
  }

  return (
    <section className="h-full overflow-y-auto bg-layer-canvas" data-testid="camp-room-panel">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-5 md:p-8">
        <header className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Workflow size={22} className="text-foreground-secondary" />
            <div><h2 className="text-lg font-semibold">{t({ id: "camp.title" })}</h2><p className="mt-1 text-sm text-foreground-hint">{t({ id: "camp.description" })}</p></div>
          </div>
          <Button variant="ghost" size="sm" onClick={refresh} aria-label={t({ id: "camp.refresh" })}><RefreshCw size={15} /></Button>
        </header>
        {(error || loadError) && <div role="alert" data-testid="camp-room-error" className="rounded-lg border border-border-default bg-layer-surface p-3 text-sm text-danger-strong">{error || loadError}</div>}
        {!snapshot ? !loadError && (
          <div className="rounded-xl border border-border-default bg-layer-surface p-5">
            <h3 className="font-medium">{t({ id: "camp.setupTitle" })}</h3>
            {isAdminOrOwner ? (
              <form className="mt-4 flex max-w-xl flex-col gap-4" onSubmit={create}>
                <label className="flex flex-col gap-1.5 text-sm">
                  {t({ id: "camp.projectName" })}
                  <Input value={projectName} onChange={editProjectName} required pattern="[a-z0-9][a-z0-9_.-]{0,61}[a-z0-9]|[a-z0-9]" maxLength={63} />
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  {t({ id: "camp.projectFolder" })}
                  <Input value={repoPath} onChange={editRepoPath} placeholder="/workspace/my-project" required />
                  <span className="text-xs text-foreground-hint">{t({ id: "camp.projectFolderHelp" })}</span>
                </label>
                <p className="text-sm text-foreground-hint">{t({ id: "camp.rolesCreated" })}</p>
                <Button type="submit" disabled={busy || !projectName.trim() || !repoPath.trim()}>
                  {busy && <LoaderCircle className="animate-spin" size={14} />}{t({ id: "camp.enable" })}
                </Button>
              </form>
            ) : <p className="mt-2 text-sm text-foreground-hint">{t({ id: "camp.adminRequired" })}</p>}
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {ROLES.map(role => <CampRoleCard key={role} role={role} runs={snapshot.runs} canCancel={isAdminOrOwner} busy={busy} onCancel={cancel} />)}
            </div>
            <CampGoalComposer channelId={channel.id} busy={busy} onSubmit={submit} />
            {groupedGoals.length > 0 && (
              <section aria-label={t({ id: "camp.goals" })} className="flex flex-col gap-3">
                <h3 className="font-medium">{t({ id: "camp.goals" })}</h3>
                {groupedGoals.map(group => <CampGoalCard key={group.goal.id} goal={group.goal} tasks={group.tasks} runs={group.runs} busy={busy} onRetry={retryGoal} onCancel={cancelGoal} />)}
              </section>
            )}
            {(groupedGoals.length === 0 || legacy.tasks.length > 0) && <CampTaskList tasks={legacy.tasks} runs={legacy.runs} />}
            <CampRunResults runs={legacy.runs} />
            <section>
              <h3 className="mb-3 font-medium">{t({ id: "camp.activity" })}</h3>
              <ol className="flex flex-col gap-3">
                {snapshot.events.slice(-30).map(event => (
                  <li key={event.id} className="flex gap-3 text-sm">
                    <time className="shrink-0 pt-0.5 font-mono text-xs text-foreground-hint">{formatTime(event.createdAt)}</time>
                    <p className="min-w-0 whitespace-pre-wrap break-words text-foreground-secondary">{event.content}</p>
                  </li>
                ))}
              </ol>
            </section>
            {isAdminOrOwner && <CampWorkerConnection key={snapshot.room.id} roomId={snapshot.room.id} />}
          </>
        )}
      </div>
    </section>
  );
}
