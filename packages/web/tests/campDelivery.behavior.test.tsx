import assert from "node:assert/strict";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithIntl, TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import CampChangeSetView from "../src/components/camp/CampChangeSet";
import CampVerificationReport from "../src/components/camp/CampVerificationReport";
import CampVerificationPolicyConfig from "../src/components/camp/CampVerificationPolicy";
import CampGoalVersions from "../src/components/camp/CampGoalVersions";
import CampGoalResult from "../src/components/camp/CampGoalResult";
import CampGoalComposer from "../src/components/camp/CampGoalComposer";
import { CampRoleCard, CampRunResults } from "../src/components/camp/CampRunViews";
import { visibleSourceText } from "../src/components/camp/campDisplay";
import type { CampCandidate, CampChangeEntry, CampChangeSet, CampGoal, CampRun, CampVerificationPolicySnapshot, CampVerificationReceipt } from "../src/components/camp/campApi";

const originalGet = api.get, originalPut = api.put;
afterEach(() => { cleanup(); api.get = originalGet; api.put = originalPut; });
const base: CampCandidate = { type: "layerfs", projectId: `p-${"a".repeat(16)}`, refKind: "layer", refId: `32${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` };
const target: CampCandidate = { ...base, refKind: "commit", refId: `12${"d".repeat(64)}`, rootId: "e".repeat(64) };
const nextTarget: CampCandidate = { ...target, refId: `12${"f".repeat(64)}`, rootId: "0".repeat(64) };
const policy: CampVerificationPolicySnapshot = { digest: "1".repeat(64), policy: { id: "acceptance", revision: 2, name: "Project acceptance", maxRepairAttempts: 1, checks: [{ id: "acceptance", label: "Pinned acceptance", argv: ["node", "/camp-checks/acceptance"], timeoutMs: 120000, harness: { id: "acceptance", sha256: "2".repeat(64) } }] } };
function entry(overrides: Partial<CampChangeEntry> = {}): CampChangeEntry {
  return { path: "src/catalog.mjs", change: "modified", before: { type: "file", mode: 0o644, size: 4, sha256: "3".repeat(64) }, after: { type: "file", mode: 0o644, size: 8, sha256: "4".repeat(64) }, binary: false, modeChanged: false, patch: "@@ -1 +1 @@\n-old\n+new", patchTruncated: false, previewReason: null, ...overrides };
}
function changeSet(entries = [entry()], overrides: Partial<CampChangeSet> = {}): CampChangeSet {
  return { schemaVersion: 1, base, target, entries, truncated: false, stats: { added: 0, modified: entries.length, deleted: 0, typeChanged: 0 }, ...overrides };
}
function receipt(overrides: Partial<CampVerificationReceipt> = {}): CampVerificationReceipt {
  return { schemaVersion: 1, status: "passed", runId: "verification-run", operationId: "operation", verifiedAt: "2026-10-23T00:00:00Z", candidate: target, policyDigest: policy.digest, checks: [{ id: "acceptance", argv: ["node", "/camp-checks/acceptance"], exitCode: 0, signal: null, timedOut: false, oomKilled: false, durationMs: 42, stdout: "External checks passed", stderr: "", outputTruncated: false }], ...overrides };
}
function goal(overrides: Partial<CampGoal> = {}): CampGoal {
  return { id: "delivery-goal", roomId: "room", title: "Deliver a catalog", description: null, status: "completed", reason: null, attempt: 1, workflow: "serial", protocolVersion: 2, verificationPolicy: policy, budget: { maxRuns: 24, maxReviewRounds: 10, maxDurationSeconds: 3600 }, usage: { runs: 5, reviewRounds: 2, elapsedSeconds: 100 }, activeRuns: 0, canRetry: false, canCancel: false, createdAt: "2026-10-23T00:00:00Z", startedAt: null, completedAt: null, currentCandidate: target, finalCandidate: target, summary: { summary: "Catalog delivered", evidence: null, remaining: [] }, ...overrides };
}
const versions = [{ id: "baseline", runId: null, kind: "baseline", candidate: base, taskKind: null, planItemKey: null, goalAttempt: 1, createdAt: "2026-10-23T00:00:00Z", status: "completed", changeSetAvailable: false }, { id: "producer", runId: "producer", kind: "run", candidate: target, taskKind: "build", planItemKey: "catalog", goalAttempt: 1, createdAt: "2026-10-23T00:01:00Z", status: "completed", changeSetAvailable: true }, { id: "next", runId: "next", kind: "run", candidate: nextTarget, taskKind: "build", planItemKey: null, goalAttempt: 1, createdAt: "2026-10-23T00:02:00Z", status: "completed", changeSetAvailable: true }];
async function openHistory() {
  const details = screen.getByTestId("camp-versions-delivery-goal") as HTMLDetailsElement;
  await act(async () => { details.open = true; fireEvent(details, new details.ownerDocument.defaultView!.Event("toggle")); });
  await waitFor(() => assert.ok(screen.getByTestId("camp-version-select")));
}

