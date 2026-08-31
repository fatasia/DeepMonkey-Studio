import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { buildIndustrialStudyContext } from "./industrialStudyFingerprints";

describe("industrial Study scene fingerprints", () => {
  it("ignores transient selection but detects model and scene version changes", () => {
    const scene = sceneFixture();
    const baseline = buildIndustrialStudyContext(scene, "engine", "1.0.0");
    const selectionChanged = buildIndustrialStudyContext(
      { ...scene, selectedModelId: "model-2" },
      "engine",
      "1.0.0",
    );
    const modelChanged = buildIndustrialStudyContext(
      { ...scene, models: [{ ...scene.models[0]!, opacity: 0.5 }] },
      "engine",
      "1.0.0",
    );
    const versionChanged = buildIndustrialStudyContext(
      { ...scene, updatedAt: "2026-08-31T09:00:00.000Z" },
      "engine",
      "1.0.0",
    );

    expect(selectionChanged).toEqual(baseline);
    expect(modelChanged.sceneFingerprint).not.toBe(baseline.sceneFingerprint);
    expect(modelChanged.modelFingerprint).not.toBe(baseline.modelFingerprint);
    expect(versionChanged.sceneFingerprint).toBe(baseline.sceneFingerprint);
    expect(versionChanged.versionFingerprint).not.toBe(baseline.versionFingerprint);
  });
});

function sceneFixture(): SceneSnapshot {
  return {
    schemaVersion: 1,
    id: "scene-1",
    projectId: "project-1",
    name: "工位",
    camera: { position: { x: 4, y: 3, z: 4 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [{
      modelId: "model-1",
      name: "机器人",
      visible: true,
      opacity: 1,
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }],
    primitives: [],
    measurements: [],
    createdAt: "2026-08-31T08:00:00.000Z",
    updatedAt: "2026-08-31T08:00:00.000Z",
  };
}
