import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithIntl, TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import CampGoalComposer from "../src/components/camp/CampGoalComposer";
import CampGoalCard from "../src/components/camp/CampGoalCard";
import CampGoalIntegration from "../src/components/camp/CampGoalIntegration";
import CampGoalVerificationView from "../src/components/camp/CampGoalVerification";
import CampGoalVersions from "../src/components/camp/CampGoalVersions";
import { CampRoleCard, CampRunResults } from "../src/components/camp/CampRunViews";
import { campApi } from "../src/components/camp/campApi";
import type { CampCandidate, CampGoal, CampGoalVerification, CampIntegrationOperation, CampIntegrationReceipt, CampPlanMode, CampRun, CampVersion } from "../src/components/camp/campApi";
import { parseCandidate, parseIntegrationInput, parseIntegrationReport, serializeIntegrationInput } from "../../camp-protocol/src/index.js";

const originalGet = api.get, originalPost = api.post;
afterEach(() => { cleanup(); api.get = originalGet; api.post = originalPost; });
const time = "2026-10-23T00:00:00Z", imageId = `sha256:${"f".repeat(64)}`;
const base = parseCandidate({ type: "layerfs", projectId: `p-${"a".repeat(16)}`, refKind: "layer", refId: `32${"a".repeat(64)}`, rootId: "a".repeat(64), imageId });
function candidate(hex: string): CampCandidate { return parseCandidate({ ...base, layerId: undefined, refKind: "commit", refId: `12${hex.repeat(64)}`, rootId: hex.repeat(64), baseRef: base.refId }); }
const left = candidate("b"), right = candidate("c"), combined = candidate("d"), repaired = candidate("e");
const input = parseIntegrationInput({ schemaVersion: 1, algorithm: "layerfs-three-way-v1", policy: "reject-overlap-v1", base, parents: [
  { key: "parser", runId: "10000000-0000-4000-8000-000000000001", epoch: 1, candidate: left },
  { key: "docs", runId: "10000000-0000-4000-8000-000000000002", epoch: 2, candidate: right },
] });
const inputDigest = createHash("sha256").update(serializeIntegrationInput(input)).digest("hex");
function receipt(overrides: Partial<CampIntegrationReceipt> = {}): CampIntegrationReceipt {
  const report = parseIntegrationReport({ schemaVersion: 1, inputDigest, algorithm: input.algorithm, policy: input.policy, status: "merged", candidate: combined, conflicts: [], truncated: false });
  return { ...report, operationId: "20000000-0000-4000-8000-000000000001", runId: "30000000-0000-4000-8000-000000000001", integratedAt: time, ...overrides };
}
function operation(overrides: Partial<CampIntegrationOperation> = {}): CampIntegrationOperation {
  const recorded = receipt();
  return { id: recorded.operationId, goalId: "pair", goalAttempt: 1, kind: "integration", status: "completed", attempt: 1, infrastructureFailures: 0, createdAt: time, latestRunId: recorded.runId, integrationInput: input, inputDigest, integrationReport: recorded, ...overrides };
}
function goal(overrides: Partial<CampGoal> = {}): CampGoal {
  const tasks = input.parents.map(parent => ({ key: parent.key, title: `Implement ${parent.key}`, description: `Change ${parent.key} independently`, acceptance: `${parent.key} accepted`, verification: `node --test ${parent.key}.test.mjs` }));
  return { id: "pair", roomId: "room", title: "Deliver parser and documentation", description: null, workflow: "serial", planMode: "same_baseline_pair", protocolVersion: 3, status: "running", reason: null, attempt: 1, budget: { maxRuns: 24, maxReviewRounds: 10, maxDurationSeconds: 3600 }, usage: { runs: 6, reviewRounds: 2, elapsedSeconds: 42 }, activeRuns: 0, canRetry: false, canCancel: true, createdAt: time, startedAt: time, completedAt: null, baseCandidate: base, currentCandidate: combined, finalCandidate: null, resultReady: false,
    plan: { revision: 1, summary: "Two independent changes from the same source", tasks }, items: tasks.map((task, index) => ({ ...task, index, status: "approved", reworkCount: 0, candidate: input.parents[index]!.candidate, reviews: [] })), integration: { required: true, status: "merged", operations: [operation()] }, ...overrides };
}

