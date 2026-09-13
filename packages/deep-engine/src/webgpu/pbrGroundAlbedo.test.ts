import { describe, expect, it } from "vitest";
import { groundGridAlbedo } from "./pbrGroundAlbedo.js";
import { sceneShader } from "./pbrShader.js";

describe("PBR ground grid reflectance", () => {
  it("retains dark-theme line contrast without creating a white grid", () => {
    const dark = [0.01, 0.02, 0.03] as const;
    const result = groundGridAlbedo(dark, 1);
    result.forEach((value, index) => {
      expect(value / dark[index]!).toBeGreaterThan(1.3);
      expect(value / dark[index]!).toBeLessThan(1.32);
      expect(value).toBeLessThan(0.04);
    });
    expect(groundGridAlbedo(dark, 0)).toEqual(dark);
  });

  it("bounds light surfaces and every grid strength while keeping smooth contrast", () => {
    for (let step = 0; step <= 100; step++) for (const grid of [-1, 0, 0.5, 1, 4]) {
      const base = step / 100;
      const [value] = groundGridAlbedo([base, base, base], grid);
      expect(value).toBeGreaterThanOrEqual(base);
      expect(value).toBeLessThanOrEqual(1);
    }
    const light = [0.88, 0.92, 0.96] as const;
    groundGridAlbedo(light, 1).forEach((value, index) => {
      expect(value).toBeGreaterThan(light[index]!);
      expect(value).toBeLessThan(1);
    });
    expect(groundGridAlbedo([1, 1, 1], 1)).toEqual([1, 1, 1]);
  });

  it("constrains authored floor inputs and uses this transfer only for ground shading", () => {
    expect(groundGridAlbedo([-0.5, 1.5, 3], 4)).toEqual([0, 1, 1]);
    expect(groundGridAlbedo([-0.5, 1.5, 3], 4, false)).toEqual([-0.5, 1.5, 3]);
    expect(() => groundGridAlbedo([Number.NaN, 0, 0], 1)).toThrow("finite");
    expect(sceneShader).toContain("groundGridAlbedo(select(baseInput, frame.floor.rgb, ground), grid, ground)");
    expect(sceneShader).not.toContain("base *= select(1.0, 1.0 + 0.32 * grid");
  });
});
