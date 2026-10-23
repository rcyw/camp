import assert from "node:assert/strict";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithIntl, TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import CampGoalComposer from "../src/components/camp/CampGoalComposer";
import CampGoalCard from "../src/components/camp/CampGoalCard";
import CampGoalVersions from "../src/components/camp/CampGoalVersions";
import CampWorkerDiagnostics from "../src/components/camp/CampWorkerDiagnostics";
import CampWorkerConnection from "../src/components/camp/CampWorkerConnection";
import { CampRoleCard } from "../src/components/camp/CampRunViews";
import { campApi } from "../src/components/camp/campApi";
import type { CampCandidate, CampExecutionPool, CampGoal, CampPlanMode, CampRun, CampTask, CampVersion, CampWorkerCompatibility } from "../src/components/camp/campApi";

const originalPost = api.post;
const originalGet = api.get;
afterEach(() => { cleanup(); api.post = originalPost; api.get = originalGet; });
const time = "2026-10-23T00:00:00Z";
const base: CampCandidate = { type: "layerfs", projectId: "p-" + "a".repeat(16), refKind: "layer", refId: "32" + "a".repeat(64), rootId: "a".repeat(64), imageId: "sha256:" + "f".repeat(64) };
const candidate = (hex: string): CampCandidate => ({ ...base, refKind: "commit", refId: "12" + hex.repeat(64), rootId: hex.repeat(64), baseRef: base.refId });
const left = candidate("b"), right = candidate("c"), prior = candidate("d");
const pool: CampExecutionPool = { poolId: "10000000-0000-4000-8000-000000000001", storageId: "e".repeat(64), maxParallel: 2, workerIds: ["pool-lane-1", "pool-lane-2"], resources: { maxContainers: 4, cpuMillis: 8000, memoryBytes: 8192 * 1048576, pidsLimit: 1024 } };
function goal(overrides: Partial<CampGoal> = {}): CampGoal {
  const tasks = ["parser", "docs"].map(key => ({ key, title: "Implement " + key, description: "Independent " + key, acceptance: key + " works", verification: "node --test " + key }));
  return { id: "parallel", roomId: "room", title: "Deliver two changes", description: null, workflow: "serial", planMode: "parallel_pair", protocolVersion: 4, status: "running", reason: null, attempt: 1, budget: { maxRuns: 24, maxReviewRounds: 10, maxDurationSeconds: 3600 }, usage: { runs: 3, reviewRounds: 0, elapsedSeconds: 20 }, activeRuns: 2, canRetry: false, canCancel: true, createdAt: time, startedAt: time, completedAt: null, resultReady: false, baseCandidate: base, executionPool: pool, plan: { revision: 1, summary: "Implement independent changes", tasks }, items: tasks.map((task, index) => ({ ...task, index, status: "building", reworkCount: 0, candidate: null, reviews: [], scheduling: { state: "running", reason: null } })), ...overrides };
}
function run(key: string, overrides: Partial<CampRun> = {}): CampRun {
  return { id: "run-" + key, goalId: "parallel", goalAttempt: 1, taskId: "build-" + key, executor: "agent", taskKind: "build", planItemKey: key, role: "builder", workerId: key === "parser" ? pool.workerIds[0]! : pool.workerIds[1]!, epoch: 2, status: "running", leaseValid: true, leaseExpiresAt: "2000-01-01T00:00:00Z", summary: null, error: null, sessionId: null, artifacts: [], cleanupState: "pending", inputCandidate: base, ...overrides };
}
const tasks: CampTask[] = ["parser", "docs"].map(key => ({ id: "build-" + key, goalId: "parallel", goalAttempt: 1, role: "builder", kind: "build", planItemKey: key, title: "Implement " + key, dependsOn: [], executionStatus: "running" }));

