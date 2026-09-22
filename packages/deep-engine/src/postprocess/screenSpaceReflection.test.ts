import { describe, expect, it } from "vitest";
import { compositeScreenSpaceReflectionCpu, screenSpaceReflectionCpu,
  sampleScreenSpaceReflectionRoughRadianceCpu,
  screenSpaceReflectionEdgeFade, screenSpaceReflectionHalfSize, traceScreenSpaceReflectionCpu,
  validateScreenSpaceReflectionOptions, SSR_STEPS_MAX, SSR_STEPS_MIN } from "./screenSpaceReflectionCpu.js";
import { SSR_COMPOSITE_FORMAT, SSR_DEPTH_FORMAT, SSR_NORMAL_FORMAT, SSR_TRACE_FORMAT } from "./screenSpaceReflectionTypes.js";
import { SSR_TRACE_WGSL, SSR_COMPOSITE_WGSL } from "./screenSpaceReflectionWgsl.js";

const OPTIONS = Object.freeze({ verticalFovRadians: Math.PI / 3, maxDistance: 20, thickness: 0.5,
  steps: 32, refines: 4, edgeFade: 0.08, fresnelF0: 0.05 });

/** 倾斜地板:法线朝上偏 -y,相机看向 -z;反射应命中地板更远处。 */
function tiltedFloor(width: number, height: number) {
  const depth = new Array<number>(width * height).fill(0);
  const normals = new Array<number>(width * height * 3).fill(0);
  const color = new Array<number>(width * height * 3).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      depth[index] = 5;
      normals[index * 3] = 0; normals[index * 3 + 1] = -0.4472136; normals[index * 3 + 2] = 0.8944272;
      color[index * 3] = 0.1; color[index * 3 + 1] = 0.2; color[index * 3 + 2] = 0.3;
    }
  }
  return { width, height, depth, normals, color };
}

describe("screenSpaceReflectionHalfSize", () => {
  it("ceil-divides by two", () => {
    expect(screenSpaceReflectionHalfSize(64, 63)).toEqual([32, 32]);
    expect(screenSpaceReflectionHalfSize(1, 1)).toEqual([1, 1]);
  });
  it("rejects non-positive and non-integer sizes", () => {
    expect(() => screenSpaceReflectionHalfSize(0, 10)).toThrow(/positive safe integers/);
    expect(() => screenSpaceReflectionHalfSize(10.5, 10)).toThrow(/positive safe integers/);
  });
});

describe("validateScreenSpaceReflectionOptions", () => {
  it("accepts the reference options", () => {
    validateScreenSpaceReflectionOptions({ ...OPTIONS });
  });
  it("rejects fov, steps, refines, edgeFade, and f0 out of range", () => {
    expect(() => validateScreenSpaceReflectionOptions({ ...OPTIONS, verticalFovRadians: 0 })).toThrow(/verticalFovRadians/);
    expect(() => validateScreenSpaceReflectionOptions({ ...OPTIONS, verticalFovRadians: Math.PI })).toThrow(/verticalFovRadians/);
    expect(() => validateScreenSpaceReflectionOptions({ ...OPTIONS, maxDistance: 0 })).toThrow(/maxDistance/);
    expect(() => validateScreenSpaceReflectionOptions({ ...OPTIONS, thickness: -1 })).toThrow(/thickness/);
    expect(() => validateScreenSpaceReflectionOptions({ ...OPTIONS, steps: SSR_STEPS_MIN - 1 })).toThrow(/steps/);
    expect(() => validateScreenSpaceReflectionOptions({ ...OPTIONS, steps: SSR_STEPS_MAX + 1 })).toThrow(/steps/);
    expect(() => validateScreenSpaceReflectionOptions({ ...OPTIONS, refines: -1 })).toThrow(/refines/);
    expect(() => validateScreenSpaceReflectionOptions({ ...OPTIONS, edgeFade: 0.5 })).toThrow(/edgeFade/);
    expect(() => validateScreenSpaceReflectionOptions({ ...OPTIONS, fresnelF0: 1.5 })).toThrow(/fresnelF0/);
  });
});

describe("screenSpaceReflectionEdgeFade", () => {
  it("is one in the interior and zero at the border", () => {
    expect(screenSpaceReflectionEdgeFade(0.5, 0.5, 0.1)).toBe(1);
    expect(screenSpaceReflectionEdgeFade(0, 0.5, 0.1)).toBe(0);
    expect(screenSpaceReflectionEdgeFade(0.5, 1, 0.1)).toBe(0);
  });
  it("fades monotonically toward the edge", () => {
    const inside = screenSpaceReflectionEdgeFade(0.95, 0.5, 0.1);
    const closer = screenSpaceReflectionEdgeFade(0.98, 0.5, 0.1);
    expect(inside).toBeGreaterThan(closer);
    expect(closer).toBeGreaterThan(0);
  });
});

