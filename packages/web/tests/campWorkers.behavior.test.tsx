import assert from "node:assert/strict";
import { cleanup, screen, within } from "@testing-library/react";
import { renderWithIntl } from "./helpers/intl";
import CampWorkerDiagnostics from "../src/components/camp/CampWorkerDiagnostics";
import type { CampWorkerRecord } from "../src/components/camp/campApi";

afterEach(cleanup);

function report(overrides: Partial<CampWorkerRecord> = {}): CampWorkerRecord {
  return {
    workerId: "storage-worker-1",
    declaration: { protocolVersions: [1], workerVersion: "1.0.0", taskKinds: ["plan", "build"], refKinds: ["layer", "commit"], capabilities: [] },
    compatibility: { status: "compatible", code: "compatible", protocolVersion: 1, missingTaskKinds: [], missingRefKinds: [], missingCapabilities: [] },
    requirements: null, lastSeenAt: "2026-10-23T00:30:00Z", lastClaimAt: null, lastRunId: null,
    ...overrides,
  };
}

test("older snapshots without a worker registry keep the existing room interface", () => {
  renderWithIntl(<CampWorkerDiagnostics />);
  assert.equal(screen.queryByTestId("camp-worker-diagnostics"), null);
});

test("an empty real registry asks for a connection without inventing an incompatibility", () => {
  renderWithIntl(<CampWorkerDiagnostics workers={[]} />);
  assert.ok(screen.getByText("No worker has reported to this room yet. Connect a worker to start the team."));
  assert.equal(screen.queryByText("Cannot run the last checked task"), null);
  assert.equal(screen.queryByRole("button"), null);
});

test("a compatible report shows its actual declaration and timestamp without claiming current presence", () => {
  renderWithIntl(<CampWorkerDiagnostics workers={[report()]} />);
  const card = screen.getByTestId("camp-worker-report");
  assert.ok(within(card).getByText("Passed the last task check"));
  assert.ok(within(card).getByText("storage-worker-1"));
  assert.ok(within(card).getByText("1.0.0"));
  assert.equal(card.querySelector("time")?.dateTime, "2026-10-23T00:30:00Z");
  assert.ok(screen.getByText(/They do not show whether a worker is online now/));
  assert.equal(screen.queryByText("Online", { exact: true }), null);
  assert.equal(screen.queryByRole("button"), null, "A report must not initiate work or restart a worker");
});

test("a rejected worker exposes exact missing capabilities and a targeted upgrade instruction", () => {
  renderWithIntl(<CampWorkerDiagnostics workers={[report({ compatibility: { status: "incompatible", code: "capability_missing", protocolVersion: 1, missingTaskKinds: ["final_review"], missingRefKinds: ["layer"], missingCapabilities: ["questions.v1"] } })]} />);
  assert.ok(screen.getByText("Cannot run the last checked task"));
  assert.ok(screen.getByText("final_review"));
  assert.ok(screen.getByText("layer"));
  assert.ok(screen.getByText("questions.v1"));
  assert.ok(screen.getByText(/Update the worker and its Camp plugin together/));
  assert.equal(screen.queryByRole("button"), null);
});

test("an idle report with no task check stays unknown even when the worker declared a protocol", () => {
  renderWithIntl(<CampWorkerDiagnostics workers={[report({ compatibility: null })]} />);
  assert.ok(screen.getByText("No task compatibility check yet"));
  assert.equal(screen.queryByText("Passed the last task check"), null);
  assert.equal(screen.queryByText("Cannot run the last checked task"), null);
  assert.ok(screen.getByText("1.0.0"));
});

test("undeclared legacy workers remain distinct from incompatible workers and localize their limitation", () => {
  renderWithIntl(<CampWorkerDiagnostics workers={[report({ declaration: null, compatibility: { status: "legacy", code: "legacy_unversioned", protocolVersion: null, missingTaskKinds: [], missingRefKinds: [], missingCapabilities: [] } })]} />, { locale: "zh-cn" });
  assert.ok(screen.getByText("旧版协议"));
  assert.ok(screen.getByText("尚未收到执行能力声明。"));
  assert.ok(screen.getByText(/只能领取受支持的旧版任务/));
  assert.equal(screen.queryByText("无法执行最近检查的任务"), null);
});

test("protocol version rejection explains the mismatch while malformed timestamps stay inspectable", () => {
  renderWithIntl(<CampWorkerDiagnostics workers={[report({ lastSeenAt: "invalid-timestamp", compatibility: { status: "incompatible", code: "protocol_unsupported", protocolVersion: null, missingTaskKinds: [], missingRefKinds: [], missingCapabilities: [] } })]} />);
  assert.ok(screen.getByText("The declared protocol versions do not support this task."));
  assert.ok(screen.getByText("Time unavailable"));
});
