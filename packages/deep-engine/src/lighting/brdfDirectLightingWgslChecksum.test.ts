// J2-B1 直射 BRDF 家族的 TS 半字节门禁(形态照抄 probeClipmapSamplingWgslChecksum.test.ts):
// 1) 生成镜像不陈旧;2) 共享夹具跨宿主对拍(Rust 半在 lighting_math_wgsl.rs + frame_bindings
// concat! 消费);3) 组合恒等式锁定:PBR_DIRECT_LIGHTING_WGSL === "\n" + 介电 F0 + "\n" + 本家族,
// 迁移是"换来源不是改内容",该恒等式保证组合产物逐字节不变;
// 4) 白炉验收过的公式字面量(GGX 分母 / 相关 Smith / Schlick)与 TS 权威高光乘法序锁定。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/brdfDirectLighting.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/brdfDirectLighting.wgsl?raw";
import { PBR_BRDF_DIRECT_LIGHTING_WGSL } from "./brdfDirectLightingWgsl.js";
import { MATERIAL_DIELECTRIC_WGSL } from "./materialDielectricWgsl.js";
import { PBR_DIRECT_LIGHTING_WGSL } from "../webgpu/pbrDirectLightingWgsl.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);

describe("direct BRDF WGSL single-source cross-host gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(PBR_BRDF_DIRECT_LIGHTING_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(PBR_BRDF_DIRECT_LIGHTING_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the PBR_DIRECT_LIGHTING_WGSL composition identity byte-stable", () => {
    expect(PBR_DIRECT_LIGHTING_WGSL)
      .toBe(`\n${MATERIAL_DIELECTRIC_WGSL}\n${PBR_BRDF_DIRECT_LIGHTING_WGSL}`);
  });

  it("keeps the white-furnace-validated formula literals and the TS-authoritative specular order", () => {
    expect(PBR_BRDF_DIRECT_LIGHTING_WGSL).toContain("fn brdfWithDielectricF0(n: vec3f, v: vec3f, l: vec3f, base: vec3f, metal: f32, rough: f32, dielectric: f32) -> vec3f {");
    // GGX 分母与相关 Smith visibility(试点审计 W-2 的三个逐字字面量)。
    expect(PBR_BRDF_DIRECT_LIGHTING_WGSL.split("3.14159265").length - 1).toBe(2);
    expect(PBR_BRDF_DIRECT_LIGHTING_WGSL).toContain("let visibility = 0.5 / max(gv + gl, 0.000001);");
    // Schlick 指数。
    expect(PBR_BRDF_DIRECT_LIGHTING_WGSL).toContain("let factor = exp2((-5.55473 * cosine - 6.98316) * cosine);");
    // B1 对齐点:高光乘法序以 TS 为权威(白炉验收基准);native 原为 distribution 起乘,已对齐。
    expect(PBR_BRDF_DIRECT_LIGHTING_WGSL).toContain("let specular = f * visibility * distribution;");
    // 0.04 legacy 包装。
    expect(PBR_BRDF_DIRECT_LIGHTING_WGSL).toContain("return brdfWithDielectricF0(n, v, l, base, metal, rough, 0.04);");
  });
});
