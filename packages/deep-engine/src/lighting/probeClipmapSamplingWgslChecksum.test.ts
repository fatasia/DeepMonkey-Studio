// WGSL 单源试点的 TS 半字节门禁。证明三件事:
// 1) 生成镜像不陈旧:TS 模块导出的 WGSL 与真源 wgsl/probeClipmapSampling.wgsl 逐字节一致
//    (vitest 经 ?raw 按字节读真源,与导出串直接比对);
// 2) 跨宿主对拍:TS 宿主拿到的字节 SHA-256 与共享夹具 .sha256(<hex> <byteLen>)一致——
//    Rust 半(deep-engine-native/src/probe_gi_wgsl.rs shared_wgsl_matches_pinned_checksum)
//    用 crate 内 sha256 对同一夹具对拍,两半同时绿 ⇔ 双端逐字节一致;
// 3) ABI 常量与真源插值点字面一致:生成器把插值固化成字面量,常量若再漂移会在这里暴露。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import pinnedChecksum from "../../wgsl/probeClipmapSampling.wgsl.sha256?raw";
import sharedWgsl from "../../wgsl/probeClipmapSampling.wgsl?raw";
import { DEEP_GI_CASCADE_BLEND_CELLS, DEEP_GI_LEVEL_METADATA_BINDING,
  DEEP_GI_MIN_SAMPLE_WEIGHT, DEEP_GI_NORMAL_BIAS_CELLS, DEEP_GI_NORMAL_WEIGHT_BIAS,
  DEEP_GI_PROBE_STORAGE_BINDING, DEEP_GI_PROBES_PER_LEVEL_SAMPLE, DEEP_GI_SAMPLING_BIND_GROUP,
  PROBE_CLIPMAP_SAMPLING_WGSL } from "./probeClipmapSamplingWgsl.js";

const [checksum, byteLength] = pinnedChecksum.trim().split(/\s+/);

describe("WGSL single-source cross-host gate (TS half)", () => {
  it("generated mirror is byte-identical to the shared source file", () => {
    expect(PROBE_CLIPMAP_SAMPLING_WGSL).toBe(sharedWgsl);
  });

  it("matches the pinned cross-host checksum fixture", () => {
    const bytes = new TextEncoder().encode(PROBE_CLIPMAP_SAMPLING_WGSL);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
    expect(bytes.length).toBe(Number(byteLength));
  });

  it("keeps the exported ABI constants in lockstep with the pinned WGSL literals", () => {
    // 常量本身是 CPU 侧 ABI 预算(含未插值的 ABI_VERSION/MAX_*),此处守护的是
    // 真源中已固化的 8 个插值点;任何一端单独改值都会让字面匹配失败。
    expect(PROBE_CLIPMAP_SAMPLING_WGSL)
      .toContain(`@group(${DEEP_GI_SAMPLING_BIND_GROUP}) @binding(${DEEP_GI_PROBE_STORAGE_BINDING})`);
    expect(PROBE_CLIPMAP_SAMPLING_WGSL)
      .toContain(`@group(${DEEP_GI_SAMPLING_BIND_GROUP}) @binding(${DEEP_GI_LEVEL_METADATA_BINDING})`);
    expect(PROBE_CLIPMAP_SAMPLING_WGSL).toContain(`corner < ${DEEP_GI_PROBES_PER_LEVEL_SAMPLE}u`);
    expect(PROBE_CLIPMAP_SAMPLING_WGSL).toContain(`pow(cosine, ${DEEP_GI_NORMAL_WEIGHT_BIAS}.0)`);
    expect(PROBE_CLIPMAP_SAMPLING_WGSL).toContain(`originSpacing.w * ${DEEP_GI_NORMAL_BIAS_CELLS};`);
    expect(PROBE_CLIPMAP_SAMPLING_WGSL)
      .toContain(`smoothstep(0.0, ${DEEP_GI_CASCADE_BLEND_CELLS},`);
    expect(PROBE_CLIPMAP_SAMPLING_WGSL.split(`>= ${DEEP_GI_MIN_SAMPLE_WEIGHT}`).length - 1).toBe(5);
  });
});
