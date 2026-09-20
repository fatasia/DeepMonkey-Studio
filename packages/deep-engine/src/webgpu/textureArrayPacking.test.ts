import { describe, expect, it } from "vitest";
import { planTextureArrays } from "./textureArrayPacking.js";

const entry = (id: string, format = "rgba8unorm", width = 512, height = 512) =>
  ({ textureId: id, format, width, height });

describe("texture array packing", () => {
  it("bins by format and dimensions with deterministic layer assignment", () => {
    const plan = planTextureArrays({ maxArrayLayers: 8, entries: [
      entry("t-c", "rgba8unorm"), entry("t-a", "rgba16float"), entry("t-b", "rgba8unorm"),
      entry("t-half", "rgba8unorm", 256, 256),
    ] });
    expect(plan.arrays).toHaveLength(3);
    const rgba8 = plan.arrays.find(array => array.format === "rgba8unorm" && array.width === 512)!;
    expect(rgba8.layers).toEqual(["t-b", "t-c"]); // 字典序
    expect(plan.assignments.get("t-b")).toEqual({ arrayIndex: rgba8.arrayIndex, layerIndex: 0 });
    expect(plan.assignments.get("t-c")).toEqual({ arrayIndex: rgba8.arrayIndex, layerIndex: 1 });
  });

  it("overflows beyond maxArrayLayers into an explicit fallback list", () => {
    const plan = planTextureArrays({ maxArrayLayers: 2, entries: [
      entry("a"), entry("b"), entry("c"),
    ] });
    expect(plan.overflowed).toEqual(["c"]);
    expect(plan.assignments.has("a")).toBe(true);
    expect(plan.assignments.has("b")).toBe(true);
    expect(plan.assignments.has("c")).toBe(false);
  });

  it("rejects invalid entries fail-closed", () => {
    expect(() => planTextureArrays({ maxArrayLayers: 4, entries: [entry(""), entry("ok")] })).toThrow(TypeError);
    expect(() => planTextureArrays({ maxArrayLayers: 4, entries: [entry("bad", "rgba8unorm", 0, 8)] })).toThrow(RangeError);
    expect(() => planTextureArrays({ maxArrayLayers: 0, entries: [entry("a")] })).toThrow(RangeError);
  });

  it("handles empty input and identical ids across boxes independently", () => {
    const plan = planTextureArrays({ maxArrayLayers: 4, entries: [] });
    expect(plan.arrays).toHaveLength(0);
    expect(plan.overflowed).toHaveLength(0);
    const shared = planTextureArrays({ maxArrayLayers: 4, entries: [entry("shared", "rgba8unorm"), entry("shared", "rgba16float")] });
    // 同 id 不同格式进不同箱，各自分配互不影响。
    expect(shared.assignments.get("shared")).toEqual({ arrayIndex: 1, layerIndex: 0 });
  });
});
