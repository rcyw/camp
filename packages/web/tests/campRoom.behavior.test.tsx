import assert from "node:assert/strict";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithIntl } from "./helpers/intl";
import CampRoomPanel from "../src/components/camp/CampRoomPanel";
import CampWorkerConnection from "../src/components/camp/CampWorkerConnection";
import { campApi } from "../src/components/camp/campApi";
import type { CampCandidate, CampGoal, CampSnapshot } from "../src/components/camp/campApi";
import type { Channel } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";

const originalApi = { ...campApi };
const originalServer = useServerStore.getState().current;
afterEach(() => { cleanup(); Object.assign(campApi, originalApi); useServerStore.setState({ current: originalServer }); });
const channel: Channel = { id: "channel", name: "Project", type: "channel", description: null, createdAt: "2026-10-23T00:00:00Z" };
const candidate: CampCandidate = { type: "layerfs", projectId: "project", refKind: "layer", refId: "initial", rootId: "root" };
function goal(overrides: Partial<CampGoal> = {}): CampGoal {
  return { id: "goal", roomId: "room", title: "First result", description: null, status: "running", reason: null, attempt: 1, budget: { maxRuns: 24, maxReviewRounds: 10, maxDurationSeconds: 3600 }, usage: { runs: 1, reviewRounds: 0, elapsedSeconds: 0 }, activeRuns: 1, canRetry: false, canCancel: true, createdAt: channel.createdAt, startedAt: null, completedAt: null, ...overrides };
}
function snapshot(value = goal()): CampSnapshot {
  return { room: { id: "room", channelId: channel.id, name: "Project", project: { name: "project" }, roles: [], acceptedHead: { revision: 1, goalId: value.id, candidate } }, goals: [value], tasks: [], runs: [], events: [], canManage: true, canSubmit: true, roomBusy: false };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("room mutations execute once per frame and a pre-mutation poll cannot undo the returned state", async () => {
  const initial = snapshot();
  const oldPoll = deferred<CampSnapshot>(), mutation = deferred<CampSnapshot>(), latestPoll = deferred<CampSnapshot>();
  let gets = 0, writes = 0, oldSignal: AbortSignal | undefined;
  campApi.roomForChannel = async () => initial.room;
  campApi.snapshot = async (_id, signal) => {
    gets++;
    if (gets === 1) return initial;
    if (gets === 2) { oldSignal = signal; return oldPoll.promise; }
    return latestPoll.promise;
  };
  campApi.cancelGoal = async () => { writes++; return mutation.promise; };
  renderWithIntl(<CampRoomPanel channel={channel} />);
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Stop goal" })));
  fireEvent.click(screen.getByRole("button", { name: "Refresh room" }));
  await waitFor(() => assert.equal(gets, 2));
  const stop = screen.getByRole("button", { name: "Stop goal" });
  await act(async () => { fireEvent.click(stop); fireEvent.click(stop); });
  assert.equal(writes, 1); assert.equal(oldSignal?.aborted, true);
  const cancelled = snapshot(goal({ title: "Cancellation accepted", status: "cancelled", activeRuns: 0, canCancel: false }));
  await act(async () => mutation.resolve(cancelled));
  await waitFor(() => assert.ok(screen.getByText("Cancellation accepted")));
  await act(async () => oldPoll.resolve(initial));
  assert.ok(screen.getByText("Cancellation accepted"));
  assert.equal(screen.queryByRole("button", { name: "Stop goal" }), null);
});

test("a changed accepted head blocks explicit continuation without discarding the goal draft", async () => {
  let current = snapshot(goal({ status: "completed", canCancel: false, activeRuns: 0, finalCandidate: candidate }));
  const writes: Array<string | undefined> = [];
  campApi.roomForChannel = async () => current.room;
  campApi.snapshot = async () => current;
  campApi.submit = async (_room, _title, _description, _budget, fromGoalId) => { writes.push(fromGoalId); };
  renderWithIntl(<CampRoomPanel channel={channel} />);
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Continue from this result" })));
  fireEvent.click(screen.getByRole("button", { name: "Continue from this result" }));
  const input = screen.getByRole("textbox", { name: "Give the team a goal" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "Keep this follow-up draft" } });
  current = { ...current, room: { ...current.room, acceptedHead: { revision: 2, goalId: "new-goal", candidate } } };
  fireEvent.click(screen.getByRole("button", { name: "Refresh room" }));
  await waitFor(() => assert.ok(screen.getByText(/room has accepted a newer result/)));
  fireEvent.submit(input.closest("form")!); assert.deepEqual(writes, []); assert.equal(input.value, "Keep this follow-up draft");
  fireEvent.click(screen.getByRole("button", { name: "Use the room's current version" }));
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => assert.equal(writes.length, 1)); assert.equal(writes[0], undefined);
});

test("server management permissions control run cancellation and worker credentials", async () => {
  useServerStore.setState({ current: { id: "server", name: "Server", avatarUrl: null, slug: "server", ownerId: "user", onboardingAgentId: null, hideHumansFromMembers: false, plan: "free", planDowngradedAt: null, role: "owner", createdAt: channel.createdAt } });
  const current = { ...snapshot(), canManage: false, runs: [{ id: "run", taskId: "task", role: "builder" as const, epoch: 1, status: "running" as const, summary: null, error: null, sessionId: null, artifacts: [] }] };
  campApi.roomForChannel = async () => current.room;
  campApi.snapshot = async () => current;
  renderWithIntl(<CampRoomPanel channel={channel} />);
  await waitFor(() => assert.ok(screen.getByTestId("camp-room-panel")));
  assert.equal(screen.queryByRole("button", { name: "Stop run" }), null);
  assert.equal(screen.queryByText("Connect a worker"), null);
});

test("same-frame credential requests issue one token", async () => {
  const issued = deferred<{ token: string; expiresAt: string }>();
  let writes = 0;
  campApi.workerToken = async () => { writes++; return issued.promise; };
  renderWithIntl(<CampWorkerConnection roomId="room" />);
  const button = screen.getByRole("button", { name: "Issue worker credential", hidden: true });
  await act(async () => { fireEvent.click(button); fireEvent.click(button); });
  assert.equal(writes, 1);
  await act(async () => issued.resolve({ token: "test-token", expiresAt: channel.createdAt }));
});


test("historical goals with a replaced baseline explain why an administrator cannot retry", async () => {
  const current = snapshot(goal({ workflow: "serial", status: "needs_attention", reason: "run_failed", activeRuns: 0, canCancel: false, baseHeadRevision: 0 }));
  campApi.roomForChannel = async () => current.room;
  campApi.snapshot = async () => current;
  renderWithIntl(<CampRoomPanel channel={channel} />);
  await waitFor(() => assert.ok(screen.getByText(/instead of retrying this old baseline/)));
  assert.equal(screen.queryByText("A server administrator can inspect this goal and start a recovery round."), null);
  assert.equal(screen.queryByRole("button", { name: "Retry goal" }), null);
});
