import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { compileScenePlantModel, connectSceneFlowNodes, createSceneFlowNode } from "./scenePlantModel";
import { validatePlantLiteModel } from "@bim-studio/plant-lite-simulation";

function fixture() {
  const nodes = [createSceneFlowNode("source-object", "来料", "source", "source"), createSceneFlowNode("queue-object", "等待", "queue-buffer", "queue"), createSceneFlowNode("station-object", "处理", "station", "station"), createSceneFlowNode("sink-object", "产出", "sink", "sink")];
  let entities = connectSceneFlowNodes(nodes, "source-object", "queue-object");
  entities = connectSceneFlowNodes(entities, "queue-object", "station-object");
  entities = connectSceneFlowNodes(entities, "station-object", "sink-object");
  return { scene: { id: "scene", name: "物流", simulationEntities: entities } as SceneSnapshot, resolve: (id: string) => ({ x: nodes.findIndex(node => node.targetModelId === id) * 3, y: 0, z: 0 }) };
}
describe("scene Plant Lite model bridge", () => {
  it("compiles explicitly linked object roles into existing validated DES inputs and an immutable binding snapshot", () => {
    const { scene, resolve } = fixture(); const before = structuredClone(scene);
    const result = compileScenePlantModel(scene, resolve);
    expect(result.errors).toEqual([]);
    expect(result.model.nodes.map(node => node.kind)).toEqual(["source", "queue-buffer", "station", "sink"]);
    expect(result.model.sceneBinding?.nodes[1]).toEqual({ nodeId: "queue", objectId: "queue-object", position: [3, 0, 0] });
    expect(result.model.edges).toHaveLength(3); expect(scene).toEqual(before);
    result.model.nodes[0]!.name = "runtime-copy"; expect(scene).toEqual(before);
  });
  it("never auto-connects roles, default-binds missing anchors, or silently accepts stale references", () => {
    const { scene, resolve } = fixture();
    expect(compileScenePlantModel({ ...scene, simulationEntities: scene.simulationEntities?.filter(entity => entity.kind === "flowNode") ?? [] }, resolve).errors.length).toBeGreaterThan(0);
    expect(compileScenePlantModel(scene, () => undefined).errors.join()).toContain("场景对象已删除或尚未载入");
    expect(compileScenePlantModel(scene, () => ({ x: Infinity, y: 0, z: 0 })).errors.length).toBeGreaterThan(0);
    expect(() => connectSceneFlowNodes(scene.simulationEntities!, "source-object", "missing")).toThrow();
    expect(connectSceneFlowNodes(scene.simulationEntities!, "source-object", "queue-object")).toBe(scene.simulationEntities);
  });
  it("rejects duplicate object roles and invalid queue/distribution values through the existing validator", () => {
    const { scene, resolve } = fixture();
    const duplicate = createSceneFlowNode("source-object", "重复", "sink", "duplicate");
    expect(compileScenePlantModel({ ...scene, simulationEntities: [...scene.simulationEntities!, duplicate] }, resolve).errors.join()).toContain("每个场景对象只能绑定一个物流角色");
    const node = scene.simulationEntities?.find(entity => entity.id === "queue");
    if (node?.kind === "flowNode" && node.node.kind === "queue-buffer") node.node.capacity = -1;
    expect(compileScenePlantModel(scene, resolve).errors.length).toBeGreaterThan(0);
  });
  it("keeps legacy DES models valid but rejects corrupted evidence bindings", () => {
    const { scene, resolve } = fixture(); const { model } = compileScenePlantModel(scene, resolve);
    const { sceneBinding, ...legacy } = model; expect(validatePlantLiteModel(legacy).valid).toBe(true);
    expect(validatePlantLiteModel({ ...model, sceneBinding: { ...sceneBinding, nodes: [] } }).valid).toBe(false);
  });
});
