import assert from "node:assert/strict";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithIntl } from "./helpers/intl";
import api from "../src/api/client";
import CampGoalCard from "../src/components/camp/CampGoalCard";
import CampGoalComposer from "../src/components/camp/CampGoalComposer";
import { campApi } from "../src/components/camp/campApi";
import type { CampBudget, CampGoal, CampRun, CampTask } from "../src/components/camp/campApi";

const originalPost = api.post;
afterEach(() => { cleanup(); api.post = originalPost; });

function goal(overrides: Partial<CampGoal> = {}): CampGoal {
  return {
    id: "goal-1", roomId: "room-1", title: "Repair parser", description: "Preserve the public API.",
    status: "needs_attention", reason: "run_budget_exhausted", attempt: 2,
    budget: { maxRuns: 12, maxReviewRounds: 3, maxDurationSeconds: 1800 },
    usage: { runs: 12, reviewRounds: 1, elapsedSeconds: 90 }, activeRuns: 0,
    canRetry: true, canCancel: false, createdAt: "2026-10-22T00:00:00Z", startedAt: null, completedAt: null,
    ...overrides,
  };
}
function task(id: string, role: CampTask["role"], title: string, dependsOn: string[] = [], goalAttempt = 2): CampTask {
  return { id, goalId: "goal-1", goalAttempt, role, title, executionStatus: dependsOn.length ? "blocked" : "completed", dependsOn };
}
function run(overrides: Partial<CampRun> = {}): CampRun {
  return { id: "run-old", taskId: "old", goalId: "goal-1", goalAttempt: 1, role: "reviewer", epoch: 1, status: "completed", summary: "Earlier review", error: null, sessionId: "old-session",
    artifacts: [{ type: "review", outcome: "changes_requested", evidence: ["Test A failed", "Test B passed"], candidate: { projectId: "project-1", commitId: "older-candidate" } }], ...overrides };
}

test("a goal shows only its current dependency steps while keeping older candidate review evidence", () => {
  renderWithIntl(<CampGoalCard goal={goal()} tasks={[
    task("old", "planner", "Obsolete step", [], 1),
    task("plan", "planner", "Plan current round"),
    task("build", "builder", "Implement current round", ["plan"]),
    task("review", "reviewer", "Verify current round", ["build"]),
  ]} runs={[run()]} busy={false} onRetry={async () => {}} onCancel={async () => {}} />);
  const graph = screen.getByRole("list", { name: "Goal dependencies and execution steps" });
  assert.equal(within(graph).queryByText("Obsolete step"), null);
  assert.equal(within(graph).getAllByText("Plan current round").length, 2);
  assert.equal(within(graph).getAllByText("Implement current round").length, 2);
  assert.ok(screen.getByText("The run limit for this round was reached."));
  assert.ok(screen.getByText("older-candidate"));
  assert.ok(screen.getByText(/Test A failed\s+Test B passed/));
  assert.ok(screen.getByText("Execution round 2"));
});

test("goal recovery follows server permissions and keeps stopping distinct from completed cancellation", () => {
  renderWithIntl(<CampGoalCard goal={goal({ status: "cancelling", reason: "cancel_requested", activeRuns: 1, canRetry: false, canCancel: false })} tasks={[]} runs={[]} busy={false} onRetry={async () => { throw new Error("Must not retry"); }} onCancel={async () => { throw new Error("Must not cancel"); }} />);
  assert.equal(screen.queryByRole("button", { name: "Retry goal" }), null);
  assert.equal(screen.queryByRole("button", { name: "Stop goal" }), null);
  assert.ok(screen.getByRole("status").textContent?.includes("Stopping and cleaning up"));
  assert.ok(screen.getByText(/The goal remains here until active runs are fenced/));
});

test("unconfirmed old sandbox cleanup stays visible without hiding an authorized isolated retry", () => {
  renderWithIntl(<CampGoalCard goal={goal({ status: "cancelled", reason: "cancelled_by_human" })} tasks={[]} runs={[run({ status: "cancelled", cleanupState: "unknown", artifacts: [], summary: null })]} busy={false} onRetry={async () => {}} onCancel={async () => {}} />);
  assert.ok(screen.getByText("Cleanup of an earlier sandbox is still unconfirmed. Check the execution history."));
  assert.ok(screen.getByText("This attempt can no longer submit results. Its sandbox cleanup has not been confirmed."));
  assert.equal((screen.getByRole("button", { name: "Retry goal" }) as HTMLButtonElement).disabled, false);
});

test("unknown recovery reasons have usable localized text without pretending to know the cause", () => {
  renderWithIntl(<CampGoalCard goal={goal({ reason: "future_recovery_code", canRetry: false })} tasks={[]} runs={[]} busy={false} onRetry={async () => {}} onCancel={async () => {}} />, { locale: "zh-cn" });
  assert.ok(screen.getByRole("alert").textContent?.includes("此目标需要先检查执行记录"));
  assert.equal(screen.queryByText("future_recovery_code"), null);
});

test("an explicit retry carries the observed attempt for server compare-and-swap", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body: unknown) => { requests.push({ url, body }); return { data: {} }; }) as typeof api.post;
  renderWithIntl(<CampGoalCard goal={goal()} tasks={[]} runs={[]} busy={false} onRetry={async value => { await campApi.retryGoal(value.roomId, value.id, value.attempt); }} onCancel={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry goal" }));
  await waitFor(() => assert.equal(requests.length, 1));
  assert.deepEqual(requests[0], { url: "/camp/rooms/room-1/goals/goal-1/retry", body: { expectedAttempt: 2 } });
});

test("goal submission fences same-frame repeats, preserves failed drafts, and sends bounded limits on an explicit retry", async () => {
  const accepted: Array<{ description: string; budget: CampBudget }> = [];
  let settle: (accepted: boolean) => void = () => {};
  const submit = async (description: string, budget: CampBudget) => {
    accepted.push({ description, budget });
    return new Promise<boolean>(resolve => { settle = resolve; });
  };
  renderWithIntl(<CampGoalComposer channelId="channel-1" busy={false} onSubmit={submit} />);
  const input = screen.getByRole("textbox", { name: "Give the team a goal" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "Fix the parser\nKeep compatibility." } });
  const form = input.closest("form")!;
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(accepted.length, 1);
  await act(async () => settle(false));
  assert.equal(input.value, "Fix the parser\nKeep compatibility.");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Maximum runs" }), { target: { value: "8" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Maximum minutes" }), { target: { value: "10" } });
  await act(async () => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.equal(accepted.length, 2);
  assert.deepEqual(accepted[1]!.budget, { maxRuns: 8, maxReviewRounds: 3, maxDurationSeconds: 600 });
  fireEvent.change(input, { target: { value: "A newer draft while the request is pending" } });
  await act(async () => settle(true));
  assert.equal(input.value, "A newer draft while the request is pending");
});
