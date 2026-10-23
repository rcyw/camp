import assert from "node:assert/strict";
import { test } from "vitest";
import { completionFingerprint } from "./completionFingerprint";

test("completion fingerprints sort object keys deeply but preserve array order and normalized defaults", () => {
  const first = { status: "completed" as const, summary: "Result", artifacts: [{ type: "file", detail: { a: 1, b: [{ z: 2, y: 3 }] } }] };
  const reordered = { summary: "Result", status: "completed" as const, artifacts: [{ detail: { b: [{ y: 3, z: 2 }], a: 1 }, type: "file" }] };
  assert.equal(completionFingerprint(first), completionFingerprint(reordered));
  assert.equal(completionFingerprint({ status: "failed", summary: "Stopped" }), completionFingerprint({ status: "failed", summary: "Stopped", artifacts: [] }));
  assert.notEqual(completionFingerprint(first), completionFingerprint({ ...first, summary: "Changed" }));
  assert.notEqual(completionFingerprint({ ...first, artifacts: [{ type: "file", values: [1, 2] }] }), completionFingerprint({ ...first, artifacts: [{ type: "file", values: [2, 1] }] }));
});

test("integration adds no new fingerprint field to historical agent and verifier payloads", () => {
  // Frozen before protocol 3. New deployment binaries must replay the exact
  // existing outbox without changing hashes merely because a field was added.
  assert.equal(completionFingerprint({ status: "failed", summary: "Stopped" }), "17c3caab3c4590694bbf4209e15157759637553caefa1c868d16bf9087e78ae8");
  const report = { schemaVersion: 1 as const, algorithm: "layerfs-three-way-v1" as const, policy: "reject-overlap-v1" as const, inputDigest: "a".repeat(64), status: "conflict" as const, candidate: null, conflicts: [{ path: "shared.txt", reason: "overlap" as const }], truncated: false };
  const payload = { status: "completed" as const, summary: "Integration conflict", integration: report };
  assert.notEqual(completionFingerprint(payload), completionFingerprint({ status: "completed", summary: payload.summary }));
  assert.notEqual(completionFingerprint(payload), completionFingerprint({ ...payload, integration: { ...report, inputDigest: "b".repeat(64) } }));
  assert.equal(completionFingerprint(payload), completionFingerprint({ ...payload, integration: { ...report, conflicts: [{ reason: "overlap", path: "shared.txt" }] } }));
});
