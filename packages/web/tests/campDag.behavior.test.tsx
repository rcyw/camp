import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithIntl, TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import CampGoalCard from "../src/components/camp/CampGoalCard";
import CampGoalComposer from "../src/components/camp/CampGoalComposer";
import CampGoalVersions from "../src/components/camp/CampGoalVersions";
import { CampRoleCard } from "../src/components/camp/CampRunViews";
import { campApi } from "../src/components/camp/campApi";
import type { CampCandidate, CampExecutionPool, CampGoal, CampIntegrationOperation, CampPlanMode, CampRun, CampTask, CampVersion } from "../src/components/camp/campApi";
import { parseCandidate, serializeIntegrationInput } from "../../camp-protocol/src/index.js";

const originalGet = api.get, originalPost = api.post;
afterEach(() => { cleanup(); api.get = originalGet; api.post = originalPost; });
const now = "2026-10-23T00:00:00Z", imageId = "sha256:" + "f".repeat(64);
const base = parseCandidate({ type: "layerfs", projectId: "p-" + "a".repeat(16), refKind: "layer", refId: "32" + "a".repeat(64), rootId: "a".repeat(64), imageId });
const candidate = (hex: string, parent = base): CampCandidate => parseCandidate({ ...base, layerId: undefined, refKind: "commit", refId: "12" + hex.repeat(64), rootId: hex.repeat(64), baseRef: parent.refId });
const foundation = candidate("b"), left = candidate("c", foundation), right = candidate("d", foundation), integrated = candidate("e", foundation), final = candidate("0", integrated), repaired = candidate("1", final);
const pool: CampExecutionPool = { poolId: "10000000-0000-4000-8000-000000000001", storageId: "a".repeat(64), maxParallel: 2, workerIds: ["dag.lane-1", "dag.lane-2"], resources: { maxContainers: 4, cpuMillis: 8000, memoryBytes: 8589934592, pidsLimit: 1024 } };
const definitions = [
  { key: "foundation", title: "Create shared foundation", dependsOnKeys: [] },
  { key: "left", title: "Implement left feature", dependsOnKeys: ["foundation"] },
  { key: "right", title: "Implement right feature", dependsOnKeys: ["foundation"] },
  { key: "delivery", title: "Finish combined behavior", dependsOnKeys: ["left", "right"] },
].map(item => ({ ...item, description: "Deliver " + item.key, acceptance: item.key + " is accepted", verification: "node --test " + item.key }));
function goal(overrides: Partial<CampGoal> = {}): CampGoal {
  return { id: "dag", roomId: "room", title: "Deliver dependent changes", description: null, workflow: "serial", planMode: "bounded_dag", protocolVersion: 5, status: "running", reason: null, attempt: 1, budget: { maxRuns: 30, maxReviewRounds: 15, maxDurationSeconds: 3600 }, usage: { runs: 5, reviewRounds: 1, elapsedSeconds: 20 }, activeRuns: 2, canRetry: false, canCancel: true, createdAt: now, startedAt: now, completedAt: null, resultReady: false, baseCandidate: base, currentCandidate: base, executionPool: pool,
    plan: { revision: 2, summary: "Build the foundation, two features, then their consumer", tasks: definitions },
    items: definitions.map((item, index) => ({ ...item, index, status: index === 0 ? "approved" : "pending", reworkCount: 0, candidate: index === 0 ? foundation : null, reviews: [], inputSources: [], inputCandidate: index === 0 ? base : null, inputResolution: index === 0 ? "baseline" : null, scopedIntegrationOperationId: null, scheduling: { state: index === 0 ? "approved" : "waiting_dependencies", reason: null, blockedByKeys: item.dependsOnKeys } })),
    integration: { required: true, status: "pending", operations: [] }, graph: { schemaVersion: 1, sinkKeys: ["delivery"], delivery: { status: "waiting_nodes", candidate: null, sourceRunId: null, operationId: null } }, ...overrides };
}
function source(key: string, value: CampCandidate) { return { key, runId: key === "left" ? "20000000-0000-4000-8000-000000000001" : "20000000-0000-4000-8000-000000000002", epoch: 1, candidate: value }; }
function operation(overrides: Partial<CampIntegrationOperation> = {}): CampIntegrationOperation {
  const integrationInput = { schemaVersion: 1 as const, algorithm: "layerfs-three-way-v2" as const, policy: "reject-overlap-v1" as const, base: foundation, parents: [source("left", left), source("right", right)] as [ReturnType<typeof source>, ReturnType<typeof source>] };
  const inputDigest = createHash("sha256").update(serializeIntegrationInput(integrationInput)).digest("hex");
  return { id: "node-integration", goalId: "dag", goalAttempt: 1, kind: "integration", scope: "node_input", planItemKey: "delivery", status: "completed", attempt: 1, infrastructureFailures: 0, createdAt: now, latestRunId: "run-integration", integrationInput, inputDigest, integrationReport: { schemaVersion: 1, inputDigest, algorithm: integrationInput.algorithm, policy: integrationInput.policy, status: "merged", candidate: integrated, conflicts: [], truncated: false, operationId: "node-integration", runId: "run-integration", integratedAt: now }, ...overrides };
}
function run(key: string, overrides: Partial<CampRun> = {}): CampRun {
  return { id: "run-" + key, goalId: "dag", goalAttempt: 1, taskId: "build-" + key, executor: "agent", taskKind: "build", planItemKey: key, role: "builder", workerId: pool.workerIds[key === "left" ? 0 : 1]!, epoch: 2, status: "running", leaseValid: true, leaseExpiresAt: "2000-01-01T00:00:00Z", cleanupState: "pending", inputCandidate: foundation, summary: null, error: null, sessionId: null, artifacts: [], ...overrides };
}
const tasks: CampTask[] = definitions.map(item => ({ id: "build-" + item.key, goalId: "dag", goalAttempt: 1, role: "builder", kind: "build", planItemKey: item.key, title: item.title, dependsOn: [], executionStatus: "queued" }));
const draw = (state: CampGoal, runs: CampRun[] = []) => <CampGoalCard goal={state} tasks={tasks} runs={runs} busy={false} onRetry={async () => {}} onCancel={async () => {}} />;

