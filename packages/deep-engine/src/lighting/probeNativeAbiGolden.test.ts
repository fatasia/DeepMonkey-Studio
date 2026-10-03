import { describe, expect, it } from "vitest";
import { packIrradianceProbeRecord } from "./probeClipmapSampling.js";
import { DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET,
  type ProbeDirectionalVisibilitySh } from "./probeDirectionalVisibilitySh.js";

const SAMPLE = { irradiance: [1, 2, 3] as const, validity: 0.75, meanDistance: 4,
  distanceVariance: 5, occlusionFloor: 0.1, positionOffset: [0.2, -0.3, 0.4] as const };

// 与 Native probe_gi_abi 的 words[0..11] 对拍：两端均使用本机 little-endian f32。
describe("Web/Native irradiance probe ABI golden", () => {
  it("emits the exact 12-f32 / 96-byte cross-end record", () => {
    const bytes = packIrradianceProbeRecord(SAMPLE);
    expect(bytes.byteLength).toBe(96);
    const words = Array.from(new Float32Array(bytes));
    expect(words.slice(0, 12)).toEqual([
      1, 2, 3, 0.75, 4, 5, expect.closeTo(0.1, 5), 0,
      expect.closeTo(0.2, 5), expect.closeTo(-0.3, 5), expect.closeTo(0.4, 5), 0,
    ]);
    expect(words.slice(12)).toEqual(Array(12).fill(0));
  });
  it("keeps repeated pack bytes deterministic for Native hash/rollback contracts", () => {
    const left = new Uint8Array(packIrradianceProbeRecord(SAMPLE));
    const right = new Uint8Array(packIrradianceProbeRecord(SAMPLE));
    expect(Array.from(left)).toEqual(Array.from(right));
  });
  it("F5 方案 A：words[12..23] 启用为 RGB L1 SH（channel-major），布局零变更", () => {
    const sh: ProbeDirectionalVisibilitySh = {
      r: [1, 0.5, -0.25, 0.125], g: [2, 0.75, -0.5, 0.375], b: [3, 1, -0.75, 0.625] };
    const words = Array.from(new Float32Array(packIrradianceProbeRecord({ ...SAMPLE, directionalVisibilitySh: sh })));
    expect(words.byteLength ?? words.length).toBe(24);
    expect(words.slice(DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET + 0,
      DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET + 4)).toEqual([...sh.r].map(Math.fround));
    expect(words.slice(DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET + 4,
      DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET + 8)).toEqual([...sh.g].map(Math.fround));
    expect(words.slice(DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET + 8,
      DEEP_GI_PROBE_VISIBILITY_SH_WORD_OFFSET + 12)).toEqual([...sh.b].map(Math.fround));
    // 前置 48B 字段不得因 reserved 启用改变（native 合同原文约束）。
    expect(words.slice(0, 12)).toEqual(Array.from(new Float32Array(packIrradianceProbeRecord(SAMPLE))).slice(0, 12));
  });
});
