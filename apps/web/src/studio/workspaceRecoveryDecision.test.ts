import { describe, expect, it } from "vitest";
import { workspaceRecoveryDecisionKey } from "./workspaceRecoveryDecision";

describe("workspace recovery decision ownership", () => {
  const draft = { projectId: "p", applicationId: "a", sceneId: "s", savedAt: "2026-09-05T15:00:00.000Z" };
  it("only identifies the exact draft and does not suppress a later recovery snapshot", () => {
    expect(workspaceRecoveryDecisionKey(draft)).toBe(workspaceRecoveryDecisionKey({ ...draft }));
    expect(workspaceRecoveryDecisionKey(draft)).not.toBe(workspaceRecoveryDecisionKey({ ...draft, savedAt: "2026-09-05T15:00:01.000Z" }));
  });
  it("cannot leak a decision across project, application or scene even with the same timestamp", () => {
    for (const field of ["projectId", "applicationId", "sceneId"] as const) {
      expect(workspaceRecoveryDecisionKey(draft)).not.toBe(workspaceRecoveryDecisionKey({ ...draft, [field]: "other" }));
    }
    expect(undefined).not.toBe(workspaceRecoveryDecisionKey(draft));
  });
});