test("DAG intent is offered only when advertised and losing support keeps the selected mode and draft", async () => {
  const submissions: CampPlanMode[] = [];
  const submit = async (_description: string, _budget: unknown, mode: CampPlanMode) => { submissions.push(mode); return true; };
  const view = renderWithIntl(<CampGoalComposer channelId="dag" busy={false} supportedPlanModes={["sequential", "parallel_pair"]} onSubmit={submit} />);
  assert.equal(screen.queryByRole("option", { name: "Up to six tasks with dependencies" }), null);
  view.rerender(<TestIntlProvider><CampGoalComposer channelId="dag" busy={false} supportedPlanModes={["sequential", "bounded_dag"]} onSubmit={submit} /></TestIntlProvider>);
  const selector = screen.getByTestId("camp-plan-mode") as HTMLSelectElement;
  fireEvent.change(selector, { target: { value: "bounded_dag" } });
  const field = screen.getByRole("textbox", { name: "Give the team a goal" }) as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "Keep dependencies explicit" } });
  assert.ok(screen.getByText(/at most two direct dependencies/));
  view.rerender(<TestIntlProvider><CampGoalComposer channelId="dag" busy={false} supportedPlanModes={["sequential", "parallel_pair"]} onSubmit={submit} /></TestIntlProvider>);
  fireEvent.submit(field.closest("form")!); assert.deepEqual(submissions, []); assert.equal(selector.value, "bounded_dag"); assert.equal(field.value, "Keep dependencies explicit");
  view.rerender(<TestIntlProvider><CampGoalComposer channelId="dag" busy={false} supportedPlanModes={["sequential", "bounded_dag"]} onSubmit={submit} /></TestIntlProvider>);
  fireEvent.submit(field.closest("form")!); await waitFor(() => assert.deepEqual(submissions, ["bounded_dag"]));
  let body: unknown;
  api.post = (async (_path: string, value: unknown) => { body = value; return { data: {} }; }) as typeof api.post;
  await campApi.submit("room", "Dependent changes", "A complete graph", undefined, undefined, "bounded_dag");
  assert.equal((body as { planMode: string }).planMode, "bounded_dag");
});

