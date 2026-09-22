import { describe, expect, it } from "vitest";
import { DEEP_GI_PROBE_RECORD_BYTES } from "./probeClipmapPlan.js";
import {
  NATIVE_PROBE_GRID_MAX_PROBES,
  packNativeProbeGridRecords,
} from "./nativeProbeGridPacker.js";

const LEVEL = {
  origin: [-3, -2, -3] as const,
  spacing: 2,
  gridSize: [2, 2, 2] as const,
};

const PROBE = {
  irradiance: [0.5, 0.25, 0.125] as const,
  validity: 1,
  meanDistance: 1_000_000,
  distanceVariance: 0,
};

function words(buffer: ArrayBuffer): number[] {
  return Array.from(new Float32Array(buffer));
}

// 与 Native probe_gi_grid.rs 的头解码合同逐字对拍:两端均为小端 f32。
describe("native probe grid packer", () => {
  it("writes the grid header exactly where the Rust decoder reads it", () => {
    const buffer = packNativeProbeGridRecords(LEVEL, Array.from({ length: 8 }, () => PROBE));
    expect(buffer.byteLength).toBe(9 * DEEP_GI_PROBE_RECORD_BYTES);
    const header = words(buffer).slice(0, 24);
    expect(header.slice(0, 8)).toEqual([-3, -2, -3, 2, 2, 2, 2, 1]);
    // maxPosition = origin + gridSize * spacing;保留区 12 字全零。
    expect(header.slice(8, 12)).toEqual([1, 2, 1, 8]);
    expect(header.slice(12)).toEqual(Array(12).fill(0));
  });

  it("keeps probe records in linear index order at record 1..N", () => {
    const probes = Array.from({ length: 8 }, (_, index) => ({
      ...PROBE,
      irradiance: [index, index, index] as const,
    }));
    const buffer = packNativeProbeGridRecords(LEVEL, probes);
    const all = words(buffer);
    for (let index = 0; index < 8; index++) {
      const base = (1 + index) * 24;
      // 每条探针 irradiance 在 record words[0..3];validity 在 [3]。
      expect(all.slice(base, base + 4)).toEqual([index, index, index, 1]);
    }
  });

  it("is byte-deterministic for Native hash/rollback contracts", () => {
    const probes = Array.from({ length: 8 }, () => PROBE);
    const left = new Uint8Array(packNativeProbeGridRecords(LEVEL, probes));
    const right = new Uint8Array(packNativeProbeGridRecords(LEVEL, probes));
    expect(Array.from(left)).toEqual(Array.from(right));
  });

  it("carries relocation offsets and occlusion floor through the standard record pack", () => {
    const buffer = packNativeProbeGridRecords(LEVEL, [
      { ...PROBE, occlusionFloor: 0.25, positionOffset: [0.5, -0.5, 1.0] },
      ...Array.from({ length: 7 }, () => PROBE),
    ]);
    const first = words(buffer).slice(24, 48);
    expect(first.slice(8, 11)).toEqual([0.5, -0.5, 1]);
    expect(first[6]).toBeCloseTo(0.25, 5);
  });

  it.each([
    ["zero spacing", { ...LEVEL, spacing: 0 }, 8, "invalid-spacing"],
    ["grid too small", { ...LEVEL, gridSize: [1, 2, 2] as const }, 8, "invalid-grid-size"],
    ["grid too large", { ...LEVEL, gridSize: [65, 2, 2] as const }, 8, "invalid-grid-size"],
  ])("fail-closed on %s", (_name, level, probeCount, message) => {
    expect(() => packNativeProbeGridRecords(level, Array.from({ length: probeCount }, () => PROBE)))
      .toThrow(message);
  });

  it("fail-closed when probe count does not match grid volume", () => {
    expect(() => packNativeProbeGridRecords(LEVEL, Array.from({ length: 7 }, () => PROBE)))
      .toThrow("probe-count-mismatch");
  });

  it("fail-closed on out-of-budget grids", () => {
    const volume = NATIVE_PROBE_GRID_MAX_PROBES + 1;
    const gridX = 64, gridY = 64;
    const gridZ = Math.ceil(volume / (gridX * gridY));
    expect(() => packNativeProbeGridRecords(
      { ...LEVEL, gridSize: [gridX, gridY, gridZ] },
      Array.from({ length: gridX * gridY * gridZ }, () => PROBE),
    )).toThrow("probe-budget-exceeded");
  });

  it("fail-closed on invalid probe records", () => {
    const make = (probe: Record<string, unknown>) => packNativeProbeGridRecords(
      LEVEL,
      Array.from({ length: 8 }, (_, index) => (index === 0 ? { ...PROBE, ...probe } : PROBE)),
    );
    expect(() => make({ validity: 1.5 })).toThrow("invalid-probe-record");
    expect(() => make({ irradiance: [-1, 0, 0] })).toThrow("invalid-probe-record");
    expect(() => make({ meanDistance: -1 })).toThrow("invalid-probe-record");
    expect(() => make({ positionOffset: [99, 0, 0] })).toThrow("invalid-probe-record");
    expect(() => make({ occlusionFloor: 2 })).toThrow("invalid-probe-record");
  });
});
