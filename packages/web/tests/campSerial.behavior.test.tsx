import assert from "node:assert/strict";
import { useState } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithIntl } from "./helpers/intl";
import api from "../src/api/client";
import CampGoalCard from "../src/components/camp/CampGoalCard";
import CampGoalComposer from "../src/components/camp/CampGoalComposer";
import CampGoalResult from "../src/components/camp/CampGoalResult";
import CampQuestionInbox from "../src/components/camp/CampQuestionInbox";
import { CampRunResults } from "../src/components/camp/CampRunViews";
import type { CampCandidate, CampGoal, CampMetrics, CampQuestion } from "../src/components/camp/campApi";

const originalGet = api.get;
const originalPost = api.post;
const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
afterEach(() => {
  cleanup(); api.get = originalGet; api.post = originalPost;
  for (const [key, descriptor] of [["createObjectURL", originalCreate], ["revokeObjectURL", originalRevoke]] as const) {
    if (descriptor) Object.defineProperty(URL, key, descriptor); else Reflect.deleteProperty(URL, key);
  }
});
const candidate: CampCandidate = { type: "layerfs", projectId: "project-1", refKind: "commit", refId: "verified-final", commitId: "verified-final", rootId: "root-1", imageId: "sha256:test" };
const layerCandidate: CampCandidate = { type: "layerfs", projectId: "project-1", refKind: "layer", refId: "initial-snapshot", layerId: "initial-snapshot", rootId: "root-1", imageId: "sha256:test" };
const metrics: CampMetrics = { runs: 10, reviewRounds: 4, elapsedSeconds: 120, itemsTotal: 2, itemsApproved: 2, questionsAsked: 2, questionsAnswered: 2, reworks: 1, humanAnswers: 1, agentAnswers: 1, manualRetries: 0 };
function goal(overrides: Partial<CampGoal> = {}): CampGoal {
  return { id: "serial-goal", roomId: "room-1", title: "Repair API and docs", description: "Complete both changes and run the acceptance suite.",
    status: "completed", reason: null, workflow: "serial", attempt: 1, budget: { maxRuns: 24, maxReviewRounds: 10, maxDurationSeconds: 3600 }, usage: { runs: 10, reviewRounds: 4, elapsedSeconds: 120 }, activeRuns: 0,
    canRetry: false, canCancel: false, createdAt: "2026-10-22T00:00:00Z", startedAt: null, completedAt: null, finalCandidate: candidate, metrics,
    summary: { summary: "Both tasks passed final acceptance.", evidence: "node --test acceptance.test.js passed", remaining: ["Optional localization follow-up"] },
    plan: { revision: 1, summary: "Implement the API, then update its docs.", tasks: [{ key: "api", title: "Repair API", description: "Preserve its contract", acceptance: "Existing calls keep working", verification: "node --test api.test.js" }] },
    items: [{ key: "api", index: 0, title: "Repair API", description: "Preserve its contract", acceptance: "Existing calls keep working", verification: "node --test api.test.js", status: "approved", reworkCount: 1, candidate, reviews: [
      { runId: "review-1", outcome: "changes_requested", summary: "Missing empty-input handling", evidence: "Empty-input regression failed", candidate: { projectId: "project-1", commitId: "rejected-version" }, createdAt: "2026-10-22T00:00:00Z" },
      { runId: "review-2", outcome: "approved", summary: "Regression fixed", evidence: ["API tests passed", "Empty-input case passed"], candidate, createdAt: "2026-10-22T00:01:00Z" },
    ] }], ...overrides };
}
function question(overrides: Partial<CampQuestion> = {}): CampQuestion {
  return { id: "question-1", goalId: "serial-goal", goalAttempt: 1, taskId: "build-api", originRunId: "run-1", fromRole: "builder", toRole: "planner", needsHuman: true, status: "awaiting_human", content: "Which response should an empty input return?", answer: null, answerByRole: null, canAnswer: true, createdAt: "2026-10-22T00:00:00Z", answeredAt: null, ...overrides };
}