test("file previews are opened on demand and hostile paths or HTML patches stay inert text", () => {
  renderWithIntl(<CampChangeSetView changeSet={changeSet([entry({ path: "<img onerror=alert(1)>.txt", patch: "+<script>globalThis.compromised=true</script>" })])} />);
  assert.equal(screen.queryByText(/globalThis.compromised/), null);
  fireEvent.click(screen.getByRole("button", { name: /<img onerror=alert/ }));
  assert.ok(screen.getByText("+<script>globalThis.compromised=true</script>"));
  assert.equal(document.querySelector("[data-testid=camp-change-set] img, [data-testid=camp-change-set] script"), null);
  assert.equal(screen.queryByRole("link"), null);
});

test("binary, deletion, type and permission changes retain distinct metadata without fabricating a text patch", () => {
  renderWithIntl(<CampChangeSetView changeSet={changeSet([
    entry({ path: "image.bin", binary: true, patch: null, previewReason: "binary" }),
    entry({ path: "removed.txt", change: "deleted", after: null }),
    entry({ path: "linked", change: "type_changed", after: { type: "symlink", mode: 0o777, size: 3, target: "../elsewhere" }, patch: null }),
    entry({ path: "script.sh", modeChanged: true, after: { type: "file", mode: 0o755, size: 8, sha256: "4".repeat(64) }, patch: null }),
  ])} />);
  const rows = screen.getAllByTestId("camp-change-entry");
  fireEvent.click(within(rows[0]).getByRole("button"));
  assert.ok(screen.getByText("Binary content changed. A text preview is not available."));
  fireEvent.click(within(rows[1]).getByRole("button")); assert.ok(screen.getByText("Does not exist"));
  fireEvent.click(within(rows[2]).getByRole("button")); assert.ok(screen.getByText("Symbolic link")); assert.ok(screen.getByText("../elsewhere"));
  fireEvent.click(within(rows[3]).getByRole("button")); assert.ok(screen.getByText("755")); assert.ok(screen.getByText("File permissions changed."));
  assert.equal(screen.queryByRole("link"), null);
});

test("partial empty reports never imply an unchanged workspace and control characters are visible", () => {
  renderWithIntl(<CampChangeSetView changeSet={changeSet([], { truncated: true })} />);
  assert.ok(screen.getByText(/does not confirm an unchanged workspace/));
  assert.equal(screen.queryByText("The recorded comparison contains no file changes."), null);
  assert.equal(visibleSourceText("evil\nname\u202e.txt"), "evil\\u000aname\\u202e.txt");
  assert.equal(visibleSourceText("line\nnext\u001b[31m", true), "line\nnext\\u001b[31m");
  assert.equal(visibleSourceText("file\u200f\u061c\u0085\u2028.txt"), "file\\u200f\\u061c\\u0085\\u2028.txt");
});