test("dependency layers and links remain correct even when the projection order is not topological", () => {
  const state = goal(); state.items = [state.items![3]!, state.items![2]!, state.items![0]!, state.items![1]!];
  renderWithIntl(draw(state));
  const graph = screen.getByTestId("camp-dependency-graph"), layers = Array.from(graph.querySelectorAll("[data-graph-layer]"));
  assert.deepEqual(layers.map(layer => Array.from(layer.querySelectorAll("[data-testid^=camp-plan-item-]")).map(item => item.getAttribute("data-testid"))), [["camp-plan-item-foundation"], ["camp-plan-item-right", "camp-plan-item-left"], ["camp-plan-item-delivery"]]);
  const consumer = within(screen.getByTestId("camp-plan-item-delivery"));
  const links = consumer.getAllByRole("link"); assert.equal(links.length, 4);
  for (const link of links) { const id = decodeURIComponent(link.getAttribute("href")!.slice(1)); assert.ok(document.getElementById(id)); }
  assert.ok(consumer.getByText("Waiting for direct dependencies to be approved"));
  assert.equal(consumer.queryByText("Starts after earlier tasks are approved."), null);
  assert.equal(screen.queryByTestId("camp-item-shared-baseline"), null);
  assert.equal(screen.queryByTestId("camp-goal-integration"), null);
});

test("same-reference and ancestor resolutions retain both parent identities without inventing an integration", () => {
  const state = goal(), item = state.items![3]!;
  state.items![3] = { ...item, inputSources: [source("left", left), source("right", left)], inputCandidate: left, inputResolution: "same_ref", scheduling: { state: "ready", reason: null, blockedByKeys: [] } };
  const view = renderWithIntl(draw(state));
  const input = screen.getByTestId("camp-plan-item-delivery").querySelector("[data-testid=camp-node-input]")!;
  assert.equal(within(input as HTMLElement).getByTestId("camp-node-sources").querySelectorAll("[data-source-key]").length, 2);
  assert.ok(within(input as HTMLElement).getByText(/Both parents identify the same candidate/));
  assert.ok(within(input as HTMLElement).getByTestId("camp-node-effective-input").textContent?.includes(left.refId));
  assert.equal(screen.queryByTestId("camp-integration-operation"), null);
  state.items![3] = { ...state.items![3]!, inputSources: [source("left", left), source("right", right)], inputCandidate: right, inputResolution: "ancestor" };
  view.rerender(<TestIntlProvider>{draw(state)}</TestIntlProvider>);
  assert.ok(screen.getByText(/Native lineage establishes/));
  assert.ok(within(screen.getByTestId("camp-plan-item-delivery")).getByTestId("camp-node-effective-input").textContent?.includes(right.refId));
});

test("a node integration uses its frozen branch-point base and appears only beside its consumer", () => {
  const state = goal(), op = operation();
  state.integration = { required: true, status: "merged", operations: [op] };
  state.items![3] = { ...state.items![3]!, inputSources: op.integrationInput.parents, inputCandidate: integrated, inputResolution: "integration", scopedIntegrationOperationId: op.id, scheduling: { state: "ready", reason: null, blockedByKeys: [] } };
  renderWithIntl(draw(state));
  const item = within(screen.getByTestId("camp-plan-item-delivery"));
  assert.equal(screen.getAllByTestId("camp-integration-operation").length, 1);
  const inputs = item.getByTestId("camp-integration-inputs");
  assert.ok(within(inputs).getByTestId("camp-integration-base").textContent?.includes(foundation.refId));
  assert.equal(within(inputs).getByTestId("camp-integration-base").textContent?.includes(base.refId), false);
  assert.equal(item.getByTestId("camp-integration-operation").getAttribute("data-scope"), "node_input");
  assert.equal(screen.queryByTestId("camp-goal-integration"), null);
  assert.equal(screen.getByTestId("camp-graph-delivery").getAttribute("data-status"), "waiting_nodes");
  assert.equal(screen.queryByRole("button", { name: "Download result manifest" }), null);
});

