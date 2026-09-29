// J2-B1 介电 F0 家族的 TS 半字节门禁(形态照抄 probeClipmapSamplingWgslChecksum.test.ts):
// 1) 生成镜像不陈旧:导出串与真源 wgsl/materialDielectric.wgsl 逐字节一致;
// 2) 跨宿主对拍:TS 宿主拿到的字节 SHA-256 与共享夹具 .sha256(<hex> <byteLen>)一致——
//    Rust 半(deep-engine-native/src/lighting_math_wgsl.rs + frame_bindings concat! 消费)
//    对同一夹具对拍,两半同时绿 ⇔ 双端逐字节一致;
// 3) 家族合同锁定:1.5 特例字面量、CPU 孪生函数同值、pbrShader.ts 的 .replace() 手术合同
//    (EXTENDED_MATERIAL_EVALUATION_WGSL 必须逐字包含本串,否则手术静默漏替换)。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/materialDielectric.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/materialDielectric.wgsl?raw";
import { MATERIAL_DIELECTRIC_WGSL } from "./materialDielectricWgsl.js";
import { dielectricF0 } from "../materialDielectric.js";
import { EXTENDED_MATERIAL_EVALUATION_WGSL } from "../shader/materialEvaluateWgsl.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);

describe("dielectric F0 WGSL single-source cross-host gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(MATERIAL_DIELECTRIC_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(MATERIAL_DIELECTRIC_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the ior==1.5 special case and the CPU twin in lockstep", () => {
    expect(MATERIAL_DIELECTRIC_WGSL).toContain("fn deepDielectricF0(encodedIor: f32) -> f32 {");
    expect(MATERIAL_DIELECTRIC_WGSL).toContain("if (encodedIor == 0.0 || encodedIor == 1.5) { return 0.04; }");
    expect(MATERIAL_DIELECTRIC_WGSL).toContain("let reflectance = 1.0 - 2.0 / (encodedIor + 1.0);");
    // CPU 孪生(materialDielectric.dielectricF0)对默认 IOR 保持同一 0.04 特例。
    expect(dielectricF0(1.5)).toBe(0.04);
    expect(dielectricF0(2)).toBeCloseTo((1 - 2 / 3) ** 2, 15);
  });

  it("keeps the pbrShader replace-surgery contract: the extended material kernel embeds this text verbatim", () => {
    // pbrShader.ts: EXTENDED_MATERIAL_EVALUATION_WGSL.replace(MATERIAL_DIELECTRIC_WGSL, "")
    // 依赖本串是内核 WGSL 的逐字子串;字节任何漂移都会让 replace 静默失配。
    expect(EXTENDED_MATERIAL_EVALUATION_WGSL).toContain(MATERIAL_DIELECTRIC_WGSL);
  });
});
