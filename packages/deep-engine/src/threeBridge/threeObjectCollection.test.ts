import { describe, expect, it, vi } from "vitest";
import { accepted, bridge, mesh } from "./testFixture.js";
import { threeObjectCollection } from "./threeObjectCollection.js";

describe("Three object collection", () => {
  it("projects detached author roots without reparenting or lifecycle calls", () => {
    const a = mesh(), b = mesh(), updateA = vi.spyOn(a, "updateWorldMatrix"), updateB = vi.spyOn(b, "updateWorldMatrix");
    a.position.x = -2; b.position.x = 3;
    a.updateWorldMatrix(true, true); b.updateWorldMatrix(true, true);
    updateA.mockClear(); updateB.mockClear();
    const root = threeObjectCollection([a, b]);
    const result = accepted(bridge().project(root, { cameraLayerMask: 1 }));
    expect(result.packet.instances).toHaveLength(2);
    expect(a.parent).toBeNull(); expect(b.parent).toBeNull();
    expect(updateA).not.toHaveBeenCalled(); expect(updateB).not.toHaveBeenCalled();
    expect(() => (root.children as typeof a[]).push(a)).toThrow();
  });
});
