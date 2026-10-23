import assert from "node:assert/strict";
import { parseEnv } from "node:util";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithIntl, TestIntlProvider } from "./helpers/intl";
import CampProjectConfig from "../src/components/camp/CampProjectConfig";
import CampWorkerConnection from "../src/components/camp/CampWorkerConnection";
import CampRoomSetup from "../src/components/camp/CampRoomSetup";
import CampRoomPanel from "../src/components/camp/CampRoomPanel";
import CampPreflightReportView from "../src/components/camp/CampPreflightReport";
import { campApi } from "../src/components/camp/campApi";
import type { CampPreflightReport, CampRoom, CampSetup, CampSnapshot } from "../src/components/camp/campApi";
import { CAMP_PREFLIGHT_CHECK_IDS } from "../../camp-protocol/src/index.js";
import { WORKER_COMMANDS, workerEnvironment, workerSettingsValid } from "../src/components/camp/campWorkerConfig";

const originalApi = { ...campApi }, originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  cleanup(); Object.assign(campApi, originalApi);
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard); else Reflect.deleteProperty(navigator, "clipboard");
});
const digest = "a".repeat(64), nextDigest = "b".repeat(64), token = "camp_worker_test_credential";
const room: CampRoom = { id: "room-test", channelId: "channel", name: "Studio", project: { name: "Source", repoPath: "/old/source", baseRef: "main", storePath: "legacy-metadata" }, roles: [] };
const setup: CampSetup = { projectDigest: digest, projectMutable: true, readiness: null };
const report: CampPreflightReport = { schemaVersion: 1, workerVersion: "0.4.0", mode: "agent", modelConfigured: true, toolchainDigest: "c".repeat(64), imageId: "sha256:" + "d".repeat(64), checks: CAMP_PREFLIGHT_CHECK_IDS.map(id => ({ id, status: "passed", code: "ok" })) };
const readiness = { selfReported: true as const, observedAt: "2026-10-23T00:00:00Z", workerId: "worker-a", projectDigest: digest, report };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }

test("worker environment round-trips literal paths and credentials without shell interpolation or model keys", () => {
  const settings = { apiUrl: "https://api.example.test/prefix/", workerId: "stable-worker", runtimeHome: "/work/with spaces/$literal`value`", token };
  const contents = workerEnvironment(settings), env = parseEnv(contents);
  assert.equal(env.CAMP_API_URL, "https://api.example.test/prefix"); assert.equal(env.CAMP_RUNTIME_HOME, settings.runtimeHome); assert.equal(env.CAMP_WORKER_TOKEN, token);
  assert.equal("CAMP_RUNTIME_IMAGE" in env, false); assert.equal("CAMP_TOOLCHAIN_BUNDLE" in env, false);
  assert.equal(contents.includes("DEEPSEEK_API_KEY"), false);
  for (const runtimeHome of ["/tmp/O'Connor", "/tmp/O'Connor\\new", '/tmp/both\'"quotes']) assert.equal(parseEnv(workerEnvironment({ ...settings, runtimeHome })).CAMP_RUNTIME_HOME, runtimeHome);
  const overridden = parseEnv(workerEnvironment({ ...settings, imageId: report.imageId!, bundlePath: "/work/runtime bundle" }));
  assert.equal(overridden.CAMP_RUNTIME_IMAGE, report.imageId); assert.equal(overridden.CAMP_TOOLCHAIN_BUNDLE, "/work/runtime bundle");
  for (const command of Object.values(WORKER_COMMANDS)) { assert.equal(command.includes(token), false); assert.equal(command.includes(settings.apiUrl), false); }
  assert.ok(WORKER_COMMANDS.doctor.includes("--require-agent")); assert.ok(!WORKER_COMMANDS.reap.includes("--apply"));
});

test("invalid worker addresses and multiline configuration cannot produce a downloaded environment", () => {
  for (const url of ["", "file:///tmp/api", "https://user:secret@example.test", "https://example.test/api/", "https://example.test/?token=secret", "http://example.test/#secret"]) assert.equal(workerSettingsValid(url, "worker", "/home/runtime"), false, url);
  for (const home of ["", "/tmp/runtime\nDEEPSEEK_API_KEY=injected", "/tmp/\0runtime"]) assert.equal(workerSettingsValid("https://api.example.test", "worker", home), false);
  assert.equal(workerSettingsValid("https://api.example.test", "worker\nTOKEN=bad", "/runtime"), false);
  assert.equal(workerSettingsValid("https://api.example.test", "worker", "/runtime", "tag:latest"), false);
});

test("saving a corrected project uses its original digest and preserves existing project metadata", async () => {
  const pending = deferred<CampSnapshot>(); let writes = 0, saved = 0;
  campApi.project = async (roomId, project, expectedDigest) => {
    writes++; assert.equal(roomId, room.id); assert.equal(expectedDigest, digest);
    assert.deepEqual(project, { ...room.project, repoPath: "/corrected/source" }); return pending.promise;
  };
  renderWithIntl(<CampProjectConfig room={room} setup={setup} canManage onChanged={() => { saved++; }} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit project" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Project folder on the worker" }), { target: { value: "/corrected/source" } });
  await act(async () => { fireEvent.submit(screen.getByTestId("camp-project-form")); fireEvent.submit(screen.getByTestId("camp-project-form")); });
  assert.equal(writes, 1);
  await act(async () => pending.resolve({} as CampSnapshot)); assert.equal(saved, 1); assert.equal(screen.queryByTestId("camp-project-form"), null);
});

