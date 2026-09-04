import { describe, expect, it } from "vitest";
import { validateSimulationEntities } from "./simulationEntities.js";

const modelIds = new Set(["m1", "m2"]);

describe("validateSimulationEntities", () => {
  it("accepts valid flow links, paths and collision pairs", () => {
    const errors = validateSimulationEntities([
      { id: "f1", kind: "flowLink", fromModelId: "m1", toModelId: "m2" },
      { id: "p1", kind: "path", name: "巡检路径", targetModelId: "m1", points: [[0, 0, 0]], loopMode: "loop", speed: 1.5 },
      { id: "c1", kind: "collisionPair", name: "碰撞", a: { modelId: "m1" }, b: { modelId: "m2" }, tolerance: 0.05 },
    ], modelIds);
    expect(errors).toEqual([]);
  });

  it("rejects broken model references and self links", () => {
    const errors = validateSimulationEntities([
      { id: "f1", kind: "flowLink", fromModelId: "ghost", toModelId: "m1" },
      { id: "c1", kind: "collisionPair", name: "x", a: { modelId: "m2" }, b: { modelId: "m2" }, tolerance: 0 },
    ], modelIds);
    expect(errors.join("\n")).toContain("源模型 ghost 不存在");
    expect(errors.join("\n")).toContain("两侧相同");
  });

  it("rejects duplicate ids", () => {
    const errors = validateSimulationEntities([
      { id: "same", kind: "flowLink", fromModelId: "m1", toModelId: "m2" },
      { id: "same", kind: "flowLink", fromModelId: "m2", toModelId: "m1" },
    ], modelIds);
    expect(errors.join("\n")).toContain("重复");
  });
});
