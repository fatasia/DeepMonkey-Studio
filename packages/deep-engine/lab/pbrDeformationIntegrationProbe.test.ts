import { describe, expect, it } from "vitest";
import { prepareRenderPacket } from "../src/renderPacket.js";
import { prepareMorphInput, cpuDeformMorphVertices } from "../src/webgpu/gpuMorphPacking.js";
import { prepareSkinningInput, cpuSkinVertices } from "../src/webgpu/gpuSkinningPacking.js";
import { integrationFixture } from "./pbrDeformationIntegrationProbeFixture.js";
import { integrationMaterialFixture } from "./pbrDeformationIntegrationProbeMaterials.js";

describe("production renderer deformation probe fixture", () => {
  it.each(["skin", "morph", "morph-skin"] as const)("packs %s material variants with independent texture slots and HiZ eligible instances", kind => {
    const prepared = prepareRenderPacket(integrationMaterialFixture(kind).packet);
    expect(prepared.textures).toHaveLength(6);
    expect(prepared.batches.map(batch => batch.alphaMode).sort()).toEqual(["BLEND", "MASK", "OPAQUE"]);
    expect(prepared.batches.find(batch => batch.alphaMode === "MASK")!.count).toBe(128);
    for (const batch of prepared.batches) {
      expect(batch.textures?.normal).toBeDefined(); expect(batch.textures?.emissive?.texCoord).toBe(1);
      expect(batch.textures?.metallicRoughness).toBeDefined(); expect(batch.textures?.occlusion).toBeDefined();
    }
  });
  it.each(["skin", "morph", "morph-skin"] as const)("packs mixed %s geometry and produces the independent 0.7 displacement oracle", kind => {
    const { packet, moved } = integrationFixture(kind), prepared = prepareRenderPacket(packet);
    expect(prepared.batches.filter(batch => batch.pose !== undefined).map(batch => batch.count).sort((a, b) => a - b)).toEqual([1, 64]);
    expect(prepared.batches.filter(batch => batch.pose === undefined)).toHaveLength(1);
    const source = packet.deformation!.sources[0]!, pose = moved.poses[0]!;
    const original = (source.morph?.positions ?? source.skinning!.positions).slice();
    let positions = original.slice();
    if (source.morph) {
      const output = cpuDeformMorphVertices(prepareMorphInput(source.morph, pose.morphWeights!));
      positions = new Float32Array(original.length);
      for (let vertex = 0; vertex < 3; vertex++) positions.set(output.subarray(vertex * 12, vertex * 12 + 3), vertex * 3);
    }
    if (source.skinning) {
      const output = cpuSkinVertices(prepareSkinningInput({ ...source.skinning, positions }, pose.palette!));
      for (let vertex = 0; vertex < 3; vertex++) positions.set(output.subarray(vertex * 8, vertex * 8 + 3), vertex * 3);
    }
    for (let vertex = 0; vertex < 3; vertex++) {
      expect(positions[vertex * 3]! - original[vertex * 3]!).toBeCloseTo(0.7, 6);
      expect(positions[vertex * 3 + 1]).toBeCloseTo(original[vertex * 3 + 1]!, 6);
    }
    expect(moved.poses[1]).toBe(packet.deformation!.poses[1]);
  });
});
