import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { planIrradianceProbeClipmap, type ProbeClipmapLevel, type ProbeVector3 } from "./probeClipmapPlan.js";
import { packIrradianceProbeRecord, probeClipmapSamplingBudget,
  sampleIrradianceProbeClipmap, type IrradianceProbeRecord } from "./probeClipmapSampling.js";
import { DEEP_GI_LEVEL_METADATA_BINDING, DEEP_GI_MAX_PROBE_FETCHES, DEEP_GI_PROBE_STORAGE_BINDING,
  PROBE_CLIPMAP_SAMPLING_WGSL } from "./probeClipmapSamplingWgsl.js";

const level = (index: number, origin: ProbeVector3, spacing: number,
  gridSize: ProbeVector3): ProbeClipmapLevel => ({
  level: index, origin, spacing, gridSize,
  originCell: origin.map(value => value / spacing) as unknown as ProbeVector3,
  max: origin.map((value, axis) => value + (gridSize[axis]! - 1) * spacing) as unknown as ProbeVector3,
  probeCount: gridSize[0] * gridSize[1] * gridSize[2],
});
const record = (irradiance: ProbeVector3, change: Partial<IrradianceProbeRecord> = {}): IrradianceProbeRecord => ({
  irradiance, validity: 1, meanDistance: 100, distanceVariance: 1, ...change,
});

describe("GI Lite probe clipmap sampling", () => {
  it("matches the existing 96/64-byte buffers and adds no allocation", () => {
    const profile = planIrradianceProbeClipmap({ cameraPosition: [0, 0, 0], sceneBounds: null }).profile;
    expect(probeClipmapSamplingBudget(profile)).toEqual({ abiVersion: 1, bindGroup: 3,
      storageBindings: [DEEP_GI_PROBE_STORAGE_BINDING, DEEP_GI_LEVEL_METADATA_BINDING],
      recordBytes: 96, levelBytes: 64, maxProbeFetches: DEEP_GI_MAX_PROBE_FETCHES,
      probeStorageBytes: 589_824, levelMetadataBytes: 192, additionalGpuBytes: 0 });
    const packed = packIrradianceProbeRecord({ irradiance: [1, 2, 3], validity: 0.75,
      meanDistance: 4, distanceVariance: 5, occlusionFloor: 0.1, positionOffset: [0.2, 0.3, 0.4] });
    expect(packed.byteLength).toBe(96);
    expect(Array.from(new Float32Array(packed).slice(0, 12))).toEqual([
      1, 2, 3, 0.75, 4, 5, expect.closeTo(0.1, 5), 0,
      expect.closeTo(0.2, 5), expect.closeTo(0.3, 5), expect.closeTo(0.4, 5), 0,
    ]);
  });

  it("trilinearly combines all eight bounded probes", () => {
    const fine = level(0, [0, 0, 0], 1, [2, 2, 2]);
    const records = Array.from({ length: 8 }, (_, corner) => record([
      corner & 1, (corner >> 1) & 1, (corner >> 2) & 1,
    ]));
    const sample = sampleIrradianceProbeClipmap({ worldPosition: [0.5, 0.5, 0.5], worldNormal: [0, 1, 0],
      levels: [fine], records });
    expect(sample).toMatchObject({ irradiance: [0.5, 0.5, 0.5], selectedLevel: 0,
      cascadeBlend: 0, sampledProbeCount: 8, fallback: false });
  });

  it("selects the finest containing level and smoothly blends its boundary into the next level", () => {
    const fine = level(0, [0, 0, 0], 1, [4, 4, 4]), coarse = level(1, [-3, -3, -3], 2, [4, 4, 4]);
    const records = [...Array.from({ length: 64 }, () => record([1, 0, 0])),
      ...Array.from({ length: 64 }, () => record([0, 0, 1]))];
    const boundary = sampleIrradianceProbeClipmap({ worldPosition: [0.75, 1.5, 1.5], worldNormal: [0, 1, 0],
      levels: [fine, coarse], records });
    expect(boundary.selectedLevel).toBe(0); expect(boundary.blendedLevel).toBe(1);
    expect(boundary.cascadeBlend).toBeCloseTo(0.5); expect(boundary.irradiance).toEqual([0.5, 0, 0.5]);
    expect(boundary.sampledProbeCount).toBe(16);
    const outsideFine = sampleIrradianceProbeClipmap({ worldPosition: [-1, 0, 0], worldNormal: [0, 1, 0],
      levels: [fine, coarse], records });
    expect(outsideFine).toMatchObject({ selectedLevel: 1, irradiance: [0, 0, 1], fallback: false });
  });

  it("uses biased visibility to suppress leaking probes and falls back when no probe is valid", () => {
    const fine = level(0, [0, 0, 0], 1, [2, 2, 2]);
    const records = Array.from({ length: 8 }, (_, corner) => (corner & 1)
      ? record([0, 0, 0]) : record([10, 10, 10], { meanDistance: 0, distanceVariance: 0 }));
    const occluded = sampleIrradianceProbeClipmap({ worldPosition: [0.5, 0.5, 0.5], worldNormal: [1, 0, 0],
      levels: [fine], records });
    expect(occluded.irradiance.every(value => value < 0.01)).toBe(true);
    const empty = sampleIrradianceProbeClipmap({ worldPosition: [0.5, 0.5, 0.5], worldNormal: [0, 1, 0],
      levels: [fine], records: [], environmentFallback: [0.2, 0.3, 0.4] });
    expect(empty).toMatchObject({ irradiance: [0.2, 0.3, 0.4], fallback: true, accumulatedWeight: 0 });
    const zero = sampleIrradianceProbeClipmap({ worldPosition: [4, 4, 4], worldNormal: [0, 1, 0],
      levels: [fine], records });
    expect(zero).toMatchObject({ irradiance: [0, 0, 0], fallback: true });
  });

  it("rejects invalid records and never trusts an inconsistent level index range", () => {
    expect(() => packIrradianceProbeRecord(record([1, 1, 1], { validity: 2 }))).toThrow("validity");
    const invalid = { ...level(0, [0, 0, 0], 1, [2, 2, 2]), probeCount: Number.MAX_SAFE_INTEGER };
    expect(sampleIrradianceProbeClipmap({ worldPosition: [0.5, 0.5, 0.5], worldNormal: [0, 1, 0],
      levels: [invalid], records: [record([1, 1, 1])], environmentFallback: [0.1, 0.1, 0.1] }))
      .toMatchObject({ irradiance: [0.1, 0.1, 0.1], fallback: true });
  });

  it("keeps every runtime-array access bounded in Naga-valid WGSL", () => {
    expect(PROBE_CLIPMAP_SAMPLING_WGSL).toContain("arrayLength(&deepGiProbeRecords)");
    expect(PROBE_CLIPMAP_SAMPLING_WGSL).toContain("linear >= recordCount - level.baseProbe");
    expect(PROBE_CLIPMAP_SAMPLING_WGSL).toContain("corner < 8u");
    expect(PROBE_CLIPMAP_SAMPLING_WGSL).toContain("smoothstep(0.0, 1.5");
  });
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const code = `${PROBE_CLIPMAP_SAMPLING_WGSL}
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)); return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fragmentMain() -> @location(0) vec4f {
  return vec4f(deepGiSample(vec3f(0.0), vec3f(0.0, 1.0, 0.0), vec3f(0.0)), 1.0);
}`;
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-gi-probe-sampling.wgsl", "--input-kind", "wgsl"], { input: code, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
