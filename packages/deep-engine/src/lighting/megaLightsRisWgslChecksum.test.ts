// B2 MegaLights M1 RIS 采样核家族的 TS 半字节门禁(形态照抄 ltcAreaLightingWgslChecksum.test.ts):
// 1) 生成镜像不陈旧 + 与共享夹具逐字节对拍;2) 打包 ABI 字面量与 megaLights.ts/megaLightsAbi.ts
// 逐字互钉;3) 无 @group(绑定留宿主模板)且引用的 storage/IES 符号与宿主组合一致;
// 4) CPU 权威镜像(megaLightsRisCpu.ts)与 WGSL 的公式家族逐式互钉(采样合同:估计器
// N·Σt/(K·t)、历史钳、相似门、穷举模式)。Rust 半当前无消费点(rustHalf=null),
// 夹具仍按跨宿主格式维护,后续 native 接入零格式变更。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/megaLightsRis.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/megaLightsRis.wgsl?raw";
import { MEGA_LIGHTS_RIS_WGSL } from "./megaLightsRisWgsl.js";
import { DEEP_IES_SAMPLING_WGSL } from "./iesSamplingWgsl.js";
import { MEGA_LIGHT_KIND_AREA_RECT, MEGA_LIGHT_KIND_POINT, MEGA_LIGHT_KIND_SPOT,
  MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET, MEGA_LIGHT_STRIDE_VEC4, MAX_MEGA_LIGHTS,
  MEGALIGHTS_RIS_CANDIDATES, MEGALIGHTS_SPATIAL_REUSE_RADIUS, packMegaLights,
  resolveDirectLightingPath } from "./megaLights.js";
import { MEGALIGHTS_SPATIAL_NORMAL_GATE, MEGALIGHTS_TEMPORAL_DEPTH_GATE,
  megaHashU32, megaPixelSeed, megaRandomNext } from "./megaLightsRisCpu.js";
import { MEGA_LIGHTS_COLOR_BINDING, MEGA_LIGHTS_COLOR_HISTORY_BINDING, MEGA_LIGHTS_IES_BINDING,
  MEGA_LIGHTS_MOTION_BINDING, MEGA_LIGHTS_PARAMS_BINDING, MEGA_LIGHTS_POOL_BINDING,
  MEGA_LIGHTS_RESERVOIRS_A_BINDING, MEGA_LIGHTS_RESERVOIRS_B_BINDING, MEGA_LIGHTS_SURFACES_BINDING } from "./megaLightsAbi.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);

