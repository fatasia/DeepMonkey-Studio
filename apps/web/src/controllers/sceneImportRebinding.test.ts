import { describe, expect, it } from "vitest";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { rebindImportedSceneModels } from "./sceneImportRebinding";

const targetProject = {
  id: "project-target",
  name: "目标项目",
  models: [{
    id: "model-new",
    projectId: "project-target",
    name: "pump.glb",
    format: "glb",
    size: 100,
    status: "ready",
    progress: 100,
    sourceUrl: "/pump.glb",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z"
  }],
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z"
} as ProjectRecord;

function sceneFixture(): SceneSnapshot {
  return {
    schemaVersion: 1,
    id: "scene-imported",
    projectId: "project-source",
    name: "导入场景",
    camera: {
      position: { x: 1, y: 2, z: 3 },
      target: { x: 0, y: 0, z: 0 },
      mode: "orbit"
    },
    models: [{
      modelId: "model-old",
      name: "泵",
      sourceName: "pump.glb",
      sourceFormat: "glb",
      visible: true,
      locked: false,
      opacity: 1,
      effects: [],
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 }
      },
      collisionEnabled: false,
      explosionFactor: 0,
      explosionMode: "radial",
      layers: []
    }],
    primitives: [],
    measurements: [],
    animation: {
      duration: 10,
      loop: false,
      camera: [],
      models: [{
        id: "keyframe-1",
        modelId: "model-old",
        time: 1,
        position: { x: 1, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 }
      }]
    },
    annotations: [{ id: "annotation-1", title: "温度", position: { x: 0, y: 1, z: 0 }, modelId: "model-old", color: "#fff", visible: true }],
    floors: [{ id: "floor-1", modelId: "model-old", name: "一层", visible: true, elevation: 0 }],
    selectionSets: [{ id: "set-1", name: "设备", objectIds: ["model-old"], createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z" }],
    selectedModelId: "model-old",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z"
  } as unknown as SceneSnapshot;
}

describe("scene import model rebinding", () => {
  it("updates every model reference using the resolved target asset", () => {
    const scene = sceneFixture();
    scene.simulationEntities = [
      { id: "flow", kind: "flowLink", fromModelId: "model-old", toModelId: "primitive" },
      { id: "path", kind: "path", name: "路径", targetModelId: "model-old", points: [[0, 0, 0]], speed: 1, loopMode: "once" },
      { id: "pair", kind: "collisionPair", name: "碰撞", a: { modelId: "model-old", layerId: "part" }, b: { modelId: "missing" }, tolerance: 0.1 },
      { id: "source", kind: "flowNode", targetModelId: "model-old", node: { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } } },
    ];
    const result = rebindImportedSceneModels(scene, targetProject, new Map());

    expect(result.missingModelCount).toBe(0);
    expect(result.scene.models[0]?.modelId).toBe("model-new");
    expect(result.scene.animation?.models[0]?.modelId).toBe("model-new");
    expect(result.scene.annotations?.[0]?.modelId).toBe("model-new");
    expect(result.scene.floors?.[0]?.modelId).toBe("model-new");
    expect(result.scene.selectionSets?.[0]?.objectIds).toEqual(["model-new"]);
    expect(result.scene.selectedModelId).toBe("model-new");
    expect(result.scene.simulationEntities).toMatchObject([
      { fromModelId: "model-new", toModelId: "primitive" }, { targetModelId: "model-new" },
      { a: { modelId: "model-new", layerId: "part" }, b: { modelId: "missing" } },
      { targetModelId: "model-new", node: { id: "source" } },
    ]);
    expect(scene.simulationEntities[0]).toMatchObject({ fromModelId: "model-old" });
  });

  it("keeps unresolved references and reports the missing asset", () => {
    const scene = sceneFixture();
    scene.models[0] = { ...scene.models[0]!, sourceName: "missing.glb" };

    const result = rebindImportedSceneModels(scene, targetProject, new Map());

    expect(result.missingModelCount).toBe(1);
    expect(result.scene.models[0]?.modelId).toBe("model-old");
  });
});
