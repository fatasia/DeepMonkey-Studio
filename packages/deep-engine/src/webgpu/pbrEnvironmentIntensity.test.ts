import { describe, expect, it, vi } from "vitest";
import { resolvePbrEnvironmentIntensity, scalePbrEnvironmentRadiance } from "./pbrEnvironmentIntensity.js";
import { CameraFrameHistory } from "./cameraFrameHistory.js";
import { updatePbrFrameUniforms } from "./pbrFrameUniforms.js";
import { validatePbrRenderView } from "./pbrRenderViewValidation.js";
import { resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
import { sceneShader } from "./pbrShader.js";
import { PBR_FRAME_UNIFORM_FLOATS } from "./pipelines.js";

const view = { eye: [0, 0, 10] as const, target: [0, 0, 0] as const, extent: 10,
  background: [0, 0, 0] as const, floor: [0.1, 0.1, 0.1] as const, exposure: 1,
  roughness: 0.5, width: 800, height: 600, pixelRatio: 1 };
function fixture() {
  const writeBuffer = vi.fn();
  return { queue: { writeBuffer } as unknown as GPUQueue, writeBuffer, history: new CameraFrameHistory(),
    resources: { frameBuffer: {} as GPUBuffer, outputBuffer: {} as GPUBuffer, groundInstance: {} as GPUBuffer,
      frameData: new Float32Array(PBR_FRAME_UNIFORM_FLOATS), outputData: new Float32Array(8),
      groundData: new Float32Array(36) } };
}

describe("PBR authored environment intensity", () => {
  it.each([undefined, 0, 1, 0.25, 2, 64])("packs %s without growing the frame ABI", intensity => {
    const f = fixture();
    updatePbrFrameUniforms(f.queue, f.history, { ...view, environmentIntensity: intensity },
      800, 600, false, f.resources);
    expect(f.resources.frameData[79]).toBe(intensity ?? 1);
    expect(f.resources.frameData[67]).toBe(1);
    expect(f.resources.frameData).toHaveLength(96);
    expect(f.writeBuffer).toHaveBeenCalledTimes(3);
    expect(scalePbrEnvironmentRadiance([0.25, 2, 4], intensity))
      .toEqual([0.25, 2, 4].map(value => value * (intensity ?? 1)));
  });

  it.each([-1, NaN, Infinity, -Infinity, 64.01, null, "2"])("rejects %s before GPU writes or camera history mutation", invalid => {
    const f = fixture(), environmentIntensity = invalid as number;
    expect(() => resolvePbrEnvironmentIntensity(environmentIntensity)).toThrow("environmentIntensity");
    expect(() => validatePbrRenderView({ ...view, environmentIntensity })).toThrow("environmentIntensity");
    expect(() => updatePbrFrameUniforms(f.queue, f.history, { ...view, environmentIntensity },
      800, 600, false, f.resources)).toThrow("environmentIntensity");
    expect(f.writeBuffer).not.toHaveBeenCalled();
    expect(f.history.revision).toBe(0);
    expect(f.resources.frameData.every(value => value === 0)).toBe(true);
  });

  it("keeps the environment quality gate authoritative independently of intensity", () => {
    const f = fixture();
    updatePbrFrameUniforms(f.queue, f.history, { ...view, environmentIntensity: 2 }, 800, 600, false,
      f.resources, undefined, resolvePbrRendererFeatures({ environment: false }));
    expect(f.resources.frameData[67]).toBe(0);
    expect(f.resources.frameData[79]).toBe(2);
    expect(sceneShader).toContain("if (frame.eye.w > 0.0)");
  });

  it("scales both actual IBL shader samples before GI blending, without changing direct or emissive terms", () => {
    expect(sceneShader).toContain("environmentSampler, n, 0.0).rgb * frame.lightDirection.w");
    expect(sceneShader).toContain("reflection, rough * maxSpecularLod).rgb * frame.lightDirection.w");
    expect(sceneShader.match(/\* frame\.lightDirection\.w/g)).toHaveLength(2);
    expect(sceneShader).toContain("mix(environmentIrradiance, gi.rgb, gi.a)");
    expect(sceneShader).toContain("frame.sunColor.rgb * frame.sunColor.w * visibility");
    expect(sceneShader).toContain("color += deepAuthoredDiffuse(n, base, metal, occlusionInput) + select(emissive, vec3f(0.0), ground)");
  });
});
