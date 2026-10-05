import { describe, expect, it } from "vitest";
import { SSGI_TRACE_WGSL, SSGI_COMPOSITE_WGSL } from "./screenSpaceGiWgsl.js";
import { packSsgiParameters, defaultScreenSpaceGiOptions } from "./screenSpaceGi.js";
import { screenSpaceGiCpu, traceScreenSpaceGiCpu, compositeScreenSpaceGiCpu,
  screenSpaceGiHash, screenSpaceGiRandom, screenSpaceGiHalfSize,
  projectScreenSpaceGiToUv, reconstructScreenSpaceGiPosition,
  validateScreenSpaceGiOptions } from "./screenSpaceGiCpu.js";
import { buildPbrFrameExecutionPlan, collectActualPbrFramePasses, assertPlanMatchesActual } from "../webgpu/pbrFramePlanExecutor.js";
import { resolvePbrRendererFeatures } from "../webgpu/pbrRendererFeatures.js";
import type { ScreenSpaceGiCpuInput, ScreenSpaceGiCpuOptions } from "./screenSpaceGiTypes.js";

/**
 * SSGI 约定核验(与 SSR conventions 同构):生产 WGSL 逐条正则断言 + CPU 镜像
 * 解析场景参考 + 采样确定性 + features 关闭帧计划零变化。任何一侧漂移都显式失败。
 */

const CHECKS: readonly { id: string; pattern: RegExp; source: "trace" | "composite" }[] = [
  { id: "origin-guard", source: "trace", pattern: /if \(!\(centerDepth > 0\.0\)\) \{ textureStore\(traceTarget, vec2<i32>\(id\.xy\), vec4f\(0\.0\)\); return; \}/u },
  { id: "depth-reconstruct", source: "trace", pattern: /ndc\.x \* depth \* ssgiParams\.projection\.x \* ssgiParams\.projection\.y,\s*\n\s*ndc\.y \* depth \* ssgiParams\.projection\.x, -depth/u },
  { id: "normal-view-decode", source: "trace", pattern: /textureLoad\(sourceNormal, vec2<i32>\(coordinate\), 0\)\.xyz \* 2\.0 - 1\.0/u },
  { id: "thickness-band", source: "trace", pattern: /if \(surfaceDepth < rayDepth && rayDepth - surfaceDepth < ssgiParams\.projection\.w\) \{/u },
  { id: "refine-hole-guard", source: "trace", pattern: /if \(refinedDepth > 0\.0 && refinedDepth < -middle\.z\) \{ highDistance = middleDistance; \}/u },
  { id: "ray-depth-guard", source: "trace", pattern: /if \(rayDepth <= 0\.0\) \{ break; \}/u },
  { id: "march-screen-bounds", source: "trace", pattern: /if \(uv\.x < 0\.0 \|\| uv\.x > 1\.0 \|\| uv\.y < 0\.0 \|\| uv\.y > 1\.0\) \{ break; \}/u },
  { id: "edge-fade-clamp", source: "trace", pattern: /let t = clamp\(min\(min\(\(1\.0 - uv\.x\) \/ fade, uv\.x \/ fade\), min\(\(1\.0 - uv\.y\) \/ fade, uv\.y \/ fade\)\), 0\.0, 1\.0\);/u },
  { id: "deterministic-pcg-hash", source: "trace", pattern: /let state = value \* 747796405u \+ 2891336453u;/u },
  { id: "cosine-hemisphere", source: "trace", pattern: /fn ssgiCosineHemisphere\(u1: f32, u2: f32\) -> vec3f \{/u },
  { id: "half-res-odd-pixel", source: "trace", pattern: /let coordinate = min\(id\.xy \* 2u \+ vec2<u32>\(1u\), ssgiParams\.sourceSize - vec2<u32>\(1u\)\);/u },
  { id: "distance-squared-falloff", source: "trace", pattern: /let falloff = \(1\.0 - fadeT\) \* \(1\.0 - fadeT\) \* ssgiEdgeFade\(hitUv\);/u },
  { id: "mean-over-samples", source: "trace", pattern: /let gi = accumulated \/ sampleCount \* ssgiParams\.misc\.x;/u },
  { id: "composite-additive", source: "composite", pattern: /textureStore\(compositeTarget, vec2<i32>\(id\.xy\), vec4f\(color \+ gi\.rgb, 1\.0\)\);/u },
  { id: "composite-bilinear-upsample", source: "composite", pattern: /let gi = textureSampleLevel\(sourceTrace, ssgiSampler, uv, 0\.0\);/u },
];

const ABSENCE_CHECKS: readonly { id: string; pattern: RegExp }[] = [
  { id: "no-temporal-history", pattern: /history|previousFrame|prevColor|temporal/u },
  { id: "no-gaussian-blur", pattern: /gaussian|blur/u },
];

/**
 * 解析场景(视空间,相机沿 -Z 注视):行 0-15 远地面(灰,深度 8,法线 +Y),
 * 行 16-31 红墙带(亮红,深度 6,法线 +Z,立于地面),行 32-63 近地面(灰,
 * 深度 4,法线 +Y)。近地面像素的余弦半球以可观概率命中红墙 → 红色渗透。
 */
function analyticScene(width = 64, height = 64): ScreenSpaceGiCpuInput {
  const depth = new Array<number>(width * height);
  const normals = new Array<number>(width * height * 3).fill(0);
  const color = new Array<number>(width * height * 3).fill(0);
  const write3 = (target: number[], offset: number, values: readonly number[]): void => {
    for (let index = 0; index < 3; index++) target[offset + index] = values[index]!;
  };
  // 法线按 rgba8unorm 合同编码:(n+1)/2(CPU 镜像负责 ×2−1 解码)。
  const encode3 = (n: readonly number[]): readonly number[] => [(n[0]! + 1) / 2, (n[1]! + 1) / 2, (n[2]! + 1) / 2];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const wall = y >= 16 && y < 32;
      const farFloor = y < 16;
      depth[y * width + x] = wall ? 6 : farFloor ? 8 : 4;
      const normal = wall ? [0, 0, 1] : [0, 1, 0];
      const radiance = wall ? [2, 0.05, 0.05] : [0.05, 0.05, 0.05];
      write3(normals, (y * width + x) * 3, encode3(normal));
      write3(color, (y * width + x) * 3, radiance);
    }
  }
  return { width, height, depth, normals, color };
}