test("a node cannot display an integration receipt bound to a different node or attempt", () => {
  const op = operation({ planItemKey: "left", goalAttempt: 2 }), state = goal({ integration: { required: true, status: "merged", operations: [op] } });
  state.items![3] = { ...state.items![3]!, scopedIntegrationOperationId: op.id };
  renderWithIntl(draw(state));
  const input = within(screen.getByTestId("camp-plan-item-delivery"));
  assert.ok(input.getByRole("alert")); assert.equal(input.queryByTestId("camp-integration-receipt"), null);
});

test("a node waiting for a human does not conceal another ready branch’s running builder", async () => {
  const state = goal();
  state.items![1] = { ...state.items![1]!, scheduling: { state: "waiting_question", reason: "question_pending", blockedByKeys: [] } };
  state.items![2] = { ...state.items![2]!, status: "building", scheduling: { state: "running", reason: null, blockedByKeys: [] } };
  state.questions = [{ id: "question", goalId: state.id, goalAttempt: 1, taskId: "build-left", originRunId: "run-left", fromRole: "builder", toRole: "planner", needsHuman: true, status: "awaiting_human", content: "Choose the left behavior", answer: null, answerByRole: null, canAnswer: true, createdAt: now, answeredAt: null }];
  const runs = [run("left", { status: "suspended", cleanupState: "confirmed", leaseValid: false }), run("right")], stopped: string[] = [];
  renderWithIntl(<><CampRoleCard role="builder" runs={runs} goals={[state]} canCancel busy={false} onCancel={async id => { stopped.push(id); }} />{draw(state, runs)}</>);
  assert.ok(within(screen.getByTestId("camp-plan-item-left")).getByText("Choose the left behavior"));
  assert.ok(within(screen.getByTestId("camp-plan-item-right")).getByTestId("camp-run-execution"));
  const builder = within(screen.getByTestId("camp-role-builder"));
  assert.equal(builder.getAllByTestId("camp-run-execution").length, 1);
  fireEvent.click(builder.getByRole("button", { name: "Stop entire goal" })); await waitFor(() => assert.deepEqual(stopped, ["run-right"]));
  assert.ok(builder.getByText(/cleanup of both lanes/));
});

test("graph output and final delivered repair remain distinct, while scoped and final integration history retain their identities", () => {
  const node = operation(), endReceipt = { ...node.integrationReport!, operationId: "final-integration", runId: "run-final-integration", candidate: final };
  const end = operation({ id: endReceipt.operationId, scope: "goal", planItemKey: null, latestRunId: endReceipt.runId, integrationReport: endReceipt });
  const state = goal({ status: "completed", activeRuns: 0, resultReady: true, canCancel: false, currentCandidate: repaired, finalCandidate: repaired, integration: { required: true, status: "merged", operations: [node, end] }, graph: { schemaVersion: 1, sinkKeys: ["left", "right"], delivery: { status: "ready", candidate: final, sourceRunId: endReceipt.runId, operationId: end.id } } });
  state.items![3] = { ...state.items![3]!, scopedIntegrationOperationId: node.id, inputCandidate: integrated };
  renderWithIntl(draw(state));
  const delivery = within(screen.getByTestId("camp-graph-delivery"));
  assert.ok(delivery.getByText(final.refId)); assert.equal(delivery.queryByText(repaired.refId), null); assert.ok(delivery.getByText(/Later whole-goal repairs may produce a different delivered version/));
  const finalSection = within(screen.getByTestId("camp-goal-integration"));
  assert.equal(finalSection.getAllByTestId("camp-integration-operation").length, 1);
  assert.equal(finalSection.getByTestId("camp-integration-operation").getAttribute("data-operation-id"), end.id);
  assert.ok(screen.getByText(repaired.refId)); assert.ok(screen.getByRole("button", { name: "Download result manifest" }));
});

