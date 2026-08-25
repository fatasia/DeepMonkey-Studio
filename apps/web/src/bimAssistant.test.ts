import { describe, expect, it } from "vitest";
import type { ComponentRecord } from "./viewer/analysis";
import { associateSpace, evaluatePlacement, parseRequestedSize, planBimQuestion, type BimAssistantComponentEvidence } from "./bimAssistant";

function record(id: string, name: string, category: string, extra = ""): ComponentRecord {
  return { id, stableId: `model:${id}`, modelId: "model", modelName: "测试楼", name, type: category, category, path: id, properties: {}, searchText: `${name} ${category} ${extra}`.toLowerCase() };
}

describe("BIM assistant semantic tools", () => {
  it("recognizes common BIM aliases and counts all matching cameras", () => {
    const plan = planBimQuestion("有多少个摄像头？", [record("1", "Camera-01", "Security Camera"), record("2", "监控02", "弱电"), record("3", "门01", "Door")]);
    expect(plan.intents).toContain("count");
    expect(plan.matchCount).toBe(2);
    expect(plan.matches.map((item) => item.id).sort()).toEqual(["1", "2"]);
  });

  it("covers electrical and facility vocabulary in one question", () => {
    const plan = planBimQuestion("F2有哪些配电柜和电缆桥架？", [record("p1", "PDB-01", "Panelboard", "F2"), record("t1", "CT-01", "Cable Tray", "F2"), record("v1", "Valve-01", "Valve", "F2")]);
    expect(plan.matches.map((item) => item.id).sort()).toEqual(["p1", "t1"]);
  });

  it("respects an explicit level scope in preset questions", () => {
    const plan = planBimQuestion("F2 有哪些配电柜和电缆桥架？", [record("p1", "PDB-F1", "Panelboard", "F1"), { ...record("p2", "PDB-F2", "Panelboard", "F2"), level: "F2" }, { ...record("t2", "CT-F2", "Cable Tray", "F2"), level: "F2" }]);
    expect(plan.matches.map((item) => item.id).sort()).toEqual(["p2", "t2"]);
  });

  it("parses mixed metric placement dimensions", () => {
    expect(parseRequestedSize("A和B之间能否放下 1200mm × 80cm × 2m 的设备"))
      .toEqual({ length: 1.2, width: 0.8, height: 2 });
  });

  it("associates a component with the smallest containing BIM space", () => {
    const bounds = { min: { x: 2, y: 0, z: 2 }, max: { x: 3, y: 1, z: 3 }, center: { x: 2.5, y: 0.5, z: 2.5 }, size: { x: 1, y: 1, z: 1 } };
    const space = associateSpace(bounds, "model", [
      { id: "floor", modelId: "model", modelName: "测试楼", name: "整层", level: "F1", kind: "Room", bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 4, z: 20 } } },
      { id: "room", modelId: "model", modelName: "测试楼", name: "控制室", level: "F1", kind: "Room", bounds: { min: { x: 1, y: 0, z: 1 }, max: { x: 5, y: 3, z: 5 } } }
    ]);
    expect(space?.id).toBe("room");
  });

  it("performs a deterministic AABB clearance precheck", () => {
    const component = (id: string, minX: number, maxX: number): BimAssistantComponentEvidence => ({
      id, stableId: `model:${id}`, modelId: "model", modelName: "测试楼", name: id, type: "Equipment", properties: {},
      bounds: { min: { x: minX, y: 0, z: 0 }, max: { x: maxX, y: 3, z: 3 }, center: { x: (minX + maxX) / 2, y: 1.5, z: 1.5 }, size: { x: maxX - minX, y: 3, z: 3 } }
    });
    const result = evaluatePlacement({ length: 1.2, width: 0.8, height: 2 }, [component("A", 0, 1), component("B", 3, 4)]);
    expect(result.status).toBe("fits");
    expect(result.availableGapMetres).toBe(2);
    expect(result.clearanceMetres).toBeCloseTo(1.2);
  });
});