test("a delayed project save locks every draft field and a failed response restores the editable draft", async () => {
  let rejectSave!: (reason: unknown) => void, writes = 0;
  campApi.project = async () => { writes++; return new Promise<CampSnapshot>((_resolve, reject) => { rejectSave = reject; }); };
  renderWithIntl(<CampProjectConfig room={room} setup={setup} canManage onChanged={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit project" }));
  const name = screen.getByRole("textbox", { name: "Project name" }) as HTMLInputElement;
  const path = screen.getByRole("textbox", { name: "Project folder on the worker" }) as HTMLInputElement;
  fireEvent.change(name, { target: { value: "Unsaved source" } });
  fireEvent.change(path, { target: { value: "/corrected/source" } });
  fireEvent.submit(screen.getByTestId("camp-project-form"));
  assert.equal(writes, 1); assert.equal(name.disabled, true); assert.equal(path.disabled, true);
  assert.equal((screen.getByRole("button", { name: "Close editor" }) as HTMLButtonElement).disabled, true);
  await act(async () => rejectSave({ response: { status: 503, data: { code: "unavailable", error: "Retry project save" } } }));
  assert.ok(screen.getByText("Retry project save"));
  assert.equal(name.disabled, false); assert.equal(path.disabled, false);
  assert.equal(name.value, "Unsaved source"); assert.equal(path.value, "/corrected/source");
  fireEvent.change(path, { target: { value: "/next/edit" } }); assert.equal(path.value, "/next/edit");
});

test("project polling preserves an unsaved path and blocks a changed digest rather than overwriting another admin", () => {
  let writes = 0; campApi.project = async () => { writes++; return {} as CampSnapshot; };
  const view = renderWithIntl(<CampProjectConfig room={room} setup={setup} canManage onChanged={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit project" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Project folder on the worker" }), { target: { value: "/unsaved/draft" } });
  view.rerender(<TestIntlProvider><CampProjectConfig room={{ ...room, project: { ...room.project, repoPath: "/other/admin" } }} setup={{ ...setup, projectDigest: nextDigest }} canManage onChanged={() => {}} /></TestIntlProvider>);
  assert.equal((screen.getByRole("textbox", { name: "Project folder on the worker" }) as HTMLInputElement).value, "/unsaved/draft");
  assert.ok(screen.getByText(/Project settings changed while you were editing/));
  fireEvent.submit(screen.getByTestId("camp-project-form")); assert.equal(writes, 0);
});

for (const code of ["project_changed", "project_frozen"]) test(`a real ${code} error refreshes the snapshot and preserves the project draft`, async () => {
  let writes = 0, refreshes = 0;
  campApi.project = async () => { writes++; throw { response: { status: 409, data: { code, error: "Project configuration is no longer current" } } }; };
  renderWithIntl(<CampProjectConfig room={room} setup={setup} canManage onChanged={() => { refreshes++; }} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit project" })); fireEvent.submit(screen.getByTestId("camp-project-form"));
  await waitFor(() => assert.equal(refreshes, 1)); assert.ok(screen.getByRole("alert"));
  fireEvent.submit(screen.getByTestId("camp-project-form")); assert.equal(writes, 1);
});

test("locked projects and read-only members inspect settings without an edit action", () => {
  const view = renderWithIntl(<CampProjectConfig room={room} setup={{ ...setup, projectMutable: false }} canManage onChanged={() => {}} />);
  assert.equal(screen.queryByRole("button", { name: "Edit project" }), null); assert.ok(screen.getByText(/Project settings are locked/));
  view.rerender(<TestIntlProvider><CampProjectConfig room={room} setup={setup} canManage={false} onChanged={() => {}} /></TestIntlProvider>);
  assert.equal(screen.queryByRole("button", { name: "Edit project" }), null);
});

test("worker settings and the issued credential survive polling; commands copy no secrets and nothing is persisted", async () => {
  let mints = 0; const issued = deferred<{ token: string; expiresAt: string }>(), copied: string[] = [];
  campApi.workerToken = async () => { mints++; return issued.promise; };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  const view = renderWithIntl(<CampWorkerConnection roomId={room.id} expanded />);
  const apiInput = screen.getByTestId("camp-worker-api") as HTMLInputElement;
  assert.equal(apiInput.value, "", "Never assume the browser's localhost is reachable from the worker");
  fireEvent.change(apiInput, { target: { value: "https://worker-api.example.test" } });
  fireEvent.change(screen.getByTestId("camp-worker-id"), { target: { value: "stable-worker" } });
  const issue = screen.getByRole("button", { name: "Issue worker credential" });
  await act(async () => { fireEvent.click(issue); fireEvent.click(issue); }); assert.equal(mints, 1);
  await act(async () => issued.resolve({ token, expiresAt: readiness.observedAt }));
  view.rerender(<TestIntlProvider><CampWorkerConnection roomId={room.id} expanded /></TestIntlProvider>);
  assert.equal(apiInput.value, "https://worker-api.example.test"); assert.equal((screen.getByTestId("camp-worker-id") as HTMLInputElement).value, "stable-worker");
  assert.equal((screen.getByRole("button", { name: "Download worker configuration" }) as HTMLButtonElement).disabled, false);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy: Check and report setup" })));
  assert.deepEqual(copied, [WORKER_COMMANDS.doctor]); assert.equal(copied[0].includes(token), false);
  for (const storage of [localStorage, sessionStorage]) for (let i = 0; i < storage.length; i++) assert.equal((storage.getItem(storage.key(i)!) ?? "").includes(token), false);
  assert.equal(document.querySelector('input[name="DEEPSEEK_API_KEY"]'), null);
  fireEvent.click(screen.getByRole("button", { name: "Hide" })); assert.equal(screen.queryByTestId("camp-worker-env-download"), null);
});

test("self-checks disclose their actual timestamp, mode and codes without claiming live presence or key validity", () => {
  renderWithIntl(<CampPreflightReportView readiness={{ ...readiness, report: { ...report, mode: "verification", modelConfigured: false, checks: report.checks.map(check => check.id === "source" ? { ...check, status: "failed", code: "source_missing" } : check) } }} projectDigest={nextDigest} />);
  assert.ok(screen.getByText("System operations only")); assert.ok(screen.getByText(/protocol 3 also supports integration/)); assert.ok(screen.getByText("source_missing")); assert.ok(screen.getByText(/not live presence/)); assert.ok(screen.getByText(/older project settings/));
  assert.equal(screen.getByTestId("camp-preflight-report").querySelector("time")?.dateTime, readiness.observedAt);
  assert.equal(screen.queryByText("Online"), null); assert.equal(screen.queryByText("Key valid"), null);
});

test("switching rooms discards connection drafts and ignores a late credential from the previous room", async () => {
  const issued = deferred<{ token: string; expiresAt: string }>();
  campApi.workerToken = async () => issued.promise;
  const view = renderWithIntl(<CampWorkerConnection roomId="old-room" expanded />);
  fireEvent.change(screen.getByTestId("camp-worker-api"), { target: { value: "https://old-room.example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Issue worker credential" }));
  view.rerender(<TestIntlProvider><CampWorkerConnection roomId="new-room" expanded /></TestIntlProvider>);
  await act(async () => issued.resolve({ token, expiresAt: readiness.observedAt }));
  assert.equal((screen.getByTestId("camp-worker-api") as HTMLInputElement).value, "");
  assert.equal(screen.queryByTestId("camp-worker-env-download"), null); assert.equal(document.querySelector('input[type="password"]'), null);
  assert.ok(screen.getByRole("button", { name: "Issue worker credential" }));
});

test("the setup guide keeps posting permissions and queued goal admission independent from worker self-reports", async () => {
  const snapshot: CampSnapshot = { room: { ...room, verificationPolicy: { digest, policy: { id: "tests", revision: 1, name: "Tests", maxRepairAttempts: 1, checks: [{ id: "tests", label: "Node tests", argv: ["node", "--test"], timeoutMs: 1000 }] } } }, setup, goals: [], runs: [], tasks: [], events: [], canSubmit: true, canManage: false, roomBusy: false };
  let submitted = 0;
  campApi.roomForChannel = async () => snapshot.room; campApi.snapshot = async () => snapshot;
  campApi.submit = async () => { submitted++; };
  renderWithIntl(<CampRoomPanel channel={{ id: room.channelId, name: room.name, type: "channel", description: null, createdAt: readiness.observedAt }} />);
  await waitFor(() => assert.ok(screen.getByTestId("camp-room-setup")));
  assert.ok(screen.getByText(/No worker self-check has been reported/)); assert.equal(screen.queryByRole("button", { name: "Issue worker credential" }), null);
  const field = screen.getByRole("textbox", { name: "Give the team a goal" }); fireEvent.change(field, { target: { value: "Queue until a worker connects" } });
  fireEvent.submit(field.closest("form")!); await waitFor(() => assert.equal(submitted, 1));
});

test("a verification-only or old-project report cannot mark agent setup complete", () => {
  const snapshot: CampSnapshot = { room, setup: { ...setup, readiness: { ...readiness, report: { ...report, mode: "verification" } } }, goals: [], runs: [], tasks: [], events: [] };
  const view = renderWithIntl(<CampRoomSetup snapshot={snapshot} canManage={false} onChanged={() => {}} />);
  assert.equal(screen.getByTestId("camp-setup-step-worker").getAttribute("data-complete"), "false");
  view.rerender(<TestIntlProvider><CampRoomSetup snapshot={{ ...snapshot, setup: { ...setup, readiness } }} canManage={false} onChanged={() => {}} /></TestIntlProvider>);
  assert.equal(screen.getByTestId("camp-setup-step-worker").getAttribute("data-complete"), "true");
});
