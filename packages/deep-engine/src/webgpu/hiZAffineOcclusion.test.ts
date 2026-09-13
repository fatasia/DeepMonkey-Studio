import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { HI_Z_AFFINE_DEPTH_WGSL } from "../../lab/hiZAffineOcclusionProbe.js";
import { HI_Z_AFFINE_VIEW, hiZAffineDepthSamples, hiZAffineProbeCases } from "../../lab/hiZAffineProbeScene.js";
import { conservativeAffineScale } from "./affineSphereBounds.js";
import { packCullingInstances } from "./gpuFrustumCulling.js";
import { hiZOcclusionVisible, projectHiZOcclusionAabb } from "./hiZOcclusionProjection.js";

function project(index: number, legacy = false) {
  const item = hiZAffineProbeCases()[index]!, packed = new Float32Array(packCullingInstances([item.instance]));
  const rows = [0, 4, 8].map(offset => [0, 1, 2].map(axis => Math.abs(packed[offset + axis]!)));
  const normInf = Math.max(...rows.map(row => row.reduce((a, b) => a + b, 0)));
  const normOne = Math.max(...[0, 1, 2].map(axis => rows.reduce((sum, row) => sum + row[axis]!, 0)));
  const scale = legacy ? Math.sqrt(normInf * normOne) : conservativeAffineScale(packed, 0);
  // Leave the same generous error allowance used by GPU arithmetic; the fixture must have room for it.
  const radius = .1 * scale * (1 + 2e-6) + Math.hypot(packed[3]!, packed[7]!, packed[11]!) * 2e-6;
  return projectHiZOcclusionAabb([packed[3]!, packed[7]!, packed[11]!], radius,
    HI_Z_AFFINE_VIEW, [0, 0, 5], [64, 64], 7, false);
}

describe("Hi-Z affine occlusion GPU fixture oracle", () => {
  it("isolates a rotated hidden object that the old norm-product bound must retain", () => {
    for (const index of [0, 1, 2, 3]) {
      const projection = project(index);
      expect(projection.testable).toBe(true); expect(projection.mip).toBe(3);
      const samples = hiZAffineDepthSamples(projection.uvRect!, projection.mip!);
      expect(samples).toEqual([.3, .3, .3, .3]);
      expect(hiZOcclusionVisible(projection.objectNearDepth!, samples, false)).toBe(false);
    }
    for (const index of [1, 2, 3]) {
      const legacy = project(index, true);
      expect(legacy.testable).toBe(true); expect(legacy.mip).toBe(4);
      const samples = hiZAffineDepthSamples(legacy.uvRect!, legacy.mip!);
      expect(samples).toEqual([1, 1, 1, 1]);
      expect(hiZOcclusionVisible(legacy.objectNearDepth!, samples, false)).toBe(true);
    }
  });
  it("retains exposed sheared, reflected and nonuniform bounds", () => {
    for (const index of [4, 5, 6]) {
      const projection = project(index);
      expect(projection.testable).toBe(true);
      expect(hiZOcclusionVisible(projection.objectNearDepth!, hiZAffineDepthSamples(projection.uvRect!, projection.mip!), false)).toBe(true);
      const matrix = hiZAffineProbeCases()[index]!.instance.modelMatrix;
      // This concrete point belongs to the local sphere and remains outside the occluder's right edge.
      const x = matrix[0]! * .1 + matrix[12]!;
      expect(x).toBeGreaterThan(.25);
    }
    expect(project(7)).toMatchObject({ testable: false, reason: "clip-boundary" });
  });
  it.each([false, true])("keeps invalid depth samples and clip boundaries visible (reversed=%s)", reversed => {
    for (const depth of [NaN, Infinity, -Infinity, -.01, 1.01]) {
      expect(hiZOcclusionVisible(.5, [depth], reversed)).toBe(true);
    }
    for (const near of [-.01, 0, 1, 1.01]) expect(hiZOcclusionVisible(near, [.3], reversed)).toBe(true);
  });
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates the real depth-occluder shader with Naga", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-hiz-affine-depth.wgsl", "--input-kind", "wgsl"],
      { input: HI_Z_AFFINE_DEPTH_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Validation successful");
  });
});