test("a server without an explicit mode declaration only offers the existing sequential submission", async () => {
  const submitted: CampPlanMode[] = [];
  renderWithIntl(<CampGoalComposer channelId="old" busy={false} onSubmit={async (_description, _budget, mode) => { submitted.push(mode); return true; }} />);
  assert.equal(screen.queryByTestId("camp-plan-mode"), null);
  const field = screen.getByRole("textbox", { name: "Give the team a goal" });
  fireEvent.change(field, { target: { value: "Existing server goal" } }); fireEvent.submit(field.closest("form")!);
  await waitFor(() => assert.deepEqual(submitted, ["sequential"]));
});

test("pair mode is explicit and losing server support preserves the draft instead of silently switching plans", async () => {
  const submitted: CampPlanMode[] = [];
  const onSubmit = async (_description: string, _budget: unknown, mode: CampPlanMode) => { submitted.push(mode); return true; };
  const view = renderWithIntl(<CampGoalComposer channelId="pair" busy={false} supportedPlanModes={["sequential", "same_baseline_pair"]} onSubmit={onSubmit} />);
  const selector = screen.getByTestId("camp-plan-mode") as HTMLSelectElement;
  assert.equal(selector.value, "sequential");
  fireEvent.change(selector, { target: { value: "same_baseline_pair" } });
  assert.ok(screen.getByText(/Plan exactly two tasks/));
  const field = screen.getByRole("textbox", { name: "Give the team a goal" }) as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "Preserve both changes" } });
  view.rerender(<TestIntlProvider><CampGoalComposer channelId="pair" busy={false} supportedPlanModes={["sequential"]} onSubmit={onSubmit} /></TestIntlProvider>);
  fireEvent.submit(field.closest("form")!); assert.deepEqual(submitted, []); assert.equal(field.value, "Preserve both changes");
  assert.equal(selector.value, "same_baseline_pair"); assert.ok(screen.getByText(/no longer advertises this plan mode/));
  fireEvent.change(selector, { target: { value: "sequential" } }); fireEvent.submit(field.closest("form")!);
  await waitFor(() => assert.deepEqual(submitted, ["sequential"]));
});

test("the submit request sends pair intent while leaving old sequential request bodies unchanged", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  api.post = (async (_path: string, body: Record<string, unknown>) => { bodies.push(body); return { data: {} }; }) as typeof api.post;
  await campApi.submit("room", "Sequential", "Existing default");
  await campApi.submit("room", "Pair", "Both outputs", undefined, "previous-goal", "same_baseline_pair");
  assert.equal("planMode" in bodies[0]!, false);
  assert.equal(bodies[1]!.planMode, "same_baseline_pair"); assert.equal(bodies[1]!.fromGoalId, "previous-goal");
});

test("both item cards show the common baseline and a merged receipt never unlocks delivery before final gates", () => {
  renderWithIntl(<CampGoalCard goal={goal()} tasks={[]} runs={[]} busy={false} onRetry={async () => {}} onCancel={async () => {}} canContinue />);
  for (const key of ["parser", "docs"]) {
    const item = within(screen.getByTestId(`camp-plan-item-${key}`));
    assert.ok(item.getByText(base.refId)); assert.ok(item.getByText(/independently of the other task/));
  }
  const section = screen.getByTestId("camp-goal-integration");
  assert.equal(within(section).getAllByTestId("camp-integration-parent").length, 2);
  assert.ok(within(section).getByText(left.refId)); assert.ok(within(section).getByText(right.refId));
  assert.ok(within(section).getByText(combined.refId)); assert.ok(within(section).getByText(inputDigest));
  assert.equal(screen.queryByRole("button", { name: "Download result manifest" }), null);
  assert.equal(screen.queryByRole("button", { name: "Continue from this result" }), null);
});