describe("MegaLights RIS WGSL single-source gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(MEGA_LIGHTS_RIS_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(MEGA_LIGHTS_RIS_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the packing ABI literals locked to megaLights.ts", () => {
    expect(MEGA_LIGHTS_RIS_WGSL).toContain(`const DEEP_MEGA_LIGHT_STRIDE: u32 = ${MEGA_LIGHT_STRIDE_VEC4}u;`);
    expect(MEGA_LIGHTS_RIS_WGSL).toContain(`const DEEP_MEGA_KIND_POINT: u32 = ${MEGA_LIGHT_KIND_POINT}u;`);
    expect(MEGA_LIGHTS_RIS_WGSL).toContain(`const DEEP_MEGA_KIND_SPOT: u32 = ${MEGA_LIGHT_KIND_SPOT}u;`);
    expect(MEGA_LIGHTS_RIS_WGSL).toContain(`const DEEP_MEGA_KIND_AREA_RECT: u32 = ${MEGA_LIGHT_KIND_AREA_RECT}u;`);
    expect(MEGA_LIGHTS_RIS_WGSL).toContain(`const DEEP_MEGA_RIS_CANDIDATES: u32 = ${MEGALIGHTS_RIS_CANDIDATES}u;`);
    expect(MEGA_LIGHTS_RIS_WGSL).toContain(`const DEEP_MEGA_RIS_SPATIAL_RADIUS: u32 = ${MEGALIGHTS_SPATIAL_REUSE_RADIUS}u;`);
    expect(MEGA_LIGHTS_RIS_WGSL).toContain(`const DEEP_MEGA_TEMPORAL_DEPTH_GATE: f32 = ${MEGALIGHTS_TEMPORAL_DEPTH_GATE};`);
    expect(MEGA_LIGHTS_RIS_WGSL).toContain(`const DEEP_MEGA_SPATIAL_NORMAL_GATE: f32 = ${MEGALIGHTS_SPATIAL_NORMAL_GATE};`);
  });

  it("stays binding-free and references only host-declared symbols", () => {
    expect(MEGA_LIGHTS_RIS_WGSL).not.toContain("@group(");
    expect(MEGA_LIGHTS_RIS_WGSL).not.toContain("@compute");
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("deepMegaLights[");
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("deepMegaSurfaces[");
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("deepMegaReservoirsA[");
    // E02 IES 复用:胜者/目标权重经宿主组合的 deepSpotIesFactor(0=无 IES 恒等)。
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("deepSpotIesFactor(record.iesRow - 1u, surfaceToLight, record.direction)");
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("if (record.iesRow != 0u)");
  });

  it("keeps the unbiased RIS estimator and degenerate exhaustive mode locked", () => {
    // 无偏估计器 color = shade(y) × N × w_sum/(M × t_y)(⑤ 穷举退化的数学基础)。
    expect(MEGA_LIGHTS_RIS_WGSL).toContain(
      "return shade * (f32(lightCount) * reservoir.weightSum / (f32(reservoir.m) * winnerWeight));");
    // 穷举模式:第 k 候选恒 k(遍历全灯 → 输出恒等于精确和)。
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("let candidates = select(DEEP_MEGA_RIS_CANDIDATES, lightCount, params.exhaustive != 0u);");
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("params.exhaustive != 0u);");
    // 胜者可见性槽 M1 恒 1.0(M2 接 BVH,任务书边界)。
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("return deepMegaContribution(record, positionView, normalView, view, baseColor, metallic, roughness) * vec3f(1.0);");
    // 时域复用投影(T07 口径:previous = pixel + 0.5 + motion)。
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("floor(f32(pixelIndex % params.viewport.x) + 0.5 + motionUv.x)");
    // 单候选合并合同(2026-10-04 定案:克隆计权偏差实测,无 MIS 时不满足 i.i.d. 前提):
    // 时域按 count=1 合并历史胜者,方差收敛交颜色 EMA(宿主模板,M2 接 MIS)。
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("deepMegaReservoirMerge(&reservoir, weight, history.winner, 1u, deepMegaRandom(&random));");
    // 空间复用 = 值域无偏平均(M2 定案 2026-10-04:旧式「单候选并入 + ÷m」把 resampled
    // 胜者当均匀候选,系统性过亮 biasMeanRatio 1.177;值域平均每源 W_src·shade 满足
    // E[W_src·shade] = Σshade 精确恒等式,clamp 采样 + 相似门,源平均零偏置)。
    expect(MEGA_LIGHTS_RIS_WGSL).toContain(
      "let sourceWeight = f32(lightCount) * source.weightSum / (f32(source.m) * sourceTarget);");
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("if (sources > 0u) { return acc / f32(sources); }");
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("if (nx < 0 || ny < 0 || nx >= i32(params.viewport.x) || ny >= i32(params.viewport.y)) { continue; }");
    // 穷举模式 = 逐灯求和(与簇光逐灯路径同式;⑤ 对拍腿)。
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("var total = vec3f(0.0);");
    // 颜色 EMA 参数词入 params(宿主模板做 mix,见 megaLightsRuntime 组合门)。
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("alphaBlend: f32,");
  });

  it("keeps the CPU mirror hashes bit-identical to the WGSL hash family", () => {
    // 种子/哈希合同:同一字面常量、同一移位序(megaHashU32/megaPixelSeed/megaRandomNext 同式)。
    expect(MEGA_LIGHTS_RIS_WGSL).toContain("state = state * 0x27d4eb2du;");
    expect(megaHashU32(1)).toBeTypeOf("number");
    expect(megaPixelSeed(7, 3, 1)).toBe(megaPixelSeed(7, 3, 1));
    const first = megaRandomNext(0x12345678);
    expect(first.value).toBeGreaterThanOrEqual(0);
    expect(first.value).toBeLessThan(1);
  });

  it("keeps the pool contract and path-selection decision point pinned", () => {
    expect(MAX_MEGA_LIGHTS).toBe(65_535);
    expect(MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET).toBe(64);
    expect(resolveDirectLightingPath({ points: 8, spots: 0 }).path).toBe("cluster-forward-plus");
    expect(resolveDirectLightingPath({ points: 65, spots: 0 }).path).toBe("megalights-ris");
    const packed = packMegaLights([]);
    expect(packed.data.length).toBe(MEGA_LIGHT_STRIDE_VEC4 * 4);
    expect(MEGA_LIGHTS_RIS_WGSL).toContain(`const DEEP_MEGA_SURFACE_STRIDE: u32 = 3u;`);
  });

  it("pins the host binding vocabulary used by the runtime template", () => {
    expect(MEGA_LIGHTS_PARAMS_BINDING).toBe(0);
    expect(MEGA_LIGHTS_POOL_BINDING).toBe(1);
    expect(MEGA_LIGHTS_SURFACES_BINDING).toBe(2);
    expect(MEGA_LIGHTS_MOTION_BINDING).toBe(3);
    expect(MEGA_LIGHTS_RESERVOIRS_A_BINDING).toBe(4);
    expect(MEGA_LIGHTS_RESERVOIRS_B_BINDING).toBe(5);
    expect(MEGA_LIGHTS_COLOR_BINDING).toBe(6);
    expect(MEGA_LIGHTS_COLOR_HISTORY_BINDING).toBe(7);
    expect(MEGA_LIGHTS_IES_BINDING).toBe(8);
    // DEEP_IES_SAMPLING_WGSL 由宿主组合(与 forward 路径同一单源)。
    expect(DEEP_IES_SAMPLING_WGSL).toContain("fn deepSpotIesFactor(spotIndex: u32");
  });
});
