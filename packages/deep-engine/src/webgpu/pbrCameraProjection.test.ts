import { describe, expect, it, vi } from "vitest";
import { CameraFrameHistory } from "./cameraFrameHistory.js";
import { resolvePbrCameraProjection, updatePbrFrameUniforms, type PbrFrameUniformResources } from "./pbrFrameUniforms.js";

const base = {
  eye: [0, 0, 10] as const, target: [0, 0, 0] as const, extent: 10,
  background: [0, 0, 0] as const, floor: [0.1, 0.1, 0.1] as const, exposure: 1, roughness: 0.5,
};

function resources(): PbrFrameUniformResources {
  return {
    frameBuffer: {} as GPUBuffer, outputBuffer: {} as GPUBuffer, groundInstance: {} as GPUBuffer,
    frameData: new Float32Array(88), outputData: new Float32Array(4), groundData: new Float32Array(36),
  };
}

describe("PBR camera projection", () => {
  it("keeps the original defaults and accepts an authored perspective camera", () => {
    expect(resolvePbrCameraProjection(base)).toEqual({
      verticalFovRadians: Math.PI / 4, near: 0.1, far: 200,
    });
    expect(resolvePbrCameraProjection({ ...base, verticalFovRadians: Math.PI / 3, near: 0.05, far: 100_000 }))
      .toEqual({ verticalFovRadians: Math.PI / 3, near: 0.05, far: 100_000 });
  });

  it("uses the same authored projection for frame uniforms and downstream passes", () => {
    const queue = { writeBuffer: vi.fn() } as unknown as GPUQueue;
    const packed = resources();
    const result = updatePbrFrameUniforms(queue, new CameraFrameHistory(), {
      ...base, verticalFovRadians: Math.PI / 2, near: 0.5, far: 2_000,
    }, 1600, 900, false, packed, {
      rayDirectionWorld: [0, -1, 0], surfaceToLightWorld: [0, 1, 0], color: [0.2, 0.4, 0.8], intensity: 3,
    });
    expect(result.projection).toEqual({ verticalFovRadians: Math.PI / 2, near: 0.5, far: 2_000 });
    expect(result.stableViewProjection.every(Number.isFinite)).toBe(true);
    expect(Array.from(packed.frameData.slice(76, 80))).toEqual([0, 1, 0, 0]);
    [0.2, 0.4, 0.8, 3].forEach((value, index) => expect(packed.frameData[84 + index]).toBeCloseTo(value));
    expect((queue.writeBuffer as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid projection values before encoding GPU work", () => {
    for (const projection of [
      { verticalFovRadians: 0 }, { verticalFovRadians: Math.PI }, { near: 0 }, { near: 2, far: 1 }, { far: Infinity },
    ]) expect(() => resolvePbrCameraProjection({ ...base, ...projection })).toThrow("camera projection");
  });
});
