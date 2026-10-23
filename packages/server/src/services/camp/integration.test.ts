import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { parseIntegrationInput, serializeIntegrationInput } from "../../../../camp-protocol/src/index.js";
import { goalIntegrationSnapshot, integrationGatePassed } from "./integration";

const base = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "layer", refId: `32${"a".repeat(64)}`, layerId: `32${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` } as const;
const input = parseIntegrationInput({ schemaVersion: 1, algorithm: "layerfs-three-way-v1", policy: "reject-overlap-v1", base, parents: ["alpha", "beta"].map((key, index) => ({ key, runId: `00000000-0000-4000-8000-00000000000${index}`, epoch: 1, candidate: base })) });
const digest = createHash("sha256").update(serializeIntegrationInput(input)).digest("hex");
const operation = { id: "op", goalId: "goal", goalAttempt: 1, kind: "integration", status: "completed", integrationInput: input, inputDigest: digest, integrationReport: { schemaVersion: 1 as const, algorithm: input.algorithm, policy: input.policy, inputDigest: digest, status: "merged" as const, candidate: base, conflicts: [], truncated: false, operationId: "op", runId: "run", integratedAt: new Date(0).toISOString() } };
const goal = { id: "goal", attempt: 1, planMode: "same_baseline_pair", baseCandidate: base, reviewedItems: Object.fromEntries(input.parents.map(parent => [parent.key, { ...parent, reviewRunId: "review" }])) } as Parameters<typeof integrationGatePassed>[0];

test("the integration gate requires exact goal, attempt, immutable input digest and both reviewed producer epochs", () => {
  assert.equal(integrationGatePassed(goal, [operation]), true);
  assert.equal(integrationGatePassed({ ...goal, integrationInspectionRequired: true }, [operation]), false);
  for (const changed of [{ ...operation, goalId: "other" }, { ...operation, goalAttempt: 2 }, { ...operation, status: "running" }, { ...operation, inputDigest: "f".repeat(64) }, { ...operation, integrationReport: { ...operation.integrationReport, operationId: "other" } }, { ...operation, integrationInput: { ...input, parents: [input.parents[1], input.parents[0]] as typeof input.parents } }]) assert.equal(integrationGatePassed(goal, [changed]), false);
  assert.equal(integrationGatePassed({ ...goal, reviewedItems: { ...goal.reviewedItems, alpha: { ...goal.reviewedItems.alpha, epoch: 2 } } }, [operation]), false);
  assert.equal(integrationGatePassed(goal, [operation, operation]), false);
});


test("stopped pair goals without an integration report are not advertised as future runnable work", async () => {
  for (const planMode of ["same_baseline_pair", "parallel_pair"] as const) {
    for (const status of ["completed", "cancelled", "needs_attention"] as const) assert.equal((await goalIntegrationSnapshot({ ...goal, planMode, status }, [])).status, "not_run");
    for (const status of ["queued", "running", "waiting_question"] as const) assert.equal((await goalIntegrationSnapshot({ ...goal, planMode, status }, [])).status, "pending");
    assert.equal((await goalIntegrationSnapshot({ ...goal, planMode, status: "cancelled" }, [operation])).status, "merged", "Stopping a goal cannot erase an existing integration fact");
  }
  assert.equal((await goalIntegrationSnapshot({ ...goal, planMode: "sequential", status: "cancelled" }, [])).status, "not_required");
});