test("serial goals expose the accepted plan, task evidence, rejection history, final summary and exact coordination metrics", () => {
  renderWithIntl(<CampGoalCard goal={goal()} tasks={[]} runs={[]} busy={false} onRetry={async () => {}} onCancel={async () => {}} />);
  const plan = screen.getByRole("region", { name: "Execution plan" });
  assert.ok(within(plan).getByText("Existing calls keep working"));
  assert.ok(within(plan).getByText("node --test api.test.js"));
  assert.ok(within(plan).getByText("Missing empty-input handling"));
  assert.ok(within(plan).getByText("rejected-version"));
  assert.ok(screen.getByText("Both tasks passed final acceptance."));
  assert.ok(screen.getAllByText("Version commit").length > 0);
  assert.ok(screen.getByText("Optional localization follow-up"));
  const activity = screen.getByRole("region", { name: "Workflow activity" });
  assert.match(activity.textContent ?? "", /Human decisions: 1/);
  assert.match(activity.textContent ?? "", /Role answers: 1/);
  assert.match(activity.textContent ?? "", /Manual retries: 0/);
  assert.equal(screen.queryByRole("button", { name: "Continue from this result" }), null);
});

test("human answer failure keeps its draft; same-frame retries create one write and an accepted answer closes the form", async () => {
  const calls: unknown[] = [];
  let complete: (value: unknown) => void = () => {};
  api.post = (async (_url: string, body: unknown) => { calls.push(body); if (calls.length === 1) throw { response: { data: { error: "Answer unavailable" } } }; return new Promise(resolve => { complete = resolve; }); }) as typeof api.post;
  renderWithIntl(<CampQuestionInbox roomId="room-1" questions={[question()]} onAnswered={() => {}} />);
  const field = screen.getByRole("textbox", { name: "Your answer" }) as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "Return an empty list." } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => assert.ok(screen.getByText("Answer unavailable")));
  assert.equal(field.value, "Return an empty list.");
  await act(async () => { fireEvent.submit(field.closest("form")!); fireEvent.submit(field.closest("form")!); });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { answer: "Return an empty list." });
  await act(async () => complete({ data: {} }));
  assert.equal(screen.queryByRole("textbox", { name: "Your answer" }), null);
  assert.ok(screen.getByText("Return an empty list."));
});

test("role questions do not ask a person to intervene and read-only members never see an answer form", () => {
  renderWithIntl(<CampQuestionInbox roomId="room-1" questions={[question({ needsHuman: false, status: "awaiting_role", canAnswer: false })]} onAnswered={() => {}} />);
  assert.equal(screen.queryByRole("textbox"), null);
  assert.equal(screen.queryByText("Your decision is needed"), null);
  assert.ok(screen.getByText("The addressed role will handle this question."));
});

test("a final-review rejection exposes goal-wide repair ownership and its execution evidence", () => {
  renderWithIntl(<CampGoalCard goal={goal({ status: "running", finalCandidate: null, summary: null })} tasks={[
    { id: "overall-repair", goalId: "serial-goal", goalAttempt: 1, kind: "build", planItemKey: null, role: "builder", title: "Repair whole-goal acceptance", executionStatus: "running", dependsOn: [] },
  ]} runs={[
    { id: "overall-repair-run", goalId: "serial-goal", goalAttempt: 1, taskId: "overall-repair", role: "builder", epoch: 1, taskKind: "build", planItemKey: null, status: "running", summary: null, error: null, sessionId: null, artifacts: [{ type: "file", path: "test/final.test.mjs", summary: "Whole-goal regression covered", evidence: "node --test final passed" }] },
  ]} busy={false} onRetry={async () => {}} onCancel={async () => {}} />);
  const finalization = screen.getByRole("region", { name: "Overall acceptance and coordination" });
  assert.ok(within(finalization).getByText("Overall rework"));
  assert.ok(within(finalization).getByText("Builder"));
  assert.ok(within(finalization).getByText("node --test final passed"));
});