test("parallel mode requires the server advertisement and a removed capability keeps the draft without submitting another mode", async () => {
  const writes: CampPlanMode[] = [];
  const onSubmit = async (_text: string, _budget: unknown, mode: CampPlanMode) => { writes.push(mode); return true; };
  const view = renderWithIntl(<CampGoalComposer channelId="parallel" busy={false} supportedPlanModes={["sequential", "same_baseline_pair"]} onSubmit={onSubmit} />);
  assert.equal(screen.queryByRole("option", { name: "Two tasks in parallel on one host" }), null);
  view.rerender(<TestIntlProvider><CampGoalComposer channelId="parallel" busy={false} supportedPlanModes={["sequential", "same_baseline_pair", "parallel_pair"]} onSubmit={onSubmit} /></TestIntlProvider>);
  const selector = screen.getByTestId("camp-plan-mode") as HTMLSelectElement;
  fireEvent.change(selector, { target: { value: "parallel_pair" } });
  const field = screen.getByRole("textbox", { name: "Give the team a goal" }) as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "Keep both changes independent" } });
  view.rerender(<TestIntlProvider><CampGoalComposer channelId="parallel" busy={false} supportedPlanModes={["sequential", "same_baseline_pair"]} onSubmit={onSubmit} /></TestIntlProvider>);
  fireEvent.submit(field.closest("form")!);
  assert.deepEqual(writes, []); assert.equal(selector.value, "parallel_pair"); assert.equal(field.value, "Keep both changes independent");
  assert.ok(screen.getByText(/no longer advertises this plan mode/));
  view.rerender(<TestIntlProvider><CampGoalComposer channelId="parallel" busy={false} supportedPlanModes={["sequential", "parallel_pair"]} onSubmit={onSubmit} /></TestIntlProvider>);
  fireEvent.submit(field.closest("form")!); await waitFor(() => assert.deepEqual(writes, ["parallel_pair"]));
});

test("pool launch is explicit, uses the existing environment files and keeps a once-issued credential through mode changes", async () => {
  let mints = 0;
  api.post = (async () => { mints++; return { data: { token: "camp_worker_once_visible", expiresAt: time } }; }) as typeof api.post;
  const view = renderWithIntl(<CampWorkerConnection roomId="room" expanded supportsParallel />);
  const field = screen.getByTestId("camp-worker-api") as HTMLInputElement;
  fireEvent.change(field, { target: { value: "https://api.example.test" } });
  assert.ok(screen.getByTestId("camp-worker-command-start"));
  assert.equal(screen.queryByTestId("camp-worker-command-poolStart"), null);
  fireEvent.click(screen.getByRole("button", { name: "Issue worker credential" }));
  await waitFor(() => assert.ok(screen.getByDisplayValue("camp_worker_once_visible")));
  const selector = screen.getByTestId("camp-worker-launch-mode");
  fireEvent.change(selector, { target: { value: "pool" } });
  assert.equal(screen.queryByTestId("camp-worker-command-start"), null);
  const command = screen.getByTestId("camp-worker-command-poolStart").textContent ?? "";
  assert.match(command, /--env-file=\.camp\/runtime\.env --env-file=\.camp\/worker\.env/);
  assert.match(command, /packages\/camp-runtime\/scripts\/worker-pool\.mjs/);
  assert.equal(command.includes("camp_worker_once_visible"), false);
  assert.ok(screen.getByText(/Stop the existing worker before starting the pool/));
  view.rerender(<TestIntlProvider><CampWorkerConnection roomId="room" expanded supportsParallel={false} /></TestIntlProvider>);
  assert.equal((selector as HTMLSelectElement).value, "pool");
  assert.equal(screen.queryByTestId("camp-worker-command-poolStart"), null);
  assert.equal(screen.queryByTestId("camp-worker-command-start"), null);
  assert.equal(field.value, "https://api.example.test"); assert.ok(screen.getByDisplayValue("camp_worker_once_visible")); assert.equal(mints, 1);
});

test("one logical builder card exposes both independent runs and each stop action addresses its actual run", async () => {
  const calls: string[] = [];
  api.post = (async (path: string) => { calls.push(path); return { data: {} }; }) as typeof api.post;
  renderWithIntl(<>{(["planner", "builder", "reviewer"] as const).map(role => <CampRoleCard key={role} role={role} runs={[run("docs"), run("parser")]} goals={[goal()]} canCancel busy={false} onCancel={id => campApi.cancel("room", id)} />)}</>);
  const builder = within(screen.getByTestId("camp-role-builder"));
  assert.equal(builder.getAllByTestId("camp-run-execution").length, 2);
  assert.ok(builder.getByText("Lane 1")); assert.ok(builder.getByText("Lane 2"));
  assert.ok(builder.getByText("Implement parser")); assert.ok(builder.getByText("Implement docs"));
  assert.equal(within(screen.getByTestId("camp-role-reviewer")).queryByTestId("camp-run-execution"), null);
  const second = document.querySelector('[data-testid="camp-role-builder"] [data-run-id="run-docs"]') as HTMLElement;
  fireEvent.click(within(second).getByRole("button", { name: "Stop entire goal" }));
  await waitFor(() => assert.deepEqual(calls, ["/camp/rooms/room/runs/run-docs/cancel"]));
  assert.ok(within(second).getByText(/cleanup of both lanes/));
});

