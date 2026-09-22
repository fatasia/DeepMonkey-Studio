import { describe, expect, it } from "vitest";
import { selectLayerIds, visibleLayerIds } from "./layerSelection";
describe("layer selection intent", () => {
  it("follows persisted interleaved roots when expanding groups and Shift-selecting", () => {
    const roots = [{ kind: "object" as const, id: "d" }, { kind: "group" as const, id: "g" }, { kind: "object" as const, id: "a" }];
    const groups = [{ id: "g", objectIds: ["b", "c"] }];
    const visible = visibleLayerIds(["a", "b", "c", "d"], groups, new Set(), roots);
    expect(visible).toEqual(["d", "b", "c", "a"]);
    expect(selectLayerIds(visible, ["d"], "c", { range: true }, "d")).toEqual(["d", "b", "c"]);
    expect(visibleLayerIds(["a", "b", "c", "d"], groups, new Set(["g"]), roots)).toEqual(["d", "a"]);
  });
  const order = ["a", "b", "c", "d"];
  it("preserves collapsed selections for additive clicks and additive ranges", () => {
    expect(selectLayerIds(["c", "d"], ["a"], "c", { additive: true })).toEqual(["a", "c"]);
    expect(selectLayerIds(["c", "d"], ["a", "c"], "c", { additive: true })).toEqual(["a"]);
    expect(selectLayerIds(["c", "d"], ["a", "c"], "d", { additive: true, range: true }, "c")).toEqual(["a", "c", "d"]);
    expect(selectLayerIds(["c", "d"], ["a"], "d", { additive: true, range: true }, "a")).toEqual(["a", "d"]);
  });
  it("removes collapsed and search-filtered members before selecting ranges", () => {
    const groups = [{ id: "g", objectIds: ["b", "c"] }];
    expect(visibleLayerIds(order, groups, new Set())).toEqual(["b", "c", "a", "d"]);
    expect(visibleLayerIds(order, groups, new Set(["g"]))).toEqual(["a", "d"]);
    const filtered = visibleLayerIds(["a", "c", "d"], groups, new Set());
    expect(filtered).toEqual(["c", "a", "d"]);
    expect(selectLayerIds(filtered, ["b"], "d", { range: true }, "b")).toEqual(["d"]);
  });
  it("replaces on click and only toggles with additive intent", () => {
    expect(selectLayerIds(order, ["b"], "b")).toEqual(["b"]);
    expect(selectLayerIds(order, ["a"], "c")).toEqual(["c"]);
    expect(selectLayerIds(order, ["a", "c"], "c", { additive: true })).toEqual(["a"]);
  });
  it("uses a stable anchor across consecutive ranges and makes target primary", () => {
    const first = selectLayerIds(order, ["b"], "d", { range: true }, "b");
    expect(first).toEqual(["b", "c", "d"]);
    expect(selectLayerIds(order, first, "a", { range: true }, "b")).toEqual(["b", "a"]);
  });
  it("ranges over supplied visible order and handles missing anchors", () => {
    expect(selectLayerIds(["a", "d"], ["a"], "d", { range: true }, "a")).toEqual(["a", "d"]);
    expect(selectLayerIds(order, ["missing"], "d", { range: true }, "missing")).toEqual(["d"]);
    expect(selectLayerIds(order, ["a"], "missing")).toEqual(["a"]);
  });
  it("unions Ctrl Shift without duplicates", () => {
    expect(selectLayerIds(order, ["a", "c"], "d", { range: true, additive: true }, "c")).toEqual(["a", "c", "d"]);
  });
});