const OPTIONS: ScreenSpaceGiCpuOptions = { verticalFovRadians: Math.PI / 3, samples: 16,
  maxDistance: 6, thickness: 0.05, steps: 24, refines: 4, edgeFade: 0.08, intensity: 1, seed: 7 };

describe("SSGI production WGSL conventions", () => {
  for (const check of CHECKS) {
    it(`keeps ${check.id}`, () => {
      const code = check.source === "trace" ? SSGI_TRACE_WGSL : SSGI_COMPOSITE_WGSL;
      expect(check.pattern.test(code)).toBe(true);
    });
  }
  for (const check of ABSENCE_CHECKS) {
    it(`avoids ${check.id}`, () => {
      expect(check.pattern.test(SSGI_TRACE_WGSL) || check.pattern.test(SSGI_COMPOSITE_WGSL)).toBe(false);
    });
  }
});

describe("SSGI CPU mirror (executable specification)", () => {
  it("round-trips position reconstruction through projection", () => {
    const input = analyticScene();
    const tanHalfFov = Math.tan(OPTIONS.verticalFovRadians * 0.5);
    const aspect = input.width / input.height;
    for (const [x, y, depth] of [[3, 5, 4], [31, 40, 2.5], [60, 63, 8]] as const) {
      const position = reconstructScreenSpaceGiPosition(input, x, y, depth, tanHalfFov, aspect);
      const [uvX, uvY] = projectScreenSpaceGiToUv(position, tanHalfFov, aspect);
      expect(uvX * input.width - 0.5).toBeCloseTo(x, 9);
      expect(uvY * input.height - 0.5).toBeCloseTo(y, 9);
    }
  });

  it("bleeds red bounce light onto the floor adjacent to the red wall (indirect light visible)", () => {
    const input = analyticScene();
    const result = screenSpaceGiCpu(input, OPTIONS);
    const [traceWidth, traceHeight] = screenSpaceGiHalfSize(input.width, input.height);
    const wallBaseTraceRow = 17; // 全分辨率行 34-35(墙基正前方的近地面)
    let redSum = 0, blueSum = 0, count = 0;
    for (let halfX = 6; halfX < traceWidth - 6; halfX++) {
      const base = (wallBaseTraceRow * traceWidth + halfX) * 4;
      redSum += result.trace[base]!; blueSum += result.trace[base + 2]!; count++;
    }
    expect(count).toBeGreaterThan(0);
    expect(redSum / count).toBeGreaterThan(0.01);
    // 实测墙带立体角下红/蓝 ≈ 3-4×(调试脚本 halfY=17 r=0.0257 b=0.0086)。
    expect(redSum / count).toBeGreaterThan((blueSum / count) * 2.5);
    // 合成加性恒等:零 trace 时输出 = 输入色;常数 trace c 时输出 = 输入色 + c。
    const pixelX = 32, pixelY = Math.ceil(input.height / 2) + 2;
    const passthrough = compositeScreenSpaceGiCpu(input, new Float32Array(traceWidth * traceHeight * 4),
      traceWidth, traceHeight, pixelX, pixelY);
    expect(passthrough[0]).toBeCloseTo(input.color[(pixelY * input.width + pixelX) * 3]!, 6);
    const constant = new Float32Array(traceWidth * traceHeight * 4).fill(0);
    for (let index = 0; index < constant.length; index += 4) constant[index] = 0.5;
    const [added] = compositeScreenSpaceGiCpu(input, constant, traceWidth, traceHeight, pixelX, pixelY);
    expect(added).toBeCloseTo(input.color[(pixelY * input.width + pixelX) * 3]! + 0.5, 6);
  });

  it("keeps wall-facing pixels far dimmer than wall-adjacent floor bounce pixels", () => {
    const input = analyticScene();
    const [traceWidth, traceHeight] = screenSpaceGiHalfSize(input.width, input.height);
    let wallRed = 0, floorRed = 0;
    for (let halfX = 8; halfX < traceWidth - 8; halfX++) {
      wallRed += traceScreenSpaceGiCpu(input, OPTIONS, halfX, 13)[0];
      floorRed += traceScreenSpaceGiCpu(input, OPTIONS, halfX, 17)[0];
    }
    expect(floorRed).toBeGreaterThan(wallRed * 2);
  });

  it("is bit-deterministic per seed and rotates with the seed", () => {
    const input = analyticScene();
    const first = screenSpaceGiCpu(input, OPTIONS);
    const again = screenSpaceGiCpu(input, OPTIONS);
    expect(Array.from(again.trace)).toEqual(Array.from(first.trace));
    const rotated = screenSpaceGiCpu(input, { ...OPTIONS, seed: OPTIONS.seed + 1 });
    expect(Array.from(rotated.trace)).not.toEqual(Array.from(first.trace));
  });

  it("degrades to passthrough without hits and validates its options contract", () => {
    const empty: ScreenSpaceGiCpuInput = { width: 8, height: 8, depth: new Array(64).fill(0),
      normals: new Array(64 * 3).fill(0), color: new Array(8 * 8 * 3).fill(0.25) };
    const result = screenSpaceGiCpu(empty, OPTIONS);
    for (const value of result.trace) expect(value).toBe(0);
    expect(() => validateScreenSpaceGiOptions({ ...OPTIONS, samples: 0 })).toThrow(RangeError);
    expect(() => validateScreenSpaceGiOptions({ ...OPTIONS, steps: 4 })).toThrow(RangeError);
    expect(() => validateScreenSpaceGiOptions({ ...OPTIONS, seed: 2 ** 32 })).toThrow(RangeError);
    expect(() => validateScreenSpaceGiOptions({ ...OPTIONS, intensity: -1 })).toThrow(RangeError);
    expect(() => validateScreenSpaceGiOptions(OPTIONS)).not.toThrow();
  });

  it("packs the parameter block the WGSL struct consumes (single source)", () => {
    const request = { sourceWidth: 64, sourceHeight: 32, traceWidth: 32, traceHeight: 16 };
    const buffer = packSsgiParameters(request, { ...defaultScreenSpaceGiOptions(10),
      verticalFovRadians: 1.2, seed: 99 });
    const uints = new Uint32Array(buffer), floats = new Float32Array(buffer);
    expect(Array.from(uints.slice(0, 4))).toEqual([64, 32, 32, 16]);
    expect(floats[4]).toBeCloseTo(Math.tan(0.6), 6);
    expect(floats[5]).toBeCloseTo(2, 6);
    expect(Array.from(uints.slice(8, 12))).toEqual([24, 12, 99, 4]);
    expect(floats[12]).toBe(1);
    expect(floats[13]).toBeCloseTo(0.08, 6);
  });
});