test("lease presentation uses server facts even when timestamps disagree and old servers remain unconfirmed", () => {
  const view = renderWithIntl(<CampRoleCard role="builder" runs={[run("parser")]} canCancel={false} busy={false} onCancel={async () => {}} />);
  assert.equal(screen.queryByText("Heartbeat expired; awaiting recovery"), null);
  assert.ok(screen.getByText("Working"));
  view.rerender(<TestIntlProvider><CampRoleCard role="builder" runs={[run("parser", { leaseValid: false, leaseExpiresAt: "2100-01-01T00:00:00Z" })]} canCancel={false} busy={false} onCancel={async () => {}} /></TestIntlProvider>);
  assert.ok(screen.getByText("Heartbeat expired; awaiting recovery"));
  assert.ok(screen.getByText(/physical stop and cleanup still require/));
  view.rerender(<TestIntlProvider><CampRoleCard role="builder" runs={[run("parser", { leaseValid: undefined })]} canCancel={false} busy={false} onCancel={async () => {}} /></TestIntlProvider>);
  assert.ok(screen.getByText(/has not confirmed the run’s lease state/));
  assert.equal(screen.queryByText("Heartbeat expired; awaiting recovery"), null);
});

test("one item can wait for a human while the other executes without swapping approved or rework candidates", () => {
  const state = goal();
  state.items![0] = { ...state.items![0]!, status: "reviewing", candidate: left, reworkCount: 1, scheduling: { state: "waiting_question", reason: "question_pending" }, reviews: [{ runId: "prior-review", outcome: "changes_requested", summary: "Parser needs an empty-input fix", evidence: "Empty-input check failed", candidate: prior, createdAt: time }] };
  state.items![1] = { ...state.items![1]!, candidate: right };
  const suspended = run("parser", { status: "suspended", leaseValid: false, candidate: left, cleanupState: "confirmed" });
  renderWithIntl(<CampGoalCard goal={state} tasks={[{ ...tasks[0]!, executionStatus: "waiting_question" }, tasks[1]!]} runs={[run("docs"), suspended]} busy={false} onRetry={async () => {}} onCancel={async () => {}} />);
  const parser = within(screen.getByTestId("camp-plan-item-parser")), docs = within(screen.getByTestId("camp-plan-item-docs"));
  assert.ok(parser.getByText(/other item can continue/)); assert.ok(parser.getByText("Parser needs an empty-input fix"));
  assert.ok(parser.getAllByText(left.refId).length > 0); assert.ok(parser.getAllByText(prior.refId).length > 0); assert.equal(parser.queryByText(right.refId), null);
  assert.ok(docs.getAllByText(right.refId).length > 0); assert.ok(docs.getByTestId("camp-run-execution"));
  assert.equal(docs.queryByText(left.refId), null); assert.equal(screen.queryByText("Starts after earlier tasks are approved."), null);
  assert.equal(screen.queryByRole("button", { name: "Download result manifest" }), null);
});