describe("traceScreenSpaceReflectionCpu", () => {
  it("widens a bounded radiance cone from view-normal roughness while preserving the sharp default", () => {
    const scene = tiltedFloor(16, 16); scene.color.fill(0);
    const center = (8 * scene.width + 8) * 3; scene.color[center] = 4;
    expect(sampleScreenSpaceReflectionRoughRadianceCpu(scene, 8.5 / 16, 8.5 / 16, 0)[0]).toBeCloseTo(4);
    const rough = sampleScreenSpaceReflectionRoughRadianceCpu(scene, 8.5 / 16, 8.5 / 16, 1);
    expect(rough[0]).toBeGreaterThan(0); expect(rough[0]).toBeLessThan(4);
    expect(() => traceScreenSpaceReflectionCpu({ ...scene, roughness: [0] }, OPTIONS, 1, 1)).toThrow(/dimensions/);
    expect(() => sampleScreenSpaceReflectionRoughRadianceCpu(scene, 0.5, 0.5, Number.NaN)).toThrow(/roughness/);
  });

  it("zeroes pixels with no depth", () => {
    const scene = tiltedFloor(16, 16);
    scene.depth.fill(0);
    expect([...traceScreenSpaceReflectionCpu(scene, OPTIONS, 4, 4)]).toEqual([0, 0, 0, 0]);
  });
  it("produces a masked reflection on an upward-facing tilted floor", () => {
    const width = 32, height = 32;
    const scene = tiltedFloor(width, height);
    let hits = 0;
    for (let halfY = 0; halfY < height / 2; halfY++) {
      for (let halfX = 0; halfX < width / 2; halfX++) {
        const [r, g, b, a] = traceScreenSpaceReflectionCpu(scene, OPTIONS, halfX, halfY);
        if (a > 0) {
          hits++;
          expect(r >= 0 && g >= 0 && b >= 0).toBe(true);
          expect(g).toBeGreaterThan(r);
          expect(b).toBeGreaterThan(g);
        }
      }
    }
    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThan((width / 2) * (height / 2));
  });
  it("scales the mask with fresnelF0 at a fixed hit", () => {
    const scene = tiltedFloor(32, 32);
    const metal = traceScreenSpaceReflectionCpu(scene, { ...OPTIONS, fresnelF0: 1 }, 8, 8); // fresnel ≡ 1
    const dielectric = traceScreenSpaceReflectionCpu(scene, { ...OPTIONS, fresnelF0: 0 }, 8, 8); // fresnel = (1-cosθ)^5
    expect(metal[3]).toBeGreaterThan(0);
    if (dielectric[3] > 0) {
      expect(dielectric[3]).toBeLessThan(metal[3]);
    }
  });
});

describe("compositeScreenSpaceReflectionCpu", () => {
  it("replaces the existing fallback energy under the bilinear hit mask", () => {
    const scene = tiltedFloor(8, 8);
    const trace = new Float32Array(4 * 4 * 4);
    for (let i = 0; i < 4 * 4; i++) { trace[i * 4] = 0.5; trace[i * 4 + 3] = 0.5; }
    const [r] = compositeScreenSpaceReflectionCpu(scene, trace, 4, 4, 3, 3);
    // 反射 rgb 已含 mask；基础 probe/environment 回退只保留未命中的一半。
    expect(Math.abs(r - 0.55)).toBeLessThan(1e-6);
  });
});

describe("screenSpaceReflectionCpu end to end", () => {
  it("outputs a finite fallback-replaced reflection composite", () => {
    const width = 16, height = 16;
    const scene = tiltedFloor(width, height);
    const result = screenSpaceReflectionCpu(scene, OPTIONS);
    expect(result.output.length).toBe(width * height * 3);
    let sum = 0;
    for (let i = 0; i < result.output.length; i++) {
      expect(Number.isFinite(result.output[i])).toBe(true);
      sum += result.output[i];
    }
    expect(sum).toBeGreaterThan(0);
  });
  it("keeps the fallback replacement finite and nonnegative", () => {
    const width = 16, height = 16;
    const scene = tiltedFloor(width, height);
    for (let i = 0; i < width * height; i++) {
      scene.normals[i * 3] = 0; scene.normals[i * 3 + 1] = 0; scene.normals[i * 3 + 2] = 1;
    }
    const result = screenSpaceReflectionCpu(scene, OPTIONS);
    for (let i = 0; i < width * height; i++) {
      expect(result.output[i * 3]).toBeGreaterThanOrEqual(0);
      expect(result.output[i * 3 + 1]).toBeGreaterThanOrEqual(0);
      expect(result.output[i * 3 + 2]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("format and shader contracts", () => {
  it("declares the expected texture formats", () => {
    expect(SSR_TRACE_FORMAT).toBe("rgba16float");
    expect(SSR_COMPOSITE_FORMAT).toBe("rgba16float");
    expect(SSR_DEPTH_FORMAT).toBe("r32float");
    expect(SSR_NORMAL_FORMAT).toBe("rgba8unorm");
  });
  it("wgsl kernels expose the entry points the pass binds", () => {
    expect(SSR_TRACE_WGSL).toMatch(/fn traceReflection\(/);
    expect(SSR_TRACE_WGSL).toMatch(/@workgroup_size\(8, 8\)/);
    expect(SSR_COMPOSITE_WGSL).toMatch(/fn compositeReflection\(/);
    expect(SSR_COMPOSITE_WGSL).not.toContain("sourceNormal");
    expect(SSR_TRACE_WGSL).toContain("fn ssrLoadNormal");
  });
  it("wgsl trace reconstruction matches the AO view-space contract", () => {
    expect(SSR_TRACE_WGSL).toMatch(/ndc\.x \* depth \* ssrParams\.projection\.x \* ssrParams\.projection\.y/);
    expect(SSR_TRACE_WGSL).toMatch(/1\.0 - uv\.y \* 2\.0/);
  });
  it("consumes view-normal alpha as a bounded radiance hierarchy LOD", () => {
    expect(SSR_TRACE_WGSL).toContain("fn ssrLoadRoughness");
    expect(SSR_TRACE_WGSL).toContain("fn ssrSampleRoughRadiance");
    expect(SSR_TRACE_WGSL).toContain("roughness * roughness * ssrParams.misc.z");
    expect(SSR_COMPOSITE_WGSL).toContain("color * (1.0 - reflection.a) + reflection.rgb");
  });
});