test("cancelled graph runs retain separate cleanup evidence and an inspection latch offers no retry", () => {
  const state = goal({ status: "cancelled", reason: "cancelled_by_human", activeRuns: 0, canCancel: false, canRetry: false, integrationInspectionRequired: true, graph: { schemaVersion: 1, sinkKeys: ["delivery"], delivery: { status: "blocked", candidate: null, sourceRunId: null, operationId: null } } });
  renderWithIntl(draw(state, [run("left", { status: "cancelled", cancelRequestedAt: now, leaseValid: false, cleanupState: "confirmed" }), run("right", { status: "cancelled", cancelRequestedAt: now, leaseValid: false, cleanupState: "unknown" })]));
  const cleanupRegion = within(screen.getByTestId("camp-parallel-cleanup")); assert.equal(cleanupRegion.getAllByTestId("camp-run-execution").length, 2);
  assert.ok(cleanupRegion.getByText("Sandbox cleanup confirmed.")); assert.ok(cleanupRegion.getByText(/sandbox cleanup has not been confirmed/));
  assert.equal(screen.queryByRole("button", { name: "Retry goal" }), null); assert.ok(screen.getByText(/no action to confirm that inspection and resume this goal/));
});

test("untrusted node titles stay text and a graph with a missing parent remains readable", () => {
  const state = goal(); state.items![1] = { ...state.items![1]!, title: "<img src=x onerror=alert(1)>", dependsOnKeys: ["missing-parent"], scheduling: { state: "waiting_dependencies", reason: null, blockedByKeys: ["missing-parent"] } };
  renderWithIntl(draw(state));
  assert.ok(screen.getAllByText(/<img src=x onerror=alert\(1\)>/).length > 0); assert.equal(screen.getByTestId("camp-dependency-graph").querySelector("img"), null);
  assert.equal(within(screen.getByTestId("camp-plan-item-left")).getAllByText("missing-parent").length, 2);
});

test("node integration milestones refresh the version list while the delivery candidate is still unchanged", async () => {
  const state = goal(), op = operation({ status: "running", integrationReport: null }); state.integration = { required: true, status: "running", operations: [op] };
  const baselineVersion: CampVersion = { id: "baseline", runId: null, kind: "baseline", candidate: base, taskKind: null, planItemKey: null, goalAttempt: 1, createdAt: now, status: "completed", changeSetAvailable: false };
  let loads = 0;
  api.get = (async (path: string) => {
    if (path.endsWith("/versions")) { loads++; return { data: { versions: loads === 1 ? [baselineVersion] : [baselineVersion, { ...baselineVersion, id: "run-integration", runId: "run-integration", operationId: op.id, kind: "integration", taskKind: "integration", scope: "node_input", planItemKey: "delivery", candidate: integrated }], reason: null } }; }
    if (path.endsWith("/changes")) return { data: { available: false, reason: "not_recorded", runId: "run-integration", candidate: integrated, changeSet: null } };
    return { data: { status: "unavailable", operationId: null, receipt: null } };
  }) as typeof api.get;
  const view = renderWithIntl(<CampGoalVersions goal={state} />), details = screen.getByTestId("camp-versions-dag") as HTMLDetailsElement;
  await act(async () => { details.open = true; fireEvent(details, new details.ownerDocument.defaultView!.Event("toggle")); });
  await waitFor(() => assert.equal(loads, 1));
  view.rerender(<TestIntlProvider><CampGoalVersions goal={{ ...state, integration: { required: true, status: "merged", operations: [operation()] } }} /></TestIntlProvider>);
  await waitFor(() => assert.equal(screen.getAllByRole("option").length, 2));
  assert.equal(loads, 2); assert.ok(screen.getByRole("option", { name: /Task input integration.*delivery/ }));
});
