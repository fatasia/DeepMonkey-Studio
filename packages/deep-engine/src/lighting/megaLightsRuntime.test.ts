// B2 MegaLights M1 compute 运行时:宿主模板组合门(无 GPU 依赖——声明次序、绑定槽位、
// 单源包含关系逐字锁定;GPU 资源生命周期由 lab/megaLightsGpuProbe.ts 真机腿覆盖)。
import { describe, expect, it } from "vitest";
import { DEEP_IES_SAMPLING_WGSL } from "./iesSamplingWgsl.js";
import { MEGA_LIGHTS_COLOR_BINDING, MEGA_LIGHTS_COLOR_HISTORY_BINDING, MEGA_LIGHTS_IES_BINDING,
  MEGA_LIGHTS_MOTION_BINDING, MEGA_LIGHTS_PARAMS_BYTES, MEGA_LIGHTS_PARAMS_BINDING,
  MEGA_LIGHTS_POOL_BINDING, MEGA_LIGHTS_RESERVOIRS_A_BINDING, MEGA_LIGHTS_RESERVOIRS_B_BINDING,
  MEGA_LIGHTS_SURFACES_BINDING, MEGA_LIGHTS_SURFACES_STRIDE_VEC4 } from "./megaLightsAbi.js";
import { MEGA_LIGHTS_RIS_WGSL } from "./megaLightsRisWgsl.js";
import { composeMegaLightsShader, MEGA_LIGHTS_ENTRY_BUILD, MEGA_LIGHTS_ENTRY_SHADE,
  MEGA_LIGHTS_PIPELINE_KEY, MEGA_LIGHTS_WORKGROUP_SIZE } from "./megaLightsRuntime.js";

describe("MegaLights runtime composed shader template", () => {
  const composed = composeMegaLightsShader();

  it("declares every host binding at the pinned slot before the library", () => {
    const libraryIndex = composed.indexOf(MEGA_LIGHTS_RIS_WGSL);
    const iesIndex = composed.indexOf(DEEP_IES_SAMPLING_WGSL);
    expect(libraryIndex).toBeGreaterThan(0);
    expect(iesIndex).toBeGreaterThan(0);
    expect(iesIndex).toBeLessThan(libraryIndex); // deepSpotIesFactor 先于 RIS 库声明(WGSL 先声明后使用)。
    for (const [binding, symbol] of [
      [MEGA_LIGHTS_PARAMS_BINDING, "var<uniform> deepMegaFrame: DeepMegaParams"],
      [MEGA_LIGHTS_POOL_BINDING, "var<storage, read> deepMegaLights: array<vec4<f32>>"],
      [MEGA_LIGHTS_SURFACES_BINDING, "var<storage, read> deepMegaSurfaces: array<vec4<f32>>"],
      [MEGA_LIGHTS_MOTION_BINDING, "var<storage, read> deepMegaMotion: array<vec4<f32>>"],
      [MEGA_LIGHTS_RESERVOIRS_A_BINDING, "var<storage, read_write> deepMegaReservoirsA: array<vec4<f32>>"],
      [MEGA_LIGHTS_RESERVOIRS_B_BINDING, "var<storage, read_write> deepMegaReservoirsB: array<vec4<f32>>"],
      [MEGA_LIGHTS_COLOR_BINDING, "var<storage, read_write> deepMegaColor: array<vec4<f32>>"],
      [MEGA_LIGHTS_COLOR_HISTORY_BINDING, "var<storage, read_write> deepMegaColorHistory: array<vec4<f32>>"],
      [MEGA_LIGHTS_IES_BINDING, "var<storage, read> deepIesShading: array<vec4<f32>>"],
    ] as const) {
      expect(composed).toContain(`@binding(${binding}) ${symbol}`);
    }
  });

  it("keeps both compute entries after the library with the pinned workgroup", () => {
    const libraryIndex = composed.indexOf(MEGA_LIGHTS_RIS_WGSL);
    const buildIndex = composed.indexOf(`fn ${MEGA_LIGHTS_ENTRY_BUILD}(`);
    const shadeIndex = composed.indexOf(`fn ${MEGA_LIGHTS_ENTRY_SHADE}(`);
    expect(buildIndex).toBeGreaterThan(libraryIndex);
    expect(shadeIndex).toBeGreaterThan(buildIndex);
    expect(composed).toContain(`@compute @workgroup_size(${MEGA_LIGHTS_WORKGROUP_SIZE}, ${MEGA_LIGHTS_WORKGROUP_SIZE})`);
    // 趟一历史源 = 上一帧蓄水池 B(固定双缓冲角色,pass 边界内存序)。
    expect(composed).toContain("deepMegaReservoirsB[pixelIndex], deepMegaMotion[pixelIndex].xy)");
    // 趟二:表面 3-vec4 布局直取 + EMA 混合 + 蓄水池回写。
    expect(composed).toContain(`deepMegaSurfaces[pixelIndex * ${MEGA_LIGHTS_SURFACES_STRIDE_VEC4}u]`);
    expect(composed).toContain("deepMegaColorHistory[pixelIndex].rgb, color, vec3f(deepMegaFrame.alphaBlend)");
    // 蓄水池回写的 .w = 视深(-z,下一帧时域相似门消费;surfaceA.w 是 metallic,
    // 2026-10-07 真机 GPU 探针抓出的宿主模板缺陷,与 CPU megaViewDepth 同口径)。
    expect(composed).toContain("deepMegaReservoirPack(center, -surfaceA.z)");
    expect(composed).not.toContain("deepMegaReservoirPack(center, surfaceA.w)");
  });

  it("pins the params uniform word budget and pipeline key", () => {
    expect(MEGA_LIGHTS_PARAMS_BYTES).toBe(64);
    // v2(2026-10-05):M2 胜者可见性射线档;legacy 打包与 v1 逐位一致(visibilityEnabled=0)。
    expect(MEGA_LIGHTS_PIPELINE_KEY).toBe("deep.megalights-ris.v2.k32");
    expect(MEGA_LIGHTS_ENTRY_BUILD).toBe("deepMegaBuildReservoirsFrame");
    expect(MEGA_LIGHTS_ENTRY_SHADE).toBe("deepMegaReuseAndShadeFrame");
  });
});
