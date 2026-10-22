import { describe, expect, it } from "vitest";
import { parseCampGoal } from "../src/components/camp/campCommand";

describe("explicit Camp execution commands", () => {
  it("does not turn ordinary conversation, mentions or similar prefixes into paid work", () => {
    for (const text of ["Please fix the build", "@planner investigate", "/campaign launch", "Explain /camp", "/camping"]) {
      expect(parseCampGoal(text)).toBeNull();
    }
  });
  it("keeps the complete multiline acceptance criteria", () => {
    expect(parseCampGoal("  /camp Fix the bug\n\nKeep the existing API.\n")).toBe("Fix the bug\n\nKeep the existing API.");
  });
  it("identifies an empty command so the composer can reject it without losing the draft", () => {
    expect(parseCampGoal("/camp")).toBe("");
    expect(parseCampGoal("/camp \n")).toBe("");
  });
});
