import { Document } from "@gltf-transform/core";
import * as THREE from "three";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Bytes } from "@bim-studio/deep-engine/shader-package";
import { describe, expect, it } from "vitest";
import { IncrementalProbeBaker, type IncrementalProbeBakeResult } from "./lightmapProbeIncremental";
import { PROBE_BAKE_QUALITY_PRESETS, type ProbeBakeQuality } from "./lightmapProbeRegions";
import type { ProbeBakeOptions } from "./lightmapProbeBaker";
import type { BakeLightState } from "./modelOptimizer";
import { giFixture } from "../../scripts/gi-bake-fixture";

/**
 * 烘焙轴切片一证据:探针烘焙 + 增量重烘。
 * 断言=合同(复用字节一致、增量回环逐位一致、跨实例一致、质量档样本递增),
 * evidence.json 记录全部实测数字;未验证项如实写进 honestNotes。
 */

const lamp = (position: [number, number, number], overrides: Partial<BakeLightState> = {}): BakeLightState => ({
  id: "lamp", name: "移动点光", type: "point", enabled: true, color: "#ffd9a0", intensity: 4,
  direction: [0, 1, 0], position, range: 0.5, ...overrides,
});
const sun = (overrides: Partial<BakeLightState> = {}): BakeLightState => ({
  id: "sun", name: "固定方向光", type: "directional", enabled: true, color: "#ffffff", intensity: 1.1,
  direction: [0.45, 0.8, 0.3], position: [0, 0, 0], range: 100, ...overrides,
});
const lightsRest = [lamp([1.5, 1.6, 1.5]), sun()];
const lightsMoved = [lamp([-1.5, 1.6, -1.5]), sun()];
const options = (lights: BakeLightState[], quality: ProbeBakeQuality): ProbeBakeOptions =>
  ({ quality, lights, ambient: 0.12, ambientColor: "#223" });

function withOccluder(): Document {
  const document = giFixture();
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const geometry = new THREE.BoxGeometry(0.9, 0.9, 0.9).translate(0, 0.45, 0);
  const material = document.createMaterial("occluder").setBaseColorFactor([0.55, 0.55, 0.6, 1]).setMetallicFactor(0);
  const primitive = document.createPrimitive().setMaterial(material);
  for (const [name, source, type] of [["POSITION", "position", "VEC3"], ["NORMAL", "normal", "VEC3"]] as const) {
    primitive.setAttribute(name, document.createAccessor().setBuffer(buffer).setType(type)
      .setArray(new Float32Array(geometry.getAttribute(source).array)));
  }
  primitive.setIndices(document.createAccessor().setBuffer(buffer).setType("SCALAR").setArray(new Uint32Array(geometry.index!.array)));
  document.createScene().addChild(document.createNode().setMesh(document.createMesh().addPrimitive(primitive)));
  geometry.dispose();
  return document;
}

function bytesSha(records: Float32Array): string {
  return sha256Bytes(new Uint8Array(records.buffer, records.byteOffset, records.byteLength));
}

function summarize(result: IncrementalProbeBakeResult) {
  return {
    layoutKey: result.layoutKey,
    quality: result.quality,
    probes: result.probeCount,
    regionsTotal: result.regionCount,
    regionsRebaked: result.regionsRebaked,
    regionsReused: result.regionsReused,
    regionsDirtyByBounds: result.regionsDirtyByBounds,
    lightDirtyBounds: result.lightDirtyBounds,
    externalDirtyBounds: result.externalDirtyBounds,
    prepareMs: round(result.prepareMs),
    hashMs: round(result.hashMs),
    rebakeMs: round(result.rebakeMs),
    totalMs: round(result.totalMs),
    rebakedBytes: result.rebakedBytes,
    reusedBytes: result.reusedBytes,
    regions: result.regions.map(region => ({
      key: region.key,
      decision: region.decision,
      reason: region.reason,
      stateHash: region.stateHash,
      bytesSha256: bytesSha(region.records),
      bakeMs: round(region.bakeMs),
      probes: region.probeCount,
      affectedLightIds: region.affectedLightIds,
      overlappingPrimitives: region.overlappingPrimitives,
      dirtyByBounds: region.dirtyByBounds,
    })),
  };
}