test("conflicts and truncated evidence stay inert and recovery only exposes server-authorized actions", async () => {
  const raw = parseIntegrationReport({ schemaVersion: 1, inputDigest, algorithm: input.algorithm, policy: input.policy, status: "conflict", candidate: null, conflicts: [{ path: "<img onerror=alert(1)>.mjs", reason: "overlap" }, { path: "unicode\u202e.mjs", reason: "structural" }], truncated: true });
  const recorded = { ...receipt(), ...raw }; let retried = 0;
  const failed = goal({ status: "needs_attention", canCancel: false, canRetry: true, integration: { required: true, status: "conflict", operations: [operation({ integrationReport: recorded })] } });
  const view = renderWithIntl(<CampGoalCard goal={failed} tasks={[]} runs={[]} busy={false} onRetry={async () => { retried++; }} onCancel={async () => {}} />);
  assert.ok(screen.getByText("<img onerror=alert(1)>.mjs")); assert.ok(screen.getByText("unicode\\u202e.mjs"));
  assert.ok(screen.getByText(/list is incomplete/)); assert.equal(document.querySelector('[data-testid="camp-goal-integration"] img'), null);
  assert.equal(screen.queryByTestId("camp-integration-result"), null);
  fireEvent.click(screen.getByRole("button", { name: "Retry goal" })); await waitFor(() => assert.equal(retried, 1));
  assert.ok(screen.getByText(/rebuilds both tasks from the frozen baseline/));
  view.rerender(<TestIntlProvider><CampGoalCard goal={{ ...failed, canRetry: false }} tasks={[]} runs={[]} busy={false} onRetry={async () => { retried++; }} onCancel={async () => {}} /></TestIntlProvider>);
  assert.equal(screen.queryByRole("button", { name: "Retry goal" }), null);
});

for (const mismatch of [{ inputDigest: "0".repeat(64) }, { operationId: "20000000-0000-4000-8000-000000000009" }, { runId: "30000000-0000-4000-8000-000000000009" }, { candidate: { ...combined, imageId: `sha256:${"0".repeat(64)}` } }]) test(`a receipt with mismatched ${Object.keys(mismatch)[0]} cannot confirm an integration result`, () => {
  renderWithIntl(<CampGoalIntegration goal={goal({ integration: { required: true, status: "merged", operations: [operation({ integrationReport: receipt(mismatch) })] } })} />);
  assert.ok(screen.getByRole("alert")); assert.equal(screen.queryByTestId("camp-integration-result"), null);
  assert.equal(screen.getByTestId("camp-integration-operation").getAttribute("data-status"), "unknown");
});

test("a blocked or unknown operation retains its exact inputs without inventing a result", () => {
  renderWithIntl(<CampGoalIntegration goal={goal({ integration: { required: true, status: "blocked", operations: [operation({ status: "blocked", integrationReport: null })] } })} />);
  assert.ok(screen.getByText(/No integration result is confirmed/));
  assert.equal(screen.getAllByTestId("camp-integration-parent").length, 2);
  assert.equal(screen.queryByTestId("camp-integration-receipt"), null);
});

test("an unknown native result cannot offer a goal retry or imply that ordinary recovery is available", () => {
  const uncertain = goal({ status: "needs_attention", reason: "integration_inspection_required", canRetry: false, canCancel: false, integration: { required: true, status: "failed", operations: [operation({ status: "failed", integrationReport: null })] } });
  const view = renderWithIntl(<CampGoalCard goal={uncertain} tasks={[]} runs={[]} busy={false} onRetry={async () => { assert.fail("Unknown native state cannot retry"); }} onCancel={async () => {}} />);
  assert.equal(screen.queryByRole("button", { name: "Retry goal" }), null);
  assert.ok(screen.getByText(/An operator must inspect its recorded state/));
  assert.ok(screen.getByText(/no action to confirm that inspection and resume this goal/));
  assert.equal(screen.queryByText("A server administrator can inspect this goal and start a recovery round."), null);
  view.rerender(<TestIntlProvider><CampGoalCard goal={{ ...uncertain, reason: "integration_conflict", canRetry: true }} tasks={[]} runs={[]} busy={false} onRetry={async () => {}} onCancel={async () => {}} /></TestIntlProvider>);
  assert.ok(screen.getByRole("button", { name: "Retry goal" }));
});

