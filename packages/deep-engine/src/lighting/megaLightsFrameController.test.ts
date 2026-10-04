// B2 MegaLights M2 生产接线单测:帧控制器纯逻辑面(路径决策/矩阵组合)+
// 宿主私有 WGSL 合同字面量门(与 ABI/打包端逐字互钉;GPU 行为由真机探针
// megaLightsGpuTest.mjs 覆盖,如实分工)。CPU 权威镜像与 RIS 核的奇偶性由
// megaLightsAcceptance/megaLightsRisCpu/megaLightsRisWgslChecksum 家族既有门守。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_MEGA_LIGHTS, MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET,
  megaLightFromPoint } from "./megaLights.js";
import { MEGA_LIGHTS_SURFACES_STRIDE_VEC4 } from "./megaLightsAbi.js";
import { multiplyColumnMajor4x4, megaLightsFramePlanned } from "./megaLightsFrameController.js";
import { MEGA_LIGHTS_COMPOSITE_PARAMS_BYTES, MEGA_LIGHTS_COMPOSITE_WGSL,
  MEGA_LIGHTS_REBUILD_DEPTH_GATE, MEGA_LIGHTS_REBUILD_PARAMS_BYTES,
  MEGA_LIGHTS_REBUILD_WGSL } from "./megaLightsFrameWgsl.js";

describe("MegaLights frame controller pure logic", () => {
  it("combines column-major matrices as out = a × b", () => {
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const translation = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1]);
    expect([...multiplyColumnMajor4x4(translation, identity)]).toEqual([...translation]);
    expect([...multiplyColumnMajor4x4(identity, translation)]).toEqual([...translation]);
    // 平移 × 平移 = 分量和(列主序:平移占第 4 列)。
    const twice = multiplyColumnMajor4x4(translation, translation);
    expect(twice[12]).toBe(4); expect(twice[13]).toBe(6); expect(twice[14]).toBe(8);
  });

  it("keeps the frame-plan decision single-sourced with the path selector", () => {
    // 开关关:恒 false(逐位零变化承诺的纯函数面)。
    expect(megaLightsFramePlanned(false, { points: [1, 2, 3], spots: [] })).toBe(false);
    expect(megaLightsFramePlanned(false, undefined)).toBe(false);
    // ≤64 本地灯 = 簇光快路径(既有路径零变化);边界 64/65 逐值钉死。
    const sixtyFour = Array.from({ length: MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET }, (_, i) => i);
    const sixtyFive = [...sixtyFour, 64];
    expect(megaLightsFramePlanned(true, { points: sixtyFour, spots: [] })).toBe(false);
    expect(megaLightsFramePlanned(true, { points: sixtyFive, spots: [] })).toBe(true);
    expect(megaLightsFramePlanned(true, { points: [], spots: sixtyFour })).toBe(false);
    expect(megaLightsFramePlanned(true, { points: [], spots: sixtyFive })).toBe(true);
    // 面积光不参与决策(M1 定案:两通路都常驻面积光路径)。
    expect(megaLightsFramePlanned(true, { points: [], spots: [] })).toBe(false);
  });

  it("surfaces the pool capacity contract for fail-closed wording", () => {
    expect(MAX_MEGA_LIGHTS).toBe(65_535);
    expect(MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET).toBe(64);
    // 打包端同门兜底:超池容量在 packMegaLights 处拒绝(双闸之二,此处钉常量耦合)。
    const light = megaLightFromPoint({ positionView: [0, 0, 0], range: 0, color: [1, 1, 1],
      intensity: 1 });
    expect(light.kind).toBe("point");
  });
});

describe("MegaLights frame WGSL host-template contracts", () => {
  it("rebuild kernel ABI stays pinned to the surfaces stride and RIS depth gate", () => {
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain(`const DEEP_MEGA_REBUILD_SURFACE_STRIDE: u32 = ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u;`);
    expect(MEGA_LIGHTS_SURFACES_STRIDE_VEC4).toBe(3);
    // 深度门与 RIS 时域深度门同族同值(0.1;漂移一侧即红)。
    expect(MEGA_LIGHTS_REBUILD_DEPTH_GATE).toBe(0.1);
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain(`const DEEP_MEGA_REBUILD_DEPTH_GATE: f32 = ${MEGA_LIGHTS_REBUILD_DEPTH_GATE};`);
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("@workgroup_size(8, 8)");
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("fn deepMegaRebuildSurfacesFrame");
  });

  it("rebuild kernel zeroes background and discontinuous pixels (output mask semantics)", () => {
    // 清屏深度(≥1)与深度不连续 → 表面全零(RIS 着色核 nDotL=0 早退 = 零贡献)。
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("if (centerDepth >= 1.0 || discontinuous) {");
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("deepMegaRebuildSurfaces[base] = vec4f(0.0);");
  });

  it("rebuild kernel documents the neutral-material degraded start tier", () => {
    // 中性材质起步档(albedo 0.8/0.78/0.75、roughness 0.5、metallic 0):与真机探针
    // 朗伯墙同族;GBuffer 消费切片替换时这两个字面量门先红,防静默漂移。
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("deepMegaRebuildSurfaces[base] = vec4f(center.xyz, 0.0);");
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("deepMegaRebuildSurfaces[base + 1u] = vec4f(normal, 0.5);");
    expect(MEGA_LIGHTS_REBUILD_WGSL).toContain("deepMegaRebuildSurfaces[base + 2u] = vec4f(0.8, 0.78, 0.75, 0.0);");
  });

  it("composite kernel stays alpha-preserving additive over the HDR attachment", () => {
    expect(MEGA_LIGHTS_COMPOSITE_WGSL).toContain("return vec4f(deepMegaCompositeColor[pixelIndex].rgb, 0.0);");
    expect(MEGA_LIGHTS_COMPOSITE_WGSL).toContain("fn deepMegaCompositeVertex");
    expect(MEGA_LIGHTS_COMPOSITE_WGSL).toContain("fn deepMegaCompositeFragment");
    // uniform 参数字节数与 WGSL struct 自然布局一致(16B;漂移由打包端写不进而红)。
    expect(MEGA_LIGHTS_COMPOSITE_PARAMS_BYTES).toBe(16);
    expect(MEGA_LIGHTS_REBUILD_PARAMS_BYTES).toBe(80);
  });

  it("keeps both host-template kernels byte-stable (hash pin, regeneration drift guard)", () => {
    // 宿主私有模板无 wgsl/ 单源链,以源内 SHA-256 夹具钉字节(改动必须显式过门)。
    const rebuildHash = createHash("sha256").update(new TextEncoder().encode(MEGA_LIGHTS_REBUILD_WGSL)).digest("hex");
    const compositeHash = createHash("sha256").update(new TextEncoder().encode(MEGA_LIGHTS_COMPOSITE_WGSL)).digest("hex");
    expect(rebuildHash).toMatch(/^[0-9a-f]{64}$/);
    expect(compositeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rebuildHash).toBe("5f6f961341c2a32ebab9db9f9dfca4df306c5b896184b8600f0e23cf5f8b5135");
    expect(compositeHash).toBe("6df6f45501c0a492bf34f7303dca81493a75f8a149a14fdf2ccff6d6943fb3be");
  });
});