function magnitude(result: IncrementalProbeBakeResult): { direct: number; indirect: number; occlusion: number } {
  let direct = 0, indirect = 0, occlusion = 0, samples = 0;
  for (const region of result.regions) {
    for (let base = 0; base < region.records.length; base += 8) {
      direct += region.records[base]! + region.records[base + 1]! + region.records[base + 2]!;
      indirect += region.records[base + 3]! + region.records[base + 4]! + region.records[base + 5]!;
      occlusion += region.records[base + 6]!;
      samples += 1;
    }
  }
  return { direct: round(direct / samples), indirect: round(indirect / samples), occlusion: round(occlusion / samples) };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function byteHashMap(result: IncrementalProbeBakeResult): Map<string, string> {
  return new Map(result.regions.map(region => [region.key, bytesSha(region.records)]));
}

function stateHashMap(result: IncrementalProbeBakeResult): Map<string, string> {
  return new Map(result.regions.map(region => [region.key, region.stateHash]));
}

describe("baking probe slice 1 evidence", () => {
  it("bakes probes incrementally with byte-identical reuse and records real numbers", async () => {
    const document = withOccluder();
    const baker = new IncrementalProbeBaker();

    const step1 = await baker.bake(document, options(lightsRest, "performance"));
    expect(step1.regionCount).toBeGreaterThan(1);
    expect(step1.regionsRebaked).toBe(step1.regionCount);

    const step2 = await baker.bake(document, options(lightsMoved, "performance"));
    expect(step2.regionsRebaked).toBeGreaterThan(0);
    expect(step2.regionsReused).toBeGreaterThan(0);
    const step1Bytes = byteHashMap(step1);
    const step1States = stateHashMap(step1);
    for (const region of step2.regions) {
      if (region.decision === "reused") {
        expect(region.stateHash).toBe(step1States.get(region.key));
        expect(bytesSha(region.records)).toBe(step1Bytes.get(region.key));
      }
    }

    const step3 = await baker.bake(document, options(lightsRest, "performance"));
    const step3Bytes = byteHashMap(step3);
    for (const [key, hash] of step1States) expect(step3.regions.find(region => region.key === key)!.stateHash).toBe(hash);
    let bitwiseIdentical = true;
    for (const [key, hash] of step1Bytes) if (step3Bytes.get(key) !== hash) bitwiseIdentical = false;
    expect(bitwiseIdentical).toBe(true);

    const fresh = new IncrementalProbeBaker();
    const freshFull = await fresh.bake(document, options(lightsRest, "performance"));
    const freshBytes = byteHashMap(freshFull);
    let crossInstanceIdentical = true;
    for (const [key, hash] of step1Bytes) if (freshBytes.get(key) !== hash) crossInstanceIdentical = false;
    expect(crossInstanceIdentical).toBe(true);

    const sunOff = await baker.bake(document, options([lightsMoved[0]!, { ...sun(), enabled: false }], "performance"));
    expect(sunOff.regionsRebaked).toBe(sunOff.regionCount);

    const evidence = {
      generatedAt: new Date().toISOString(),
      slice: "baking-axis-1: probe bake + incremental rebake",
      contract: {
        recordFloats: 8,
        recordLayout: "directRGB[0..2] indirectRGB[3..5] occlusion[6] reserved[7]",
        normalization: "4π/N spherical integral; direct channel carries an extra π gain from the cosine kernel; consumer divides by π",
        dirtyDomain: "ProbeAabb list aligned with deep-engine probeClipmapPlan semantics, limit 64, converged to scene bounds beyond that",
        reuseRule: "region state hash (sha256 of affected lights + overlapping geometry fingerprints + quality params + layout) is the final reuse gate",
        forcedRebake: "caller-provided dirtyBounds and light-delta dirty bounds force a rebake even when the hash matches",
      },
      scene: {
        name: "gi-fixture (floor/wall/rear) + box occluder",
        bounds: { min: [-2, 0, -2], max: [2, 3, 2] },
        lights: { rest: "lamp@(1.5,1.6,1.5) range0.5 + directional sun", moved: "lamp@(-1.5,1.6,-1.5)" },
      },
      incremental: {
        quality: "performance (indirectSamples 0, so light dirty bounds are pure influence AABBs)",
        step1_fullBake: summarize(step1),
        step2_lampMoved: summarize(step2),
        step3_lampRestored: { ...summarize(step3), stateHashesMatchStep1: true, byteHashesMatchStep1: true, bitwiseConsistent: bitwiseIdentical },
        step4_freshInstanceFullBake: { ...summarize(freshFull), byteHashesMatchStep1: crossInstanceIdentical, note: "fresh baker, empty cache: proves determinism across instances" },
        step5_directionalToggle: { ...summarize(sunOff), note: "directional light influence is the whole scene, so every region rebakes" },
        reuseProof: {
          step2ReusedStateHashesMatchStep1: step2.regions.filter(region => region.decision === "reused")
            .every(region => region.stateHash === step1States.get(region.key)),
          step2ReusedByteHashesMatchStep1: step2.regions.filter(region => region.decision === "reused")
            .every(region => bytesSha(region.records) === step1Bytes.get(region.key)),
          step2RebakeMs: round(step2.rebakeMs),
          step1FullBakeMs: round(step1.rebakeMs),
          rebakedVsFullRatio: round(step2.rebakeMs / Math.max(step1.rebakeMs, 1e-9)),
        },
      },
      qualityTiers: {} as Record<string, unknown>,
      honestNotes: [
        "UV2 lightmap texture baking (atlas) is NOT part of this slice; existing bakeWebLightmap remains full-bake only (planned phase 2).",
        "Indirect propagation beyond the 1.5×range dirty margin is a first-order approximation; callers pass externalDirtyBounds for deeper chains (documented contract).",
        "Reused region records are the cached Float32Array by reference and must be treated as immutable by consumers.",
        "Render path untouched by this slice: no screenshot smoke run; consumer wiring of probe records into GI sampling is a later slice.",
        "Timings are wall-clock from a single run on the dev machine; treat ratios, not absolutes, as the signal.",
        "Probe bake does not split shared-mesh instances (collectTargets first-matrix convention, same as bakeWebLightmap's acceleration input).",
      ],
    };

    const tierResults: Partial<Record<ProbeBakeQuality, IncrementalProbeBakeResult>> = {};
    for (const quality of ["performance", "balanced", "quality"] as const) {
      const tierBaker = new IncrementalProbeBaker();
      tierResults[quality] = await tierBaker.bake(document, options(lightsRest, quality));
    }
    const performance = tierResults.performance!;
    const balanced = tierResults.balanced!;
    const qualityTier = tierResults.quality!;
    const tierSummary = (result: IncrementalProbeBakeResult) => ({
      preset: PROBE_BAKE_QUALITY_PRESETS[result.quality],
      probes: result.probeCount,
      regions: result.regionCount,
      rebakeMs: round(result.rebakeMs),
      ...magnitude(result),
    });
    const tiers = {
      performance: tierSummary(performance),
      balanced: tierSummary(balanced),
      quality: tierSummary(qualityTier),
    };
    evidence.qualityTiers = {
      tiers,
      comparison: {
        method: "tiers use different probe spacing (Unity Progressive Lightmapper style), so per-probe values are not point-comparable; mean magnitudes are reference numbers",
        directionSamples: { performance: PROBE_BAKE_QUALITY_PRESETS.performance.directionSamples, balanced: PROBE_BAKE_QUALITY_PRESETS.balanced.directionSamples, quality: PROBE_BAKE_QUALITY_PRESETS.quality.directionSamples },
        probes: { performance: tiers.performance.probes, balanced: tiers.balanced.probes, quality: tiers.quality.probes },
        rebakeMs: { performance: tiers.performance.rebakeMs, balanced: tiers.balanced.rebakeMs, quality: tiers.quality.rebakeMs },
        meanDirect: { performance: tiers.performance.direct, balanced: tiers.balanced.direct, quality: tiers.quality.direct },
        meanIndirect: { performance: tiers.performance.indirect, balanced: tiers.balanced.indirect, quality: tiers.quality.indirect },
        meanOcclusion: { performance: tiers.performance.occlusion, balanced: tiers.balanced.occlusion, quality: tiers.quality.occlusion },
      },
    };
    expect(PROBE_BAKE_QUALITY_PRESETS.quality.directionSamples)
      .toBeGreaterThan(PROBE_BAKE_QUALITY_PRESETS.performance.directionSamples);
    expect(tiers.quality.probes).toBeGreaterThanOrEqual(tiers.performance.probes);
    expect(magnitude(step1).occlusion).toBeGreaterThan(0);

    const output = path.resolve("../../test-output/baking-probe-20260919-r1");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.info(`[baking-probe] evidence written: ${path.join(output, "evidence.json")}`);
  }, 240_000);
});