test("a build and one review can coexist, while the next completed candidate waits for that reviewer", () => {
  const review = run("parser", { id: "review-parser", taskId: "review-parser", role: "reviewer", taskKind: "review", inputCandidate: left });
  const work = goal();
  const draw = (runs: CampRun[]) => <>{(["builder", "reviewer"] as const).map(role => <CampRoleCard key={role} role={role} runs={runs} goals={[work]} canCancel={false} busy={false} onCancel={async () => {}} />)}<CampGoalCard goal={work} tasks={tasks} runs={runs} busy={false} onRetry={async () => {}} onCancel={async () => {}} /></>;
  const view = renderWithIntl(draw([review, run("docs")]));
  assert.equal(within(screen.getByTestId("camp-role-builder")).getAllByTestId("camp-run-execution").length, 1);
  assert.equal(within(screen.getByTestId("camp-role-reviewer")).getAllByTestId("camp-run-execution").length, 1);
  work.items![1] = { ...work.items![1]!, candidate: right, status: "reviewing", scheduling: { state: "waiting_review", reason: "reviewer_queue" } };
  view.rerender(<TestIntlProvider>{draw([review, run("docs", { status: "completed", candidate: right, cleanupState: "confirmed" })])}</TestIntlProvider>);
  const docs = within(screen.getByTestId("camp-plan-item-docs"));
  assert.ok(docs.getByText("Waiting for the serial reviewer"));
  assert.ok(docs.getByText("The reviewer handles one candidate at a time."));
  assert.equal(within(screen.getByTestId("camp-role-reviewer")).getAllByTestId("camp-run-execution").length, 1);
  assert.equal(screen.queryByTestId("camp-integration-receipt"), null);
});

test("cancellation keeps both run cleanup facts visible and never interprets a fenced run as physically removed", () => {
  const state = goal({ status: "cancelled", reason: "cancelled_by_human", activeRuns: 0, canCancel: false, canRetry: false, verification: { required: true, policyDigest: null, status: "not_run", repairsUsed: 0, maxRepairAttempts: 1, operations: [] } });
  renderWithIntl(<CampGoalCard goal={state} tasks={tasks} runs={[run("parser", { status: "cancelled", leaseValid: false, cancelRequestedAt: time, cleanupState: "confirmed" }), run("docs", { status: "cancelled", leaseValid: false, cancelRequestedAt: time, cleanupState: "unknown" })]} busy={false} onRetry={async () => { assert.fail("Cleanup is unconfirmed"); }} onCancel={async () => {}} />);
  const cleanupView = within(screen.getByTestId("camp-parallel-cleanup"));
  assert.equal(cleanupView.getAllByTestId("camp-run-execution").length, 2);
  assert.ok(cleanupView.getByText("Sandbox cleanup confirmed."));
  assert.ok(cleanupView.getByText("This attempt can no longer submit results. Its sandbox cleanup has not been confirmed."));
  assert.equal(screen.queryByRole("button", { name: "Retry goal" }), null);
  assert.ok(screen.getByText("No checks allocated"));
});

test("the pool card shows frozen whole-pool limits rather than utilization and does not appear on old modes", () => {
  const renderCard = (value: CampGoal) => <CampGoalCard goal={value} tasks={[]} runs={[]} busy={false} onRetry={async () => {}} onCancel={async () => {}} />;
  const view = renderWithIntl(renderCard(goal()));
  const region = within(screen.getByTestId("camp-execution-pool"));
  assert.ok(region.getByText("8 CPU")); assert.ok(region.getByText("8,192 MiB")); assert.ok(region.getByText("4 containers (2 main + 2 auxiliary)"));
  assert.ok(region.getByText(/not remote attestation or live resource utilization/));
  assert.equal(region.getAllByTestId("camp-pool-lane").length, 2);
  view.rerender(<TestIntlProvider>{renderCard(goal({ executionPool: null, status: "queued", activeRuns: 0 }))}</TestIntlProvider>);
  assert.ok(screen.getByText(/No pool has been assigned yet/));
  for (const planMode of ["sequential", "same_baseline_pair"] as const) {
    view.rerender(<TestIntlProvider>{renderCard(goal({ planMode, protocolVersion: planMode === "sequential" ? 2 : 3, executionPool: undefined }))}</TestIntlProvider>);
    assert.equal(screen.queryByTestId("camp-execution-pool"), null);
    assert.equal(screen.getByTestId("camp-goal-plan-mode").textContent, planMode === "sequential" ? "Build each task in order" : "Two candidates from one baseline");
  }
});

