import { describe, expect, it } from "vitest";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { createWorkspaceRecoveryDraft, hasRecoverableWorkspaceChanges, isWorkspaceRecoveryDraft, workspaceRecoveryKey } from "./workspaceRecoveryStore";

const timestamp = "2026-08-29T00:00:00.000Z";
const scene: SceneSnapshot = {
  schemaVersion: 1, id: "scene-1", projectId: "project-1", name: "装配线",
  camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
  models: [], primitives: [], measurements: [], createdAt: timestamp, updatedAt: timestamp
};

describe("workspaceRecoveryStore", () => {
  it("creates a project/application/scene isolated recovery record", () => {
    const application = migrateSceneSnapshotV1(scene);
    application.metadata.revision = 7;
    const draft = createWorkspaceRecoveryDraft("project-1", application, scene, timestamp);

    expect(draft).toMatchObject({ key: "project-1:scene-1:scene-1", baseRevision: 7, savedAt: timestamp });
    expect(isWorkspaceRecoveryDraft(draft)).toBe(true);
    expect(workspaceRecoveryKey("project-1", undefined, "scene-1")).toBe("project-1:legacy:scene-1");
  });

  it("rejects corrupt records before they reach the editor", () => {
    expect(isWorkspaceRecoveryDraft({ schemaVersion: 1, key: "x", projectId: "p", sceneId: "s", savedAt: timestamp, scene: { schemaVersion: 1, id: "other" } })).toBe(false);
  });

  it("does not prompt when only the server timestamp changed", () => {
    const draft = createWorkspaceRecoveryDraft("project-1", undefined, scene);
    expect(hasRecoverableWorkspaceChanges(draft, { ...scene, updatedAt: "2026-08-29T01:00:00.000Z" })).toBe(false);
    expect(hasRecoverableWorkspaceChanges(draft, { ...scene, name: "装配线 B" })).toBe(true);
  });
});
