import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { ComponentRecord } from "./analysis";
import { ModelDiffOverlay } from "./modelDiffOverlay";
import { ViewerEngineModelDiff, type ModelDiffHighlightTarget } from "./viewerEngineModelDiff";

function record(modelId: string, nodeId: string): ComponentRecord {
  return {
    id: nodeId,
    stableId: `${modelId}:${nodeId}`,
    modelId,
    modelName: `模型 ${modelId}`,
    name: nodeId,
    type: "Mesh",
    path: nodeId,
    properties: {},
    searchText: "",
  };
}

/** 只装配被测职责层触达的受保护字段；渲染与加载层全部隔离。 */
function harness() {
  const engine = Object.create(ViewerEngineModelDiff.prototype) as ViewerEngineModelDiff;
  const internals = engine as unknown as Record<string, unknown>;
  internals.models = new Map();
  internals.componentRecords = new Map();
  internals.layerObjects = new Map();
  internals.fragmentLayers = new Map();
  internals.fragmentModels = new Map();
  internals.selectedId = undefined;
  internals.selectedFragmentNodeId = undefined;
  // Object.create 不执行实例字段初始化，职责层私有状态需按生产初值装配。
  internals.diffOverlay = new ModelDiffOverlay();
  internals.diffHighlightVersion = 0;
  internals.diffHighlightFragmentModels = new Set<string>();
  internals.requestRender = vi.fn();
  return engine;
}

function mesh(name: string): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({ color: "#d4a84f" });
  return new THREE.Mesh(new THREE.BoxGeometry(), material);
}

describe("ViewerEngineModelDiff snapshot capture", () => {
  it("clones the live component records so later scene edits cannot mutate a captured snapshot", () => {
    const engine = harness();
    const objects = new Map<string, THREE.Object3D>();
    const model = { id: "instance-a", name: "厂房 v1", object: new THREE.Group(), kind: "model" as const, visible: true, opacity: 1 };
    (engine as unknown as { models: Map<string, unknown> }).models.set("instance-a", model);
    (engine as unknown as { componentRecords: Map<string, ComponentRecord[]> }).componentRecords.set("instance-a", [record("instance-a", "root/0/1")]);

    const snapshot = engine.captureModelDiffSnapshot("instance-a");
    expect(snapshot).toBeDefined();
    expect(snapshot!.modelName).toBe("厂房 v1");
    expect(snapshot!.records[0]!.stableId).toBe("instance-a:root/0/1");

    const live = (engine as unknown as { componentRecords: Map<string, ComponentRecord[]> }).componentRecords.get("instance-a")!;
    live[0]!.name = "被后续编辑改名";
    expect(snapshot!.records[0]!.name).toBe("root/0/1");
  });

  it("returns undefined for unknown or not-yet-indexed instances", () => {
    const engine = harness();
    expect(engine.captureModelDiffSnapshot("missing")).toBeUndefined();
  });
});

describe("ViewerEngineModelDiff highlight", () => {
  it("applies per-kind overlay materials to mesh components and restores them on clear", async () => {
    const engine = harness();
    const added = mesh("new-wall");
    const removed = mesh("old-wall");
    const objects = new Map<string, THREE.Object3D>([["root/1", added], ["root/2", removed]]);
    (engine as unknown as { layerObjects: Map<string, Map<string, THREE.Object3D>> }).layerObjects.set("instance-a", objects);
    const originals = [added.material, removed.material];
    const targets: ModelDiffHighlightTarget[] = [
      { modelId: "instance-a", nodeId: "root/1", kind: "added" },
      { modelId: "instance-a", nodeId: "root/2", kind: "removed" },
    ];

    await engine.setModelDiffHighlight(targets);
    expect(added.material).not.toBe(originals[0]);
    expect(removed.material).not.toBe(originals[1]);
    expect((added.material as THREE.MeshStandardMaterial).transparent).toBe(true);

    engine.clearModelDiffHighlight();
    expect(added.material).toBe(originals[0]);
    expect(removed.material).toBe(originals[1]);
  });

  it("skips node ids that disappeared from the layer index instead of throwing", async () => {
    const engine = harness();
    (engine as unknown as { layerObjects: Map<string, Map<string, THREE.Object3D>> }).layerObjects.set("instance-a", new Map());
    await expect(engine.setModelDiffHighlight([{ modelId: "instance-a", nodeId: "gone", kind: "modified" }])).resolves.toBeUndefined();
    engine.clearModelDiffHighlight();
  });
});