test("truncated file patches disclose that the displayed text is incomplete", () => {
  renderWithIntl(<CampChangeSetView changeSet={changeSet([entry({ patchTruncated: true })])} />);
  fireEvent.click(screen.getByRole("button", { name: /src\/catalog/ }));
  assert.ok(screen.getByText(/preview does not contain the full change/));
});

test("server receipts expose the exact policy, external source and plain command output", () => {
  const recorded = receipt(); recorded.checks[0].stdout = "<img src=x onerror=alert(1)>\n\u202echeck";
  renderWithIntl(<CampVerificationReport status="passed" receipt={recorded} candidate={target} policy={policy} />);
  assert.ok(screen.getByText("Configured checks passed")); assert.ok(screen.getByText("Check source: pinned external harness"));
  assert.ok(screen.getByText("Exit code: 0 · Duration: 42 ms"));
  assert.match(screen.getByTestId("camp-verification-check-log").textContent ?? "", /\\u202echeck/);
  assert.equal(document.querySelector("[data-testid=camp-verification-report] img"), null);
});

test("a passed receipt for another file root or policy never confirms the selected candidate", () => {
  renderWithIntl(<CampVerificationReport status="passed" receipt={receipt({ candidate: { ...target, rootId: "other-root" } })} candidate={target} policy={policy} />);
  assert.ok(screen.getByRole("alert")); assert.equal(screen.queryByText("Configured checks passed"), null);
});

