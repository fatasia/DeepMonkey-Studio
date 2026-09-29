// C3 矩形/带纹理面积光(LTC)家族的 TS 半字节门禁(形态照抄 iesSamplingWgslChecksum.test.ts):
// 1) 生成镜像不陈旧;2) 共享夹具跨宿主对拍(Rust 半在 lighting_math_wgsl.rs,设计消费点;
// 3) 打包 ABI 字面量与 areaLights.ts 逐字互钉;4) FORWARD_PLUS_PBR_WGSL 组合包含本家族
// 逐字原文,绑定槽位与 pbrLightingBindings 常量互钉(binding 声明留宿主模板)。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/ltcAreaLighting.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/ltcAreaLighting.wgsl?raw";
import { DEEP_AREA_LIGHTING_WGSL } from "./ltcAreaLightingWgsl.js";
import { FORWARD_PLUS_PBR_WGSL } from "./clusterLightingPbrWgsl.js";
import { AREA_LIGHT_FLAG_TEXTURE, AREA_LIGHT_FLAG_TWO_SIDED, AREA_LIGHT_LUT_VEC4S,
  AREA_LIGHT_STRIDE_VEC4, MAX_AREA_LIGHTS } from "./areaLights.js";
import { LTC_ROUGHNESS_FLOOR } from "./ltc.js";
import { FORWARD_PLUS_AREA_COOKIE_SAMPLER_BINDING, FORWARD_PLUS_AREA_COOKIE_TEXTURE_BINDING,
  FORWARD_PLUS_AREA_DATA_BINDING } from "./pbrLightingBindings.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);

describe("area light LTC WGSL single-source cross-host gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(DEEP_AREA_LIGHTING_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(DEEP_AREA_LIGHTING_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the packing ABI literals locked to areaLights.ts", () => {
    expect(DEEP_AREA_LIGHTING_WGSL).toContain(`const DEEP_AREA_LIGHT_MAX: u32 = ${MAX_AREA_LIGHTS}u;`);
    expect(DEEP_AREA_LIGHTING_WGSL).toContain(`const DEEP_AREA_LIGHT_STRIDE: u32 = ${AREA_LIGHT_STRIDE_VEC4}u;`);
    expect(DEEP_AREA_LIGHTING_WGSL).toContain(`const DEEP_AREA_LIGHT_LUT_VEC4S: u32 = ${AREA_LIGHT_LUT_VEC4S}u;`);
    expect(DEEP_AREA_LIGHTING_WGSL).toContain(`const DEEP_AREA_LIGHT_ROUGHNESS_FLOOR: f32 = ${LTC_ROUGHNESS_FLOOR};`);
    expect(DEEP_AREA_LIGHTING_WGSL).toContain(`const DEEP_AREA_LIGHT_FLAG_TWO_SIDED: u32 = ${AREA_LIGHT_FLAG_TWO_SIDED}u;`);
    expect(DEEP_AREA_LIGHTING_WGSL).toContain(`const DEEP_AREA_LIGHT_FLAG_TEXTURE: u32 = ${AREA_LIGHT_FLAG_TEXTURE}u;`);
  });

  it("keeps the delivery kernel contract and stays embedded verbatim in the composed shader", () => {
    // 唯一交付内核(atan2 向量形式因子,拟合/CPU/WGSL 三处同式;无隐藏 π 常数):
    expect(DEEP_AREA_LIGHTING_WGSL).toContain("fn deepAreaPolygonFormFactor(v0: vec3f, v1: vec3f, v2: vec3f, v3: vec3f) -> f32 {");
    expect(DEEP_AREA_LIGHTING_WGSL).toContain("atan2(magnitude, 1.0 + cosine) / magnitude");
    expect(DEEP_AREA_LIGHTING_WGSL).toContain("let specular = fresnel * (signedFactor * amplitude) * radiance * cookie;");
    // 库片段不携带 binding 声明(绑定留在宿主模板);引用的 storage 符号与宿主一致。
    expect(DEEP_AREA_LIGHTING_WGSL).not.toContain("@group(");
    expect(DEEP_AREA_LIGHTING_WGSL).toContain("deepAreaLightData[");
    expect(FORWARD_PLUS_PBR_WGSL).toContain(`@group(3) @binding(${FORWARD_PLUS_AREA_DATA_BINDING}) var<storage, read> deepAreaLightData: array<vec4<f32>>`);
    expect(FORWARD_PLUS_PBR_WGSL).toContain(`@group(3) @binding(${FORWARD_PLUS_AREA_COOKIE_TEXTURE_BINDING}) var deepAreaCookie: texture_2d<f32>`);
    expect(FORWARD_PLUS_PBR_WGSL).toContain(`@group(3) @binding(${FORWARD_PLUS_AREA_COOKIE_SAMPLER_BINDING}) var deepAreaCookieSampler: sampler`);
    expect(FORWARD_PLUS_PBR_WGSL).toContain(DEEP_AREA_LIGHTING_WGSL);
    expect(FORWARD_PLUS_PBR_WGSL).toContain("result += deepAreaLightContribution(base, positionViewInput, normal, view, baseColor, metallic, roughness, dielectric, cookie);");
  });
});
