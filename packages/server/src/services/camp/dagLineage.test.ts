import assert from "node:assert/strict";
import { test } from "vitest";
import type { CampCandidate } from "../../../../camp-protocol/src/index.js";
import { resolveCandidateSources } from "./dagLineage";
const candidate = (n: number): CampCandidate => ({ type: "layerfs", projectId: "p-0123456789abcdef", refKind: "commit", refId: `12${n.toString(16).padStart(64, "0")}`, commitId: `12${n.toString(16).padStart(64, "0")}`, rootId: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}` });
const source = (key: string, value: CampCandidate) => ({ key, runId: `00000000-0000-4000-8000-${key === "left" ? "1" : "2"}`.padEnd(36, "0"), epoch: 1, candidate: value });
const graph = (rows: Array<[CampCandidate, CampCandidate[]]>) => new Map(rows.map(([value, parents]) => [value.refId, { candidate: value, parents: new Set(parents.map(parent => parent.refId)) }]));
test("candidate identity, not tree-root equality, controls passthrough and unique shared merge base selection", () => {
  const [base, a, b, merged, c, d] = [0, 1, 2, 3, 4, 5].map(candidate);
  const history = graph([[base, []], [a, [base]], [b, [base]], [merged, [a, b]], [c, [merged]], [d, [merged]]]);
  assert.equal(resolveCandidateSources(history, base, [source("left", a), source("right", a)]).resolution, "same_ref");
  assert.equal(resolveCandidateSources(history, base, [source("left", base), source("right", a)]).candidate?.refId, a.refId);
  const siblings = resolveCandidateSources(history, base, [source("left", a), source("right", b)]); assert.equal(siblings.resolution, "integration"); assert.equal(siblings.mergeBase?.refId, base.refId, "Equal root hashes never collapse distinct native references");
  assert.equal(resolveCandidateSources(history, base, [source("left", c), source("right", d)]).mergeBase?.refId, merged.refId, "A previous two-parent integration can itself be the exact new common base");
});
test("criss-cross provenance refuses ambiguous maximal ancestors instead of selecting a deterministic but unjustified side", () => {
  const [base, a, b, left, right] = [0, 1, 2, 3, 4].map(candidate), history = graph([[base, []], [a, [base]], [b, [base]], [left, [a, b]], [right, [b, a]]]);
  assert.throws(() => resolveCandidateSources(history, base, [source("left", left), source("right", right)]), { code: "dag_merge_base_ambiguous" });
  assert.throws(() => resolveCandidateSources(history, base, [source("left", a), source("right", { ...a, rootId: "c".repeat(64) })]), { code: "dag_lineage_invalid" });
});
