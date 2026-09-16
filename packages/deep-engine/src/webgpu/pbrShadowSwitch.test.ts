import { describe, expect, it, vi } from "vitest";
import { resolvePbrSceneLighting } from "../lighting/pbrSceneLighting.js";
import { updatePbrFrameUniforms } from "./pbrFrameUniforms.js";
import { CameraFrameHistory } from "./cameraFrameHistory.js";
import { PBR_FRAME_UNIFORM_FLOATS } from "./pipelines.js";
import { sceneShader } from "./pbrShader.js";

function packed(castShadow?: boolean) {
  const resources = { frameBuffer: {} as GPUBuffer, outputBuffer: {} as GPUBuffer,
    groundInstance: {} as GPUBuffer, frameData: new Float32Array(PBR_FRAME_UNIFORM_FLOATS),
    outputData: new Float32Array(8), groundData: new Float32Array(36) };
  const primary = resolvePbrSceneLighting({ directional: [{ directionWorld: [0, -1, 0],
    color: [1, 0.8, 0.6], intensity: 2, ...(castShadow === undefined ? {} : { castShadow }) }] }).primary;
  updatePbrFrameUniforms({ writeBuffer: vi.fn() } as unknown as GPUQueue, new CameraFrameHistory(), {
    eye: [0, 0, 10], target: [0, 0, 0], extent: 10, background: [0.1, 0.2, 0.3],
    floor: [0.2, 0.2, 0.2], exposure: 1, roughness: 1,
  }, 800, 600, false, resources, primary);
  return resources.frameData;
}

describe("primary directional shadow switch ABI", () => {
  it("changes only the reserved background.w slot while keeping radiance and the 96-float layout", () => {
    const enabled = packed(true), disabled = packed(false), inherited = packed();
    expect(enabled).toHaveLength(96);
    expect(inherited).toEqual(enabled);
    expect(enabled[71]).toBe(1); expect(disabled[71]).toBe(0);
    expect(Array.from(enabled).flatMap((value, index) => value === disabled[index] ? [] : [index])).toEqual([71]);
    expect(Array.from(disabled.slice(84, 88))).toEqual(Array.from(enabled.slice(84, 88)));
  });
  it("branches before CSM texture sampling in HDR and both direct variants", () => {
    const gate = sceneShader.slice(sceneShader.indexOf("fn deepPrimaryShadow("), sceneShader.indexOf("struct DirectDisplayVertex"));
    expect(gate).toContain("if (frame.background.w <= 0.0 || flag(flags, 16u)) { return 1.0; }");
    expect(gate.indexOf("return 1.0")).toBeLessThan(gate.indexOf("deepCascadedShadow("));
    expect(sceneShader.match(/let visibility = deepPrimaryShadow\(world, n, dot\(n, l\), authorShadow/g)).toHaveLength(2);
    expect(sceneShader).toContain("if (frame.background.w > 0.0 && !flag(flags, 16u))");
  });
});
