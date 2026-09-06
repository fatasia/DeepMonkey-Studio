import { describe, expect, it } from "vitest";
import { sceneGridCloseupOpacity, sceneGridLayout } from "./sceneGrid";

describe("sceneGridLayout", () => {
  it("keeps a ten-to-one major/minor hierarchy on a bounded industrial plane", () => {
    const layout = sceneGridLayout();

    expect(layout.worldSize).toBe(200);
    expect(layout.textureSize).toBeGreaterThanOrEqual(1024);
    expect(layout.majorStep / layout.minorStep).toBe(10);
    expect(layout.worldSize % layout.majorStep).toBe(0);
  });

  it("fades meter-wide axes in close-ups without changing physical grid spacing", () => {
    expect(sceneGridCloseupOpacity(0.001)).toBeLessThan(0.001);
    expect(sceneGridCloseupOpacity(0.3)).toBeLessThan(0.04);
    expect(sceneGridCloseupOpacity(8)).toBe(1);
    expect(sceneGridCloseupOpacity(100)).toBe(1);
    expect(sceneGridCloseupOpacity(NaN)).toBe(1);
    expect(sceneGridLayout().minorStep).toBe(1);
  });
});
