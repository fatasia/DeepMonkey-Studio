import { describe, expect, it } from "vitest";
import { pbrVisibilityInput } from "./pbrVisibilityInput.js";
import { cameraFrustum } from "./pbrFrusta.js";
import type { RenderView } from "./pbrRendererTypes.js";
describe("PBR visibility camera input", () => {
  it("shares physical viewport and stable camera between culling and LOD", () => {
    const view = { eye: [1,2,3], target: [0,0,0], up: [0,1,0] } as unknown as RenderView;
    const projection = { verticalFovRadians: 1, near: 0.1, far: 100 };
    const result = pbrVisibilityInput(view, projection, 1600, 900, true);
    expect(result.frustum).toEqual(cameraFrustum(view.eye, view.target, view.up, 1600 / 900, projection));
    expect(result.lod).toMatchObject({ camera: { position: [1,2,3], forward: [-1,-2,-3], near: 0.1, far: 100 },
      viewport: { width: 1600, height: 900 }, cameraJump: true });
    expect(result.lod.frustum).toBe(result.frustum); expect(result.lod).not.toHaveProperty("budget");
  });
});