test("independent producers refresh open version history while the global baseline stays fixed and an explicit selection is preserved", async () => {
  const baseline: CampVersion = { id: "baseline", runId: null, kind: "baseline", candidate: base, taskKind: null, planItemKey: null, goalAttempt: 1, createdAt: time, status: "completed", changeSetAvailable: false };
  const producer = (id: string, key: string, candidate: CampCandidate): CampVersion => ({ ...baseline, id, runId: id, kind: "run", candidate, taskKind: "build", planItemKey: key, changeSetAvailable: true });
  let versions = [baseline], reads = 0;
  api.get = (async (path: string) => {
    if (path.endsWith("/versions")) { reads++; return { data: { versions, reason: null } }; }
    if (path.endsWith("/verification")) return { data: { status: "unavailable", operationId: null, receipt: null } };
    return { data: { available: false, reason: "checkpoint_unavailable", runId: "left-run", candidate: left, changeSet: null } };
  }) as typeof api.get;
  const initial = goal({ currentCandidate: base });
  const view = renderWithIntl(<CampGoalVersions goal={initial} />);
  const details = screen.getByTestId("camp-versions-parallel") as HTMLDetailsElement;
  await act(async () => { details.open = true; fireEvent(details, new details.ownerDocument.defaultView!.Event("toggle")); });
  await waitFor(() => assert.equal(reads, 1));
  versions = [baseline, producer("left-run", "parser", left)];
  const first = { ...initial, items: initial.items!.map((item, index) => index === 0 ? { ...item, status: "reviewing" as const, candidate: left } : item) };
  view.rerender(<TestIntlProvider><CampGoalVersions goal={first} /></TestIntlProvider>);
  await waitFor(() => assert.equal(reads, 2));
  await waitFor(() => assert.ok(screen.getByRole("option", { name: /parser/ })));
  fireEvent.change(screen.getByTestId("camp-version-select"), { target: { value: "baseline" } });
  versions = [...versions, producer("right-run", "docs", right)];
  const second = { ...first, items: first.items!.map((item, index) => index === 1 ? { ...item, status: "reviewing" as const, candidate: right } : item) };
  view.rerender(<TestIntlProvider><CampGoalVersions goal={second} /></TestIntlProvider>);
  await waitFor(() => assert.equal(reads, 3));
  await waitFor(() => assert.ok(screen.getByRole("option", { name: /docs/ })));
  assert.equal((screen.getByTestId("camp-version-select") as HTMLSelectElement).value, "baseline");
});

for (const status of ["cancelled", "needs_attention"] as const) test(`a ${status} goal without an integration operation does not promise to wait for or start integration`, () => {
  const draw = (value: CampGoal) => <CampGoalCard goal={value} tasks={[]} runs={[]} busy={false} onRetry={async () => {}} onCancel={async () => {}} />;
  const view = renderWithIntl(draw(goal({ integration: { required: true, status: "pending", operations: [] } })));
  assert.ok(within(screen.getByTestId("camp-goal-integration")).getByText("Waiting for both reviewed candidates"));
  view.rerender(<TestIntlProvider>{draw(goal({ status, canCancel: false, integration: { required: true, status: "not_run", operations: [] } }))}</TestIntlProvider>);
  const integration = within(screen.getByTestId("camp-goal-integration"));
  assert.ok(integration.getByText("No integration allocated"));
  assert.ok(integration.getByText("No trusted integration operation was allocated for this goal attempt."));
  assert.equal(integration.queryByText("Waiting for both reviewed candidates"), null);
  assert.equal(integration.queryByText("Integration starts after both tasks have approved candidates."), null);
});

for (const code of ["pool_required", "pool_mismatch", "storage_mismatch", "lane_not_registered"] as const) test(`${code} explains storage or pool correction without recommending a plugin upgrade`, () => {
  const compatibility: CampWorkerCompatibility = { status: "incompatible", code, protocolVersion: 4, missingTaskKinds: [], missingRefKinds: [], missingCapabilities: [], missingHarnesses: [] };
  renderWithIntl(<CampWorkerDiagnostics workers={[{ workerId: "foreign-worker", declaration: { protocolVersions: [1, 2, 3, 4], workerVersion: "0.6.0", taskKinds: ["build"], refKinds: ["layer", "commit"], capabilities: [], executionPool: pool }, compatibility, requirements: null, lastSeenAt: time, lastClaimAt: null, lastRunId: null }]} />);
  assert.ok(screen.getByText(/Use the original pool manager, storage and lane identities/));
  assert.equal(screen.queryByText(/Upgrade the worker/), null);
  assert.ok(screen.getByText(pool.poolId)); assert.ok(screen.getByText(pool.storageId));
});