describe("SSGI frame wiring (features off = byte-identical plan)", () => {
  const surface = Object.freeze({ width: 1920, height: 1080 });
  it("keeps plan hash, pass set and lifetimes unchanged when ssgi is off or absent", () => {
    const absent = buildPbrFrameExecutionPlan(surface, { transparency: true, features: {} });
    const explicitOff = buildPbrFrameExecutionPlan(surface, { transparency: true, features: { ssgi: false } });
    expect(explicitOff.planHash).toBe(absent.planHash);
    expect(explicitOff.passes.map(pass => pass.passId)).toEqual(absent.passes.map(pass => pass.passId));
    expect(explicitOff.resourceLifetimes.map(entry => entry.id)).toEqual(absent.resourceLifetimes.map(entry => entry.id));
    expect(absent.passes.map(pass => pass.passId)).not.toContain("screen-space-gi-trace");
  });
  it("wires the ssgi chain between fog composite and SSR/TAA when enabled and the plan matches actuals", () => {
    const features = resolvePbrRendererFeatures({ volumetricFog: true, ssgi: true,
      screenSpaceReflection: true, temporalAa: true, bloom: true });
    const plan = buildPbrFrameExecutionPlan(surface, { transparency: true, features });
    const order = plan.passes.map(pass => pass.passId);
    expect(order.indexOf("screen-space-gi-trace")).toBeGreaterThan(order.indexOf("volumetric-fog-composite"));
    expect(order.indexOf("screen-space-gi-composite")).toBeLessThan(order.indexOf("screen-space-reflection-trace"));
    const taaReads = plan.passes.find(pass => pass.passId === "temporal-aa")!.reads;
    expect(taaReads[0]).toBe("ssr-hdr");
    const ssrReads = plan.passes.find(pass => pass.passId === "screen-space-reflection-trace")!.reads;
    expect(ssrReads[0]).toBe("ssgi-hdr");
    const trace = plan.passes.find(pass => pass.passId === "screen-space-gi-trace")!;
    expect(trace.mapping).toMatchObject({ status: "mapped" });
    assertPlanMatchesActual(plan, collectActualPbrFramePasses(features, true, { godRays: false }));
  });
  it("keeps the ssgi output as the temporal input when SSR is off", () => {
    const features = resolvePbrRendererFeatures({ ssgi: true, temporalAa: true });
    const plan = buildPbrFrameExecutionPlan(surface, { transparency: false, features });
    const taaReads = plan.passes.find(pass => pass.passId === "temporal-aa")!.reads;
    expect(taaReads[0]).toBe("ssgi-hdr");
    assertPlanMatchesActual(plan, collectActualPbrFramePasses(features, false, {}));
  });
});