function Continuation() {
  const [base, setBase] = useState<CampGoal | null>(null);
  return <><CampGoalComposer channelId="channel-1" busy={false} onSubmit={async () => true} defaultBudget={{ maxRuns: 24, maxReviewRounds: 10, maxDurationSeconds: 3600 }} fromGoal={base} /><CampGoalResult goal={goal({ finalCandidate: layerCandidate })} canContinue onContinue={setBase} /></>;
}
test("continuing an accepted initial snapshot preserves the next-goal draft and never starts work by itself", () => {
  let writes = 0;
  api.post = (async () => { writes += 1; return { data: {} }; }) as typeof api.post;
  renderWithIntl(<Continuation />);
  const field = screen.getByRole("textbox", { name: "Give the team a goal" }) as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "Now improve validation" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue from this result" }));
  assert.equal(field.value, "Now improve validation");
  assert.ok(screen.getByTestId("camp-continuation-base"));
  assert.ok(screen.getByText("Initial file snapshot"));
  assert.equal(writes, 0);
  assert.equal((screen.getByRole("spinbutton", { name: "Maximum runs" }) as HTMLInputElement).value, "24");
});

test("an accepted Layer without a Commit downloads through the authenticated API and remains an exportable manifest", async () => {
  const requested: string[] = [];
  const blobs: Blob[] = [];
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (blob: Blob) => { blobs.push(blob); return "blob:camp-fixture"; } });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  api.get = (async (url: string) => { requested.push(url); return { data: { schemaVersion: 1, roomId: "room-1", goalId: "serial-goal", status: "completed", resultReady: true, candidate: layerCandidate, summary: "Accepted", evidence: "Checks passed", remaining: [], metrics } }; }) as typeof api.get;
  renderWithIntl(<CampGoalResult goal={goal({ finalCandidate: layerCandidate })} canContinue={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Download result manifest" }));
  await waitFor(() => assert.equal(clicked.mock.calls.length, 1));
  assert.deepEqual(requested, ["/camp/rooms/room-1/goals/serial-goal/result"]);
  assert.equal(blobs[0]!.type, "application/json;charset=utf-8");
  assert.ok(screen.getByText("initial-snapshot"));
  assert.equal(screen.queryByText("Version commit"), null);
  assert.match(screen.getByText(/node packages\/camp-runtime\/scripts\/export.mjs/).textContent ?? "", /--manifest .\/camp-result-serial-goal.json --output/);
});

test("run and review evidence label Layer refs without presenting them as commits", () => {
  renderWithIntl(<CampRunResults runs={[{ id: "layer-review", taskId: "review-initial", role: "reviewer", epoch: 1, status: "completed", summary: "The existing files already meet the requirement", error: null, sessionId: null, artifacts: [
    { type: "layerfs", refKind: "layer", refId: "initial-snapshot", layerId: "initial-snapshot" },
    { type: "review", outcome: "approved", evidence: "Baseline acceptance passed", candidate: { projectId: "project-1", refKind: "layer", refId: "initial-snapshot", layerId: "initial-snapshot" } },
  ] }]} />);
  assert.equal(screen.getAllByText("initial-snapshot").length, 2);
  assert.ok(screen.getAllByText(/Initial file snapshot/).length > 0);
  assert.equal(screen.queryByText("Version commit"), null);
});

test("channel permission and room occupancy prevent a new execution without discarding the draft", async () => {
  let writes = 0;
  renderWithIntl(<CampGoalComposer channelId="channel-1" busy={false} canSubmit={false} roomBusy onSubmit={async () => { writes += 1; return true; }} />);
  const field = screen.getByRole("textbox", { name: "Give the team a goal" }) as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "Keep this for later" } });
  fireEvent.submit(field.closest("form")!);
  await act(async () => {});
  assert.equal(writes, 0);
  assert.equal(field.value, "Keep this for later");
  assert.equal((screen.getByRole("button", { name: "Start team" }) as HTMLButtonElement).disabled, true);
});
