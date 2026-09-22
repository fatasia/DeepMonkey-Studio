import { describe, expect, it } from "vitest";
import { DEEP_GI_PROBE_RECORD_BYTES } from "./probeClipmapPlan.js";
import {
  NATIVE_PROBE_GRID_MAX_PROBES,
  packNativeProbeGridLevels,
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

// ---- v2 多层级联合同(与 Rust decode_probe_grid_cascade 逐字对拍) ----

// 粗层:origin [-7,-6,-7]、spacing 8、grid 2³ → 范围 [-7,9]×[-6,10]×[-7,9]
// 完全包含细层 [-3,1]×[-2,2]×[-3,1],spacing 严格递增(与 Rust/GPU 用例同款)。
const COARSE_LEVEL = {
  origin: [-7, -6, -7] as const,
  spacing: 8,
  gridSize: [2, 2, 2] as const,
};

function levelInputs(count: number, overrides?: { fine?: Partial<typeof LEVEL>; coarse?: Partial<typeof COARSE_LEVEL> }) {
  return [
    { level: { ...LEVEL, ...overrides?.fine }, probes: Array.from({ length: 8 }, () => PROBE) },
    ...(count > 1
      ? [{ level: { ...COARSE_LEVEL, ...overrides?.coarse }, probes: Array.from({ length: 8 }, () => PROBE) }]
      : []),
  ];
}

describe("native probe grid cascade packer", () => {
  it("single-level call of packNativeProbeGridRecords stays byte-identical to the legacy contract", () => {
    // 旧单层入口不带布局头:record 0 直接是网格头,baseProbeRecords 恒 1,
    // 保留区全零——旧包解码路径逐位不变。
    const buffer = packNativeProbeGridRecords(LEVEL, Array.from({ length: 8 }, () => PROBE));
    const header = words(buffer).slice(0, 24);
    expect(header[7]).toBe(1);
    expect(header.slice(12)).toEqual(Array(12).fill(0));
  });

  it("writes the v2 layout header into the reserved words and keeps primary words zero", () => {
    const buffer = packNativeProbeGridLevels(levelInputs(1));
    const all = words(buffer);
    // 主 12 字全零(布局头不承载几何)。
    expect(all.slice(0, 12)).toEqual(Array(12).fill(0));
    // 保留区:word12=版本 2、word13=levelCount、word14=levels 起始(恒 1)、其余零。
    expect(all[12]).toBe(2);
    expect(all[13]).toBe(1);
    expect(all[14]).toBe(1);
    expect(all.slice(15, 24)).toEqual(Array(9).fill(0));
    // 层网格头紧跟布局头,baseProbeRecords = 布局头(1)+本层网格头(1) = 2。
    const levelHeader = all.slice(24, 48);
    expect(levelHeader.slice(0, 8)).toEqual([-3, -2, -3, 2, 2, 2, 2, 2]);
    expect(levelHeader.slice(12)).toEqual(Array(12).fill(0));
  });

  it("lays out two levels with extended baseProbeRecords and contiguous probe records", () => {
    const buffer = packNativeProbeGridLevels(levelInputs(2));
    const all = words(buffer);
    expect(all[13]).toBe(2);
    // 细层头在 record 1(base=2),8 探针在 record 2..9;
    // 粗层头在 record 10(base=11 = 1+1+8+1),8 探针在 record 11..18。
    const coarseHeader = all.slice(10 * 24, 11 * 24);
    expect(coarseHeader.slice(0, 8)).toEqual([-7, -6, -7, 8, 2, 2, 2, 11]);
    expect(coarseHeader[11]).toBe(8);
    // 粗层首条探针紧跟其头(record 11),irradiance 在 words[0..3]。
    const firstCoarseProbe = all.slice(11 * 24, 11 * 24 + 4);
    expect(firstCoarseProbe).toEqual([0.5, 0.25, 0.125, 1]);
    expect(buffer.byteLength).toBe((1 + 1 + 8 + 1 + 8) * DEEP_GI_PROBE_RECORD_BYTES);
    // 层内探针记录与单层打包器逐字节一致(同一 packIrradianceProbeRecord 编码)。
    const single = packNativeProbeGridRecords(LEVEL, Array.from({ length: 8 }, () => PROBE));
    expect(Array.from(new Uint8Array(buffer, 2 * DEEP_GI_PROBE_RECORD_BYTES, 8 * DEEP_GI_PROBE_RECORD_BYTES)))
      .toEqual(Array.from(new Uint8Array(single, 1 * DEEP_GI_PROBE_RECORD_BYTES, 8 * DEEP_GI_PROBE_RECORD_BYTES)));
  });

  it("is byte-deterministic for Native hash/rollback contracts", () => {
    const left = new Uint8Array(packNativeProbeGridLevels(levelInputs(2)));
    const right = new Uint8Array(packNativeProbeGridLevels(levelInputs(2)));
    expect(Array.from(left)).toEqual(Array.from(right));
  });

  it.each([
    ["empty levels", []],
    ["five levels", [...levelInputs(2), ...levelInputs(2), ...levelInputs(2)].slice(0, 5)],
  ])("fail-closed on %s", (_name, levels) => {
    expect(() => packNativeProbeGridLevels(levels as never)).toThrow("invalid-level-count");
  });

  it("fail-closed when coarse spacing is not strictly increasing", () => {
    expect(() => packNativeProbeGridLevels(levelInputs(2, { coarse: { spacing: 2 } })))
      .toThrow("invalid-level-nesting");
  });

  it("fail-closed when the coarse range does not contain the fine range", () => {
    expect(() => packNativeProbeGridLevels(levelInputs(2, { coarse: { origin: [10, 10, 10] } })))
      .toThrow("invalid-level-nesting");
    // 粗层范围太小同样拒绝(maxPosition < fine maxPosition)。
    expect(() => packNativeProbeGridLevels(levelInputs(2, { coarse: { spacing: 1 } })))
      .toThrow("invalid-level-nesting");
  });

  it("fail-closed before writing the first byte when a level is invalid", () => {
    expect(() => packNativeProbeGridLevels([
      { level: LEVEL, probes: Array.from({ length: 7 }, () => PROBE) },
    ])).toThrow("probe-count-mismatch");
  });
});
