import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { assessWorkspaceRecovery, workspaceRecoveryDecisionKey } from "./workspaceRecoveryDecision";
import { createWorkspaceRecoveryDraft } from "./workspaceRecoveryStore";

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

describe("workspace recovery offer", () => {
  const server: SceneSnapshot = {
    schemaVersion: 1, id: "s", projectId: "p", name: "服务器版本",
    camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [], primitives: [], measurements: [],
    createdAt: "2026-09-09T01:00:00.000Z", updatedAt: "2026-09-09T03:00:00.000Z",
  };

  it("offers different local content even when the server was saved later", () => {
    const local = createWorkspaceRecoveryDraft("p", undefined, { ...server, name: "尚未保存的修改" }, "2026-09-09T02:00:00.000Z");
    expect(assessWorkspaceRecovery(local, server)).toBe("offer");
    expect(assessWorkspaceRecovery(local, server, workspaceRecoveryDecisionKey(local))).toBe("ignore");
    // 刷新会重置当前会话的决定，磁盘副本应再次可恢复。
    expect(assessWorkspaceRecovery(structuredClone(local), server)).toBe("offer");
  });

  it("only discards equivalent content and never applies another workspace's draft", () => {
    const local = createWorkspaceRecoveryDraft("p", undefined, { ...server, updatedAt: "2026-09-09T01:30:00.000Z" });
    expect(assessWorkspaceRecovery(local, server)).toBe("discard-equivalent");
    expect(assessWorkspaceRecovery({ ...local, projectId: "other" }, server)).toBe("ignore");
    expect(assessWorkspaceRecovery({ ...local, sceneId: "other" }, server)).toBe("ignore");
    expect(assessWorkspaceRecovery(undefined, server)).toBe("ignore");
  });
});
