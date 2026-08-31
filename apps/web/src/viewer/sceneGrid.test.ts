import { describe, expect, it } from "vitest";
import { sceneGridLayout } from "./sceneGrid";

describe("sceneGridLayout", () => {
  it("keeps a ten-to-one major/minor hierarchy on a bounded industrial plane", () => {
    const layout = sceneGridLayout();

    expect(layout.worldSize).toBe(200);
    expect(layout.textureSize).toBeGreaterThanOrEqual(1024);
    expect(layout.majorStep / layout.minorStep).toBe(10);
    expect(layout.worldSize % layout.majorStep).toBe(0);
  });
});