test("a cancelled goal keeps its business status while a latched integration inspection still requires operator attention", () => {
  renderWithIntl(<CampGoalCard goal={goal({ status: "cancelled", reason: "cancelled_by_human", integrationInspectionRequired: true, canRetry: false, canCancel: false, integration: { required: true, status: "cancelled", operations: [operation({ status: "cancelled", integrationReport: null })] }, verification: { required: true, policyDigest: "f".repeat(64), status: "not_run", repairsUsed: 0, maxRepairAttempts: 0, operations: [] } })} tasks={[]} runs={[]} busy={false} onRetry={async () => { assert.fail("Cancellation cannot clear the inspection latch"); }} onCancel={async () => {}} />);
  assert.ok(screen.getByText("Cancelled"));
  assert.ok(screen.getByText("A person stopped this goal."));
  assert.ok(screen.getByText(/no action to confirm that inspection and resume this goal/));
  assert.equal(screen.queryByRole("button", { name: "Retry goal" }), null);
  assert.equal(screen.queryByText("A server administrator can inspect this goal and start a recovery round."), null);
  assert.equal(screen.queryByRole("button", { name: "Download result manifest" }), null);
  const verification = within(screen.getByTestId("camp-goal-verification"));
  assert.equal(verification.getByRole("status").textContent, "No checks allocated");
  assert.ok(verification.getByText("No trusted verification operation was allocated for this goal attempt."));
  assert.equal(verification.queryByText("Waiting to run checks"), null);
  assert.equal(verification.queryByTestId("camp-verification-operation"), null);
  assert.equal(verification.queryByText(/inspect the matching candidate's command output/), null);
});

test("verification keeps an active pending allocation and preserves a recorded operation after the goal stops", () => {
  const verification: CampGoalVerification = { required: true, policyDigest: "f".repeat(64), status: "pending", repairsUsed: 0, maxRepairAttempts: 0, operations: [] };
  const view = renderWithIntl(<CampGoalVerificationView goal={goal({ verification })} />);
  assert.equal(screen.getByRole("status").textContent, "Waiting to run checks");
  assert.equal(screen.queryByText("No checks allocated"), null);
  const stopped = goal({ status: "cancelled", verification: { ...verification, status: "failed", operations: [{ id: "verification", goalId: "pair", goalAttempt: 1, kind: "verification", inputCandidate: combined, policyDigest: verification.policyDigest!, status: "failed", attempt: 1, infrastructureFailures: 0, createdAt: time, latestRunId: "verification-run", receipt: null }] } });
  view.rerender(<TestIntlProvider><CampGoalVerificationView goal={stopped} /></TestIntlProvider>);
  assert.equal(screen.getByRole("status").textContent, "Checks failed");
  assert.ok(screen.getByTestId("camp-verification-operation").textContent?.includes("Checks failed"));
  assert.equal(screen.queryByText("No checks allocated"), null);
  assert.equal(screen.queryByText("Waiting to run checks"), null);
});

test("later whole-goal repairs keep the original integration receipt and deliver the actual repaired candidate", () => {
  renderWithIntl(<CampGoalCard goal={goal({ status: "completed", resultReady: true, currentCandidate: repaired, finalCandidate: repaired, canCancel: false })} tasks={[]} runs={[]} busy={false} onRetry={async () => {}} onCancel={async () => {}} />);
  assert.equal(screen.getByTestId("camp-integration-receipt").getAttribute("data-candidate-ref"), combined.refId);
  assert.ok(screen.getByText(repaired.refId)); assert.ok(screen.getByRole("button", { name: "Download result manifest" }));
});

test("a new goal attempt shows its own operation and keeps earlier conflict evidence in a separate history", () => {
  const oldReport = parseIntegrationReport({ schemaVersion: 1, inputDigest, algorithm: input.algorithm, policy: input.policy, status: "conflict", candidate: null, conflicts: [{ path: "previous-conflict.mjs", reason: "overlap" }], truncated: false });
  const previous = operation({ integrationReport: { ...receipt(), ...oldReport } });
  const current = operation({ id: "20000000-0000-4000-8000-000000000002", goalAttempt: 2, status: "running", integrationReport: null });
  renderWithIntl(<CampGoalCard goal={goal({ attempt: 2, integration: { required: true, status: "running", operations: [current] } })} integrationHistory={[previous]} tasks={[]} runs={[]} busy={false} onRetry={async () => {}} onCancel={async () => {}} />);
  const section = screen.getByTestId("camp-goal-integration"), history = screen.getByTestId("camp-integration-history") as HTMLDetailsElement;
  assert.equal(history.open, false); assert.ok(within(history).getByText("previous-conflict.mjs"));
  assert.equal(within(history).getByTestId("camp-integration-operation").getAttribute("data-operation-id"), previous.id);
  assert.equal(section.querySelector('[data-status="running"][data-testid="camp-integration-operation"]')?.getAttribute("data-operation-id"), current.id);
});

test("integration executes as a system operation and never occupies any of the three agent cards", () => {
  const run: CampRun = { id: receipt().runId, goalId: "pair", taskId: null, role: null, executor: "integration", operationId: operation().id, epoch: 1, status: "running", summary: "Trusted combination", error: null, sessionId: null, artifacts: [{ type: "integration", summary: "Two exact parents retained" }] };
  renderWithIntl(<><CampRoleCard role="builder" runs={[run]} canCancel busy={false} onCancel={async () => {}} /><CampRunResults runs={[run]} /></>);
  assert.ok(screen.getByText("Ready for work")); assert.ok(screen.getByText(/System integration · Attempt/));
  assert.equal(screen.queryByText(/System verification/), null); assert.equal(screen.queryByRole("button", { name: "Stop run" }), null);
});

test("integration versions use the producing run API and ignore a late parent diff when selection changes", async () => {
  const versions: CampVersion[] = [
    { id: "baseline", runId: null, kind: "baseline", candidate: base, taskKind: null, planItemKey: null, goalAttempt: 1, createdAt: time, status: "completed", changeSetAvailable: false },
    { id: "left", runId: "left", kind: "run", candidate: left, taskKind: "build", planItemKey: "parser", goalAttempt: 1, createdAt: time, status: "completed", changeSetAvailable: true },
    { id: "integrated", runId: receipt().runId, kind: "integration", candidate: combined, taskKind: "integration", operationId: operation().id, planItemKey: null, goalAttempt: 1, createdAt: time, status: "completed", changeSetAvailable: true },
  ];
  let releaseOld!: (value: unknown) => void, oldSignal: AbortSignal | undefined; const paths: string[] = [];
  const changes = (target: CampCandidate) => ({ available: true, candidate: target, changeSet: { schemaVersion: 1, base, target, entries: [], truncated: false, stats: { added: 0, modified: 0, deleted: 0, typeChanged: 0 } } });
  api.get = (async (path: string, config?: { signal?: AbortSignal }) => {
    paths.push(path);
    if (path.endsWith("/versions")) return { data: { versions, reason: null } };
    if (path.includes("/left/changes")) { oldSignal = config?.signal; return new Promise(resolve => { releaseOld = resolve; }); }
    if (path.endsWith("/changes")) return { data: changes(combined) };
    return { data: { status: "pending", operationId: null, receipt: null } };
  }) as typeof api.get;
  renderWithIntl(<CampGoalVersions goal={goal({ currentCandidate: left })} />);
  const details = screen.getByTestId("camp-versions-pair") as HTMLDetailsElement;
  await act(async () => { details.open = true; fireEvent(details, new details.ownerDocument.defaultView!.Event("toggle")); });
  await waitFor(() => assert.ok(oldSignal));
  fireEvent.change(screen.getByTestId("camp-version-select"), { target: { value: "integrated" } });
  await waitFor(() => assert.ok(screen.getByTestId("camp-change-set")));
  assert.equal(oldSignal?.aborted, true);
  assert.ok(paths.some(path => path.endsWith(`/${receipt().runId}/changes`)));
  assert.ok(screen.getByRole("option", { name: /Integration result/ }));
  await act(async () => releaseOld({ data: changes(left) }));
  assert.equal((screen.getByTestId("camp-version-select") as HTMLSelectElement).value, "integrated");
  assert.ok(within(screen.getByTestId("camp-change-set")).getByText(combined.refId));
  assert.equal(within(screen.getByTestId("camp-change-set")).queryByText(left.refId), null);
});

test("historical goals missing planMode keep their sequential view", () => {
  renderWithIntl(<CampGoalCard goal={goal({ planMode: undefined, protocolVersion: 2, integration: undefined })} tasks={[]} runs={[]} busy={false} onRetry={async () => {}} onCancel={async () => {}} />);
  assert.ok(screen.getByText("Build each task in order")); assert.equal(screen.queryByTestId("camp-goal-integration"), null);
});