test("unknown receipt status and timeouts, OOM or truncated logs remain explicit", () => {
  const recorded = receipt({ status: "failed" }); Object.assign(recorded.checks[0], { timedOut: true, oomKilled: true, outputTruncated: true, exitCode: null, signal: "SIGKILL" });
  renderWithIntl(<CampVerificationReport status="future_state" receipt={recorded} candidate={target} policy={policy} />);
  assert.ok(screen.getByText("No confirmed check result")); assert.ok(screen.getByText(/exceeded its time limit/)); assert.ok(screen.getByText(/exceeding its memory limit/)); assert.ok(screen.getByText(/Only part of this command's output/));
  assert.equal(screen.queryByText("Configured checks passed"), null);
});

test("a roleless verification run is labeled as a system operation and never occupies the three role cards", () => {
  const run: CampRun = { id: "verification", executor: "verification", operationId: "operation", taskId: null, role: null, taskKind: "verification", epoch: 1, status: "running", summary: "Running fixed checks", error: null, sessionId: null, artifacts: [{ type: "verification", summary: "Command queued" }] };
  renderWithIntl(<><CampRoleCard role="reviewer" runs={[run]} busy={false} canCancel onCancel={async () => {}} /><CampRunResults runs={[run]} /></>);
  assert.ok(screen.getByText("Ready for work")); assert.match(screen.getByText(/System verification · Attempt/).textContent ?? "", /System verification/);
  assert.equal(screen.queryByRole("button", { name: "Stop run" }), null);
});

test("v2 result actions require server readiness while historical v1 fallback remains usable", () => {
  const view = renderWithIntl(<CampGoalResult goal={goal()} canContinue onContinue={() => {}} />);
  assert.equal(screen.queryByRole("button", { name: "Download result manifest" }), null);
  view.rerender(<TestIntlProvider><CampGoalResult goal={goal({ resultReady: true })} canContinue onContinue={() => {}} /></TestIntlProvider>);
  assert.ok(screen.getByRole("button", { name: "Download result manifest" }));
  view.rerender(<TestIntlProvider><CampGoalResult goal={goal({ protocolVersion: 1, resultReady: false })} canContinue onContinue={() => {}} /></TestIntlProvider>);
  assert.equal(screen.queryByRole("button", { name: "Continue from this result" }), null);
  view.rerender(<TestIntlProvider><CampGoalResult goal={goal({ protocolVersion: 1 })} canContinue onContinue={() => {}} /></TestIntlProvider>);
  assert.ok(screen.getByRole("button", { name: "Continue from this result" }));
});

test("read-only members can inspect configured checks but cannot edit their execution policy", () => {
  renderWithIntl(<CampVerificationPolicyConfig roomId="room" current={policy} canManage={false} onSaved={() => {}} />);
  assert.ok(screen.getByText("Pinned acceptance")); assert.equal(screen.queryByTestId("camp-policy-configure"), null);
});

test("editing policy metadata preserves every existing command and pinned external harness", async () => {
  let submitted: { policy: typeof policy.policy } | null = null;
  api.put = (async (_path: string, value: unknown) => { submitted = value as typeof submitted; return { data: {} }; }) as typeof api.put;
  renderWithIntl(<CampVerificationPolicyConfig roomId="room" current={policy} canManage onSaved={() => {}} />);
  fireEvent.click(screen.getByTestId("camp-policy-configure"));
  fireEvent.change(screen.getByRole("textbox", { name: "Check policy name" }), { target: { value: "Updated policy name" } });
  fireEvent.submit(screen.getByTestId("camp-policy-form"));
  await waitFor(() => assert.notEqual(submitted, null));
  assert.deepEqual((submitted as unknown as { policy: typeof policy.policy }).policy.checks, policy.policy.checks);
  assert.equal((submitted as unknown as { policy: typeof policy.policy }).policy.revision, 3);
});

test("replacing an existing external policy requires an explicit confirmation and preserves a shell command as one argument", async () => {
  const requests: unknown[] = [];
  api.put = (async (_path: string, value: unknown) => { requests.push(value); return { data: {} }; }) as typeof api.put;
  renderWithIntl(<CampVerificationPolicyConfig roomId="room" current={policy} canManage onSaved={() => {}} />);
  fireEvent.click(screen.getByTestId("camp-policy-configure")); fireEvent.change(screen.getByRole("combobox"), { target: { value: "shell" } });
  const command = "node --test && printf '%s' '$literal'";
  fireEvent.change(screen.getByRole("textbox", { name: "Check command" }), { target: { value: command } });
  fireEvent.submit(screen.getByTestId("camp-policy-form")); assert.equal(requests.length, 0);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.submit(screen.getByTestId("camp-policy-form"));
  await waitFor(() => assert.equal(requests.length, 1));
  assert.deepEqual((requests[0] as { policy: typeof policy.policy }).policy.checks[0].argv, ["/bin/sh", "-c", command]);
  assert.equal((requests[0] as { policy: typeof policy.policy }).policy.checks[0].harness, undefined);
});

test("failed policy saves retain the command draft and the editor", async () => {
  api.put = (async () => { throw { response: { data: { error: "Policy revision changed" } } }; }) as typeof api.put;
  renderWithIntl(<CampVerificationPolicyConfig roomId="room" current={null} canManage onSaved={() => {}} />);
  fireEvent.click(screen.getByTestId("camp-policy-configure")); fireEvent.change(screen.getByRole("combobox"), { target: { value: "shell" } });
  const input = screen.getByRole("textbox", { name: "Check command" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "node --test catalog.test.mjs" } }); fireEvent.submit(screen.getByTestId("camp-policy-form"));
  await waitFor(() => assert.ok(screen.getByText("Policy revision changed"))); assert.equal(input.value, "node --test catalog.test.mjs");
});

test("a delayed policy save locks all metadata and replacement controls until the response settles", async () => {
  let rejectSave!: (reason: unknown) => void, writes = 0;
  api.put = (async () => { writes++; return new Promise((_resolve, reject) => { rejectSave = reject; }); }) as typeof api.put;
  renderWithIntl(<CampVerificationPolicyConfig roomId="room" current={policy} canManage onSaved={() => {}} />);
  fireEvent.click(screen.getByTestId("camp-policy-configure"));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "shell" } });
  const command = screen.getByRole("textbox", { name: "Check command" }) as HTMLTextAreaElement;
  fireEvent.change(command, { target: { value: "node --test acceptance.test.mjs" } });
  fireEvent.click(screen.getByRole("checkbox"));
  const form = screen.getByTestId("camp-policy-form");
  fireEvent.submit(form);
  const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"));
  assert.equal(writes, 1); assert.equal(controls.length, 6);
  for (const control of controls) assert.equal(control.disabled, true, control.outerHTML);
  assert.equal((screen.getByRole("button", { name: "Close editor" }) as HTMLButtonElement).disabled, true);
  await act(async () => rejectSave({ response: { status: 503, data: { code: "unavailable", error: "Retry policy save" } } }));
  assert.ok(screen.getByText("Retry policy save"));
  for (const control of controls) assert.equal(control.disabled, false, control.outerHTML);
  assert.equal(command.value, "node --test acceptance.test.mjs");
  assert.equal((screen.getByRole("checkbox") as HTMLInputElement).checked, true);
  fireEvent.change(command, { target: { value: "node --test revised.test.mjs" } });
  assert.equal(command.value, "node --test revised.test.mjs");
});

