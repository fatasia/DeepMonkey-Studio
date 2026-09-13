import { describe, expect, it } from "vitest";
import { threeRenderView } from "./threeRenderView.js";

const source = {
  camera: { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1] }, fov: 60, zoom: 1, near: 0.05, far: 10_000 },
  target: [0, 1, 0] as const, width: 1600, height: 900, pixelRatio: 2, extent: 40,
  background: [0.01, 0.02, 0.03] as const, floor: [0.1, 0.1, 0.1] as const, exposure: 1.1, roughness: 0.5,
};

describe("Three RenderView adapter", () => {
  it("preserves world camera position and converts fov degrees to radians", () => {
    expect(threeRenderView(source)).toMatchObject({
      eye: [4, 5, 6], up: [0, 1, 0], target: [0, 1, 0], width: 1600, height: 900, near: 0.05, far: 10_000,
      verticalFovRadians: Math.PI / 3,
    });
  });

  it("accounts for Three camera zoom and rejects malformed matrices", () => {
    expect(threeRenderView({ ...source, camera: { ...source.camera, zoom: 2 } }).verticalFovRadians)
      .toBeCloseTo(2 * Math.atan(Math.tan(Math.PI / 6) / 2));
    expect(() => threeRenderView({ ...source, camera: { ...source.camera, matrixWorld: { elements: [1] } } })).toThrow("matrixWorld");
    expect(() => threeRenderView({ ...source, camera: { ...source.camera, near: 10, far: 1 } })).toThrow("projection");
  });
});
