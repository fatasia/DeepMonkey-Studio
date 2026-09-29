// J2-B1 IES 光域网采样家族的 TS 半字节门禁(形态照抄 probeClipmapSamplingWgslChecksum.test.ts):
// 1) 生成镜像不陈旧;2) 共享夹具跨宿主对拍(Rust 半在 lighting_math_wgsl.rs,bin 侧
// frame_bindings concat! 把同一份字节拼进 native mesh shader 真实消费);
// 3) 采样次序合同锁定:行距 stride 与 iesShading.ts 打包端同值、弧度转角度常数、
// 恒等分支;4) FORWARD_PLUS_PBR_WGSL 组合包含本家族逐字原文(binding 声明留在宿主模板)。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/iesSampling.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/iesSampling.wgsl?raw";
import { DEEP_IES_SAMPLING_WGSL } from "./iesSamplingWgsl.js";
import { FORWARD_PLUS_PBR_WGSL } from "./clusterLightingPbrWgsl.js";
import { IES_TABLE_ROW_STRIDE_VEC4 } from "./iesShading.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);

describe("IES sampling WGSL single-source cross-host gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(DEEP_IES_SAMPLING_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(DEEP_IES_SAMPLING_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the row-stride and rad-to-deg literals locked to the packing ABI", () => {
    // 原 TS 插值 ${IES_TABLE_ROW_STRIDE_VEC4}u 被生成器固化为字面量;此处锁定字面值
    // 与打包端常量同值,任何一端单独改值都会在这里暴露。
    expect(DEEP_IES_SAMPLING_WGSL).toContain(`const DEEP_IES_ROW_STRIDE: u32 = ${IES_TABLE_ROW_STRIDE_VEC4}u;`);
    expect(IES_TABLE_ROW_STRIDE_VEC4).toBe(91);
    expect(DEEP_IES_SAMPLING_WGSL).toContain("const DEEP_IES_RAD_TO_DEG: f32 = 57.29577951308232;");
  });

  it("keeps the sampling contract literals and stays embedded verbatim in the composed shader", () => {
    expect(DEEP_IES_SAMPLING_WGSL).toContain("fn deepSpotIesFactor(spotIndex: u32, surfaceToLightDirection: vec3<f32>, lightDirection: vec3<f32>) -> f32 {");
    expect(DEEP_IES_SAMPLING_WGSL).toContain("if (params.x < 0.0) { return 1.0; }");
    expect(DEEP_IES_SAMPLING_WGSL).toContain("return value * params.z;");
    // 库片段不携带 binding 声明(绑定留在宿主模板);引用的 storage 符号与宿主一致。
    expect(DEEP_IES_SAMPLING_WGSL).not.toContain("@group(");
    expect(DEEP_IES_SAMPLING_WGSL).toContain("deepIesShading[");
    expect(FORWARD_PLUS_PBR_WGSL).toContain("@group(3) @binding(12) var<storage, read> deepIesShading: array<vec4<f32>>");
    expect(FORWARD_PLUS_PBR_WGSL).toContain(DEEP_IES_SAMPLING_WGSL);
  });
});