test("remote policy updates retain an open draft and require reopening before saving the new baseline", async () => {
  const requests: unknown[] = [];
  api.put = (async (_path: string, body: unknown) => { requests.push(body); return { data: {} }; }) as typeof api.put;
  const view = renderWithIntl(<CampVerificationPolicyConfig roomId="room" current={policy} canManage onSaved={() => {}} />);
  fireEvent.click(screen.getByTestId("camp-policy-configure"));
  fireEvent.change(screen.getByRole("textbox", { name: "Check policy name" }), { target: { value: "Unsaved local name" } });
  const updated = { digest: "9".repeat(64), policy: { ...policy.policy, name: "Other administrator", revision: 3 } };
  view.rerender(<TestIntlProvider><CampVerificationPolicyConfig roomId="room" current={updated} canManage onSaved={() => {}} /></TestIntlProvider>);
  assert.equal((screen.getByRole("textbox", { name: "Check policy name" }) as HTMLInputElement).value, "Unsaved local name");
  assert.ok(screen.getByText(/Project checks changed while you were editing/));
  fireEvent.submit(screen.getByTestId("camp-policy-form")); assert.equal(requests.length, 0);
  fireEvent.click(screen.getByRole("button", { name: "Close editor" })); fireEvent.click(screen.getByTestId("camp-policy-configure"));
  assert.equal((screen.getByRole("textbox", { name: "Check policy name" }) as HTMLInputElement).value, "Other administrator");
  fireEvent.submit(screen.getByTestId("camp-policy-form"));
  await waitFor(() => assert.equal(requests.length, 1));
  assert.equal((requests[0] as { expectedDigest: string }).expectedDigest, updated.digest);
});

test("first policy creation expects no existing policy and ignores duplicate same-frame saves", async () => {
  const requests: unknown[] = [];
  let release: (value: unknown) => void = () => {};
  api.put = (async (_path: string, body: unknown) => { requests.push(body); return new Promise(resolve => { release = resolve; }); }) as typeof api.put;
  renderWithIntl(<CampVerificationPolicyConfig roomId="room" current={null} canManage onSaved={() => {}} />);
  fireEvent.click(screen.getByTestId("camp-policy-configure"));
  await act(async () => { fireEvent.submit(screen.getByTestId("camp-policy-form")); fireEvent.submit(screen.getByTestId("camp-policy-form")); });
  assert.equal(requests.length, 1); assert.equal((requests[0] as { expectedDigest: null }).expectedDigest, null);
  await act(async () => release({ data: {} }));
});

