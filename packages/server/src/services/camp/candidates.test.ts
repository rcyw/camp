import assert from "node:assert/strict";
import { test } from "vitest";
import { selectDependencyCandidate } from "./candidates";

const candidate = { type: "layerfs", projectId: "p-0123456789abcdef", refKind: "commit", refId: `12${"a".repeat(64)}`, commitId: `12${"a".repeat(64)}`, rootId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}` } as const;
test("dependency annotations may repeat one immutable parent but cannot select the last of conflicting parents", () => {
  assert.equal(selectDependencyCandidate([{ type: "file", path: "note" }]), null);
  assert.deepEqual(selectDependencyCandidate([candidate, { ...candidate, branch: "another-label" }]), candidate);
  for (const patch of [{ projectId: "p-fedcba9876543210" }, { refId: `12${"d".repeat(64)}`, commitId: `12${"d".repeat(64)}` }, { rootId: "e".repeat(64) }, { imageId: `sha256:${"f".repeat(64)}` }]) assert.throws(() => selectDependencyCandidate([candidate, { ...candidate, ...patch }]), { code: "ambiguous_input_candidate" });
});
