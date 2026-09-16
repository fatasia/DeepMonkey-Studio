import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPacketDeformationSupported, prepareDeformationPoseUpdate, prepareInstanceUpdate, prepareRenderPacket } from "./renderPacket.js";
import { deformationPacket } from "./renderPacketDeformation.testUtils.js";
import * as morphPacking from "./webgpu/gpuMorphPacking.js";
import * as skinPacking from "./webgpu/gpuSkinningPacking.js";
afterEach(() => vi.restoreAllMocks());

describe("render packet deformation projection", () => {
  it.each(["morph", "skin", "morph-skin"] as const)("owns every %s stream and preserves pose batch identity", kind => {
    const packet = deformationPacket(kind), prepared = prepareRenderPacket(packet);
    expect(prepared.deformation).toEqual(packet.deformation); expect(prepared.deformation).not.toBe(packet.deformation);
    expect(prepared.batches[0]!.pose).toBe("pose");
    packet.deformation.sources[0]!.morph?.positions.fill(99);
    packet.deformation.sources[0]!.skinning?.weights.fill(99);
    expect(prepared.deformation!.sources[0]!.morph?.positions[0] ?? 0).toBe(0);
    expect(prepared.deformation!.sources[0]!.skinning?.weights[0] ?? 1).toBe(1);
  });
  it("separates two poses and static instances without changing legacy keys", () => {
    const packet = deformationPacket();
    const other = { ...packet.deformation.poses[0]!, id: "other" };
    const { pose: _pose, ...staticInstance } = packet.instances[0]!;
    const prepared = prepareRenderPacket({ ...packet,
      deformation: { ...packet.deformation, poses: [...packet.deformation.poses, other] },
      instances: [packet.instances[0]!, { ...packet.instances[0]!, id: "otherInstance", pose: "other" }, { ...staticInstance, id: "static" }],
    });
    expect(prepared.batches).toHaveLength(3); expect(new Set(prepared.batches.map(batch => batch.key)).size).toBe(3);
    const legacy = prepareRenderPacket({ geometries: packet.geometries, materials: packet.materials, instances: [staticInstance] });
    expect(prepared.batches.find(batch => batch.pose === undefined)!.key).toBe(legacy.batches[0]!.key);
  });
  it("retains source geometries without current visible instances", () => {
    const packet = deformationPacket(), prepared = prepareRenderPacket({ ...packet, instances: [] });
    expect(prepared.geometries.has("geometry")).toBe(true);
    expect(prepared.geometries.get("geometry")!.vertices).not.toBe(packet.geometries[0]!.vertices);
  });
  it("rejects dangling poses, geometry mismatch, remap mismatch and posed LOD", () => {
    const packet = deformationPacket("morph");
    expect(() => prepareRenderPacket({ ...packet, deformation: undefined } as never)).toThrow("Missing deformation pose");
    expect(() => prepareRenderPacket({ ...packet, instances: [{ ...packet.instances[0]!, pose: "missing" }] })).toThrow("Missing deformation pose");
    expect(() => prepareRenderPacket({ ...packet, deformation: { ...packet.deformation,
      sources: [{ ...packet.deformation.sources[0]!, geometry: "missing" }] } })).toThrow("Missing deformation geometry");
    expect(() => prepareRenderPacket({ ...packet, instances: [{ ...packet.instances[0]!, lod: { levels: [
      { geometry: "geometry", minProjectedDiameterPixels: 0, geometricError: 0 } ] } }] })).toThrow("LOD pose mapping");
    packet.deformation.sources[0]!.morph!.positions[0] = 1;
    expect(() => prepareRenderPacket(packet)).toThrow("remapped geometry");
  });
  it("requires explicit complete dynamic poses and copies no static geometry on hot updates", () => {
    const packet = deformationPacket(), prepared = prepareRenderPacket(packet), retained = prepared.deformation!;
    const morph = vi.spyOn(morphPacking, "prepareMorphInput"), skin = vi.spyOn(skinPacking, "prepareSkinningInput");
    const poses = [{ ...retained.poses[0]!, revision: 2, morphWeights: { revision: 2, values: new Float32Array([0.75]) } }];
    const next = prepareDeformationPoseUpdate(retained, poses, packet.instances)!;
    expect(next.sources).toBe(retained.sources); expect(next.poses[0]!.morphWeights!.values).not.toBe(poses[0]!.morphWeights.values);
    expect(morph).not.toHaveBeenCalled(); expect(skin).not.toHaveBeenCalled();
    expect(() => prepareInstanceUpdate(new Set(["geometry"]), packet, new Map(), retained)).toThrow("explicit poses");
    expect(() => prepareDeformationPoseUpdate(retained, [], packet.instances)).toThrow("complete prepared pose");
    const batches = prepareInstanceUpdate(new Set(["geometry"]), { materials: packet.materials, instances: packet.instances, poses }, new Map(), retained);
    expect(batches[0]!.pose).toBe("pose");
    expect(() => prepareDeformationPoseUpdate(next, retained.poses, packet.instances)).toThrow("Stale");
  });
  it.each([{ deformation: { sources: [], poses: [] } }, { instances: [{ pose: "x" }] }, { batches: [{ pose: "x" }] }, { poses: [] }])(
    "fails closed at unimplemented consumers %j", input => {
      expect(() => assertPacketDeformationSupported(input)).toThrow("not enabled");
      expect(() => assertPacketDeformationSupported(input, true)).not.toThrow();
    });
});