test("a policy CAS conflict keeps the draft, requests a fresh snapshot and blocks further stale writes", async () => {
  let writes = 0, refreshes = 0;
  api.put = (async () => { writes++; throw { response: { status: 409, data: { code: "verification_policy_changed", error: "The verification policy changed; refresh before saving your draft" } } }; }) as typeof api.put;
  renderWithIntl(<CampVerificationPolicyConfig roomId="room" current={policy} canManage onSaved={() => { refreshes++; }} />);
  fireEvent.click(screen.getByTestId("camp-policy-configure"));
  const field = screen.getByRole("textbox", { name: "Check policy name" }) as HTMLInputElement;
  fireEvent.change(field, { target: { value: "Keep this after conflict" } });
  fireEvent.submit(screen.getByTestId("camp-policy-form"));
  await waitFor(() => assert.ok(screen.getByText(/Project checks changed while you were editing/)));
  assert.equal(field.value, "Keep this after conflict"); assert.equal(refreshes, 1);
  fireEvent.submit(screen.getByTestId("camp-policy-form")); assert.equal(writes, 1);
});

test("missing project checks blocks a new goal separately from post permission and retains the draft", () => {
  let writes = 0;
  renderWithIntl(<CampGoalComposer channelId="channel" busy={false} verificationConfigured={false} onSubmit={async () => { writes++; return true; }} />);
  const input = screen.getByRole("textbox", { name: "Give the team a goal" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "Implement a catalog" } }); fireEvent.submit(input.closest("form")!);
  assert.equal(writes, 0); assert.equal(input.value, "Implement a catalog"); assert.ok(screen.getByText(/Configure project checks above/));
  assert.equal(screen.queryByText("Permission to post in this channel is required to submit a goal."), null);
});

test("version history fetches only after expansion and resolves changes through producer IDs", async () => {
  const paths: string[] = [];
  api.get = (async (path: string) => { paths.push(path); return { data: path.endsWith("/versions") ? { versions: versions.slice(0, 2), reason: null } : path.endsWith("/changes") ? { available: true, reason: null, runId: "producer", candidate: target, changeSet: changeSet() } : { status: "passed", operationId: "operation", receipt: receipt() } }; }) as typeof api.get;
  renderWithIntl(<CampGoalVersions goal={goal()} />); assert.deepEqual(paths, []);
  await openHistory(); await waitFor(() => assert.ok(screen.getByTestId("camp-change-set")));
  assert.ok(paths.includes("/camp/rooms/room/goals/delivery-goal/versions/producer/changes"));
  assert.equal(paths.some(path => path.includes("src/catalog") || path.includes(target.refId)), false);
  fireEvent.change(screen.getByTestId("camp-version-select"), { target: { value: "baseline" } });
  await waitFor(() => assert.ok(screen.getByText(/immutable starting snapshot/)));
  assert.equal(screen.queryByTestId("camp-change-set"), null);
});

test("switching versions aborts old requests and ignores late responses from the previous candidate", async () => {
  let releaseOld: (value: unknown) => void = () => {};
  let oldSignal: AbortSignal | undefined;
  api.get = (async (path: string, config?: { signal?: AbortSignal }) => {
    if (path.endsWith("/versions")) return { data: { versions, reason: null } };
    if (path.includes("/producer/changes")) { oldSignal = config?.signal; return new Promise(resolve => { releaseOld = resolve; }); }
    if (path.includes("/next/changes")) return { data: { available: true, candidate: nextTarget, changeSet: changeSet([entry({ path: "new-version-only.txt" })], { target: nextTarget }) } };
    return { data: { status: "unavailable", operationId: null, receipt: null } };
  }) as typeof api.get;
  renderWithIntl(<CampGoalVersions goal={goal()} />); await openHistory();
  await waitFor(() => assert.ok(oldSignal));
  fireEvent.change(screen.getByTestId("camp-version-select"), { target: { value: "next" } });
  await waitFor(() => assert.ok(screen.getByText("new-version-only.txt")));
  assert.equal(oldSignal?.aborted, true);
  await act(async () => releaseOld({ data: { available: true, candidate: target, changeSet: changeSet([entry({ path: "stale-old-file.txt" })]) } }));
  assert.equal(screen.queryByText("stale-old-file.txt"), null); assert.ok(screen.getByText("new-version-only.txt"));
});

