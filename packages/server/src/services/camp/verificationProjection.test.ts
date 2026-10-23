import assert from "node:assert/strict";
import { test } from "vitest";
import { goalVerificationSnapshot, latestVerificationOperation, verificationGatePassed } from "./verification";

const candidate = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "layer", refId: `32${"a".repeat(64)}`, layerId: `32${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` } as const;
const digest = "d".repeat(64);
const receipt = { candidate, policyDigest: digest, status: "passed" as const };
const passed = { id: "0001", createdAt: new Date(0), inputCandidate: candidate, policyDigest: digest, status: "completed", receipt };
test("verification read projections and write gates select the newest exact candidate and policy deterministically", () => {
  const queued = { ...passed, id: "0002", receipt: null, status: "queued" };
  const wrongPolicy = { ...passed, id: "0003", policyDigest: "e".repeat(64) };
  const wrongCandidate = { ...passed, id: "0004", inputCandidate: { ...candidate, rootId: "f".repeat(64) } };
  const latest = latestVerificationOperation([wrongCandidate, passed, wrongPolicy, queued], candidate, digest);
  assert.equal(latest?.id, queued.id); assert.equal(verificationGatePassed(latest, candidate, digest), false);
  assert.equal(verificationGatePassed(passed, candidate, digest), true);
  assert.equal(verificationGatePassed(wrongPolicy, candidate, digest), false);
  assert.equal(verificationGatePassed(wrongCandidate, candidate, digest), false);
  assert.equal(verificationGatePassed({ ...passed, receipt: { ...receipt, policyDigest: "e".repeat(64) } }, candidate, digest), false);
});

test("verification without an operation is not_run only after the goal stops, while existing operation facts remain authoritative", async () => {
  const goal = { id: "goal", roomId: "room", attempt: 1, workflow: "serial", protocolVersion: 2, currentCandidate: candidate, verificationRepairs: 0, verificationPolicy: { digest, policy: { maxRepairAttempts: 1 } } } as Parameters<typeof goalVerificationSnapshot>[0];
  for (const status of ["queued", "running", "waiting_question", "cancelling"] as const) assert.equal((await goalVerificationSnapshot({ ...goal, status }, [])).status, "pending");
  for (const status of ["completed", "cancelled", "needs_attention"] as const) assert.equal((await goalVerificationSnapshot({ ...goal, status }, [])).status, "not_run");
  assert.equal((await goalVerificationSnapshot({ ...goal, protocolVersion: 1, status: "cancelled" }, [])).status, "not_required");
  for (const [status, expected] of [["completed", "passed"], ["running", "running"], ["failed", "failed"], ["cancelled", "cancelled"], ["blocked", "blocked"], ["queued", "pending"]]) {
    const operations = [{ ...passed, kind: "verification", goalId: goal.id, goalAttempt: goal.attempt, status }] as Parameters<typeof goalVerificationSnapshot>[1];
    assert.equal((await goalVerificationSnapshot({ ...goal, status: "cancelled" }, operations)).status, expected);
  }
});
