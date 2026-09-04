import { describe, expect, it } from "vitest";
import { isDirectOptimizerInput, optimizedAssetFile } from "./modelOptimizerAssets";

describe("model optimizer asset pipeline", () => {
  it("keeps GLB and glTF local while routing other formats through conversion", () => {
    expect(isDirectOptimizerInput(new File([], "line.GLB"))).toBe(true);
    expect(isDirectOptimizerInput(new File([], "plant.ifc"))).toBe(false);
  });

  it("creates a stable optimized project asset name", () => {
    expect(optimizedAssetFile("assembly.step", new Uint8Array([1])).name).toBe("assembly.optimized.glb");
  });
});