test("polling an unchanged goal does not cancel a pending immutable version inspection", async () => {
  let releaseChanges: (value: unknown) => void = () => {};
  let inspectionSignal: AbortSignal | undefined;
  let changesRequests = 0;
  api.get = (async (path: string, config?: { signal?: AbortSignal }) => {
    if (path.endsWith("/versions")) return { data: { versions: versions.slice(0, 2), reason: null } };
    if (path.endsWith("/changes")) {
      changesRequests++;
      inspectionSignal = config?.signal;
      return new Promise(resolve => { releaseChanges = resolve; });
    }
    return { data: { status: "unavailable", operationId: null, receipt: null } };
  }) as typeof api.get;
  const view = renderWithIntl(<CampGoalVersions goal={goal({ baseCandidate: { ...base } })} />);
  await openHistory(); await waitFor(() => assert.equal(changesRequests, 1));
  const firstSignal = inspectionSignal;
  view.rerender(<TestIntlProvider><CampGoalVersions goal={goal({ baseCandidate: { ...base }, currentCandidate: { ...target }, finalCandidate: { ...target } })} /></TestIntlProvider>);
  assert.equal(firstSignal?.aborted, false);
  assert.equal(changesRequests, 1);
  await act(async () => releaseChanges({ data: { available: true, candidate: target, changeSet: changeSet() } }));
  await waitFor(() => assert.ok(screen.getByTestId("camp-change-set")));
});

test("a no-op integration remains the selected producer when its candidate equals a prior build", async () => {
  const integrated = { ...versions[1], id: "integrated", runId: "integrated", kind: "integration", taskKind: "integration", createdAt: "2026-10-23T00:03:00Z" };
  const paths: string[] = [];
  api.get = (async (path: string) => {
    paths.push(path);
    return { data: path.endsWith("/versions") ? { versions: [...versions.slice(0, 2), integrated], reason: null } : path.endsWith("/changes") ? { available: true, candidate: target, changeSet: changeSet() } : { status: "unavailable", operationId: null, receipt: null } };
  }) as typeof api.get;
  renderWithIntl(<CampGoalVersions goal={goal({ planMode: "same_baseline_pair", protocolVersion: 3, baseCandidate: base })} />);
  await openHistory(); await waitFor(() => assert.ok(screen.getByTestId("camp-change-set")));
  assert.equal((screen.getByTestId("camp-version-select") as HTMLSelectElement).value, "integrated");
  assert.ok(paths.includes("/camp/rooms/room/goals/delivery-goal/versions/integrated/changes"));
});

test("missing historical reports stay unavailable while a failed check request does not discard an independent diff", async () => {
  api.get = (async (path: string) => { if (path.endsWith("/verification")) throw new Error("receipt unavailable"); return { data: path.endsWith("/versions") ? { versions: versions.slice(0, 2), reason: null } : { available: false, reason: "legacy_unavailable", runId: "producer", candidate: target, changeSet: null } }; }) as typeof api.get;
  renderWithIntl(<CampGoalVersions goal={goal()} />); await openHistory();
  await waitFor(() => assert.ok(screen.getByText(/An unavailable report does not mean there were no changes/)));
  assert.ok(screen.getByText("Could not load this version's execution report."));
  assert.equal(screen.queryByText("The recorded comparison contains no file changes."), null);
});

test("candidate identity mismatches prevent a diff from being displayed under the selected version", async () => {
  api.get = (async (path: string) => ({ data: path.endsWith("/versions") ? { versions: versions.slice(0, 2), reason: null } : path.endsWith("/changes") ? { available: true, candidate: nextTarget, changeSet: changeSet([], { target: nextTarget }) } : { status: "unavailable", receipt: null, operationId: null } })) as typeof api.get;
  renderWithIntl(<CampGoalVersions goal={goal()} />); await openHistory();
  await waitFor(() => assert.ok(screen.getByText(/change report belongs to a different candidate/)));
  assert.equal(screen.queryByTestId("camp-change-set"), null);
});
