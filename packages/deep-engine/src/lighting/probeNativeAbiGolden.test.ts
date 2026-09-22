import { describe, expect, it } from "vitest";
import { packIrradianceProbeRecord } from "./probeClipmapSampling.js";

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
});
