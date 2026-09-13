import { describe, expect, it } from "vitest";
import { prepareRenderPacket, type GeometryResource, type RenderPacket } from "../renderPacket.js";
import { createPacketResidencyRequestPlanner,
  planPacketResidencyRequests } from "./packetResidencyRequestPlanner.js";

const TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function geometry(id: string, triangles: number): GeometryResource {
  const patterns = [[0, 1, 2], [0, 2, 3], [0, 3, 1]];
  return { id, revision: 1,
    vertices: new Float32Array([
      0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1,
      1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1,
    ]),
    uv0: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array(patterns.slice(0, triangles).flat()),
  };
}

function packet(middleResident = true) {
  return prepareRenderPacket({
    geometries: [geometry("fine", 3), geometry("middle", 2), geometry("coarse", 1)],
    textures: [{ id: "base", revision: 1, semantic: "baseColor", width: 4, height: 4,
      data: new Uint8Array(64), mipmaps: [
        { width: 2, height: 2, data: new Uint8Array(16) },
        { width: 1, height: 1, data: new Uint8Array(4) },
      ] }],
    materials: [{ id: "material", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
      baseColorTexture: { texture: "base" } }],
    instances: ["a", "b"].map(id => ({ id, geometry: "fine", material: "material",
      transform: TRANSFORM, lod: { levels: [
        { geometry: "fine", minProjectedDiameterPixels: 100, geometricError: 0 },
        { geometry: "middle", minProjectedDiameterPixels: 20, geometricError: 1,
          resident: middleResident },
        { geometry: "coarse", minProjectedDiameterPixels: 0, geometricError: 2 },
      ] } })),
  });
}

describe("planPacketResidencyRequests", () => {
  it("plans distinct visible object LODs, required fallback and texture mip deterministically", () => {
    const prepared = packet(), batch = prepared.batches[0]!;
    const demands = [
      { batchKey: batch.key, instanceId: "b", desiredLod: 1, priority: 2 },
      { batchKey: batch.key, instanceId: "a", desiredLod: 0, priority: 4 },
    ];
    const requests = planPacketResidencyRequests(prepared, demands,
      { textureMipLevels: new Map([["base", 1]]) });
    expect(requests).toEqual([
      { kind: "geometry", id: "fine", desiredLevel: 0, priority: 4, required: false },
      { kind: "geometry", id: "middle", desiredLevel: 0, priority: 2, required: false },
      { kind: "geometry", id: "coarse", desiredLevel: 0, priority: 4, required: true },
      { kind: "texture", id: "base", desiredLevel: 1, priority: 4, required: true },
    ]);
    expect(planPacketResidencyRequests(prepared, [...demands].reverse(),
      { textureMipLevels: new Map([["base", 1]]) })).toEqual(requests);
  });

  it("isolates compiled planner state across failures and repeated demand orders", () => {
    const prepared = packet(), batch = prepared.batches[0]!;
    const planner = createPacketResidencyRequestPlanner(prepared);
    const demands = [
      { batchKey: batch.key, instanceId: "a", desiredLod: 0, priority: 4 },
      { batchKey: batch.key, instanceId: "b", desiredLod: 1, priority: 2 },
    ];
    const options = { textureMipLevels: new Map([["base", 1]]) };
    const expected = planPacketResidencyRequests(prepared, demands, options);
    expect(planner.plan(demands, options)).toEqual(expected);
    expect(planner.plan([...demands].reverse(), options)).toEqual(expected);
    expect(() => planner.plan([
      { batchKey: batch.key, desiredLod: 0, priority: 99 },
      { batchKey: batch.key, desiredLod: 99 },
    ])).toThrow("Desired LOD");
    const negative = [{ batchKey: batch.key, desiredLod: 0, priority: -7 }];
    expect(planner.plan(negative)).toEqual(planPacketResidencyRequests(prepared, negative));
    expect(planner.plan([])).toEqual(planPacketResidencyRequests(prepared, []));
  });

  it("snapshots all externally mutable planning metadata", () => {
    const prepared = packet(), sourceBatch = prepared.batches[0]!;
    const instanceIds = [...sourceBatch.instanceIds];
    const lodLevels = sourceBatch.lod!.levels.map(level => ({ ...level }));
    const textureSlot = { ...sourceBatch.textures!.baseColor! };
    const textureLevels = prepared.textures[0]!.levels.map(level => ({ ...level }));
    const mutableBatch = { ...sourceBatch, instanceIds,
      textures: { ...sourceBatch.textures!, baseColor: textureSlot },
      lod: { ...sourceBatch.lod!, levels: lodLevels } };
    const mutablePacket = { geometries: new Map(prepared.geometries),
      textures: [{ ...prepared.textures[0]!, levels: textureLevels }], batches: [mutableBatch] };
    const planner = createPacketResidencyRequestPlanner(mutablePacket);
    const key = mutableBatch.key;
    const expected = planner.plan([{ batchKey: key, instanceId: "a", desiredLod: 0 }],
      { textureMipLevels: new Map([["base", 1]]) });

    mutablePacket.geometries.clear(); mutablePacket.textures.length = 0; mutablePacket.batches.length = 0;
    mutableBatch.key = "changed"; instanceIds[0] = "changed";
    lodLevels[0]!.geometry = "changed"; lodLevels[0]!.resident = false;
    textureSlot.texture = "changed"; textureLevels[0]!.width = 1;

    expect(planner.plan([{ batchKey: key, instanceId: "a", desiredLod: 0 }],
      { textureMipLevels: new Map([["base", 1]]) })).toEqual(expected);
    expect(() => planner.plan([{ batchKey: "changed" }])).toThrow("Unknown packet residency batch");
    expect(() => planner.plan([{ batchKey: key, instanceId: "changed" }]))
      .toThrow("Unknown packet residency instance");
  });

  it("skips author-disabled detail while preserving the complete packet base closure", () => {
    const prepared = packet(false), batch = prepared.batches[0]!;
    expect(planPacketResidencyRequests(prepared, []).map(value => [value.id, value.required]))
      .toEqual([["coarse", true], ["base", true]]);
    expect(planPacketResidencyRequests(prepared,
      [{ batchKey: batch.key, desiredLod: 1 }]).map(value => [value.id, value.required]))
      .toEqual([["coarse", true], ["base", true]]);
  });

  it("deduplicates shared non-LOD resources with maximum priority", () => {
    const source: RenderPacket = {
      geometries: [geometry("shared", 1)],
      materials: [
        { id: "one", baseColor: [1, 1, 1], metallic: 0, roughness: 1 },
        { id: "two", baseColor: [0, 0, 0], metallic: 0, roughness: 1, doubleSided: true },
      ],
      instances: [
        { id: "one", geometry: "shared", material: "one", transform: TRANSFORM },
        { id: "two", geometry: "shared", material: "two", transform: TRANSFORM },
      ],
    };
    const prepared = prepareRenderPacket(source);
    const demands = prepared.batches.map((batch, index) => ({ batchKey: batch.key, priority: index + 1 }));
    expect(planPacketResidencyRequests(prepared, demands)).toEqual([
      { kind: "geometry", id: "shared", desiredLevel: 0, priority: 2, required: true },
    ]);
  });

  it("keeps negative detail priorities separate while the base closure stays required", () => {
    const prepared = packet(), batch = prepared.batches[0]!;
    expect(planPacketResidencyRequests(prepared, [
      { batchKey: batch.key, desiredLod: 0, priority: -5 },
      { batchKey: batch.key, desiredLod: 1, priority: -3 },
    ])).toEqual([
      { kind: "geometry", id: "fine", desiredLevel: 0, priority: -5, required: false },
      { kind: "geometry", id: "middle", desiredLevel: 0, priority: -3, required: false },
      { kind: "geometry", id: "coarse", desiredLevel: 0, priority: 0, required: true },
      { kind: "texture", id: "base", desiredLevel: 0, priority: 0, required: true },
    ]);
  });

  it("only requests independently uploadable compressed mip suffixes", () => {
    const prepared = prepareRenderPacket({
      geometries: [geometry("shared", 1)],
      textures: [{ id: "compressed", revision: 1, semantic: "baseColor",
        compression: "bc1-rgba", width: 8, height: 8, data: new Uint8Array(32), mipmaps: [
          { width: 4, height: 4, data: new Uint8Array(8) },
          { width: 2, height: 2, data: new Uint8Array(8) },
          { width: 1, height: 1, data: new Uint8Array(8) },
        ] }],
      materials: [{ id: "material", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
        baseColorTexture: { texture: "compressed" } }],
      instances: [{ id: "instance", geometry: "shared", material: "material", transform: TRANSFORM }],
    });
    expect(planPacketResidencyRequests(prepared, [],
      { textureMipLevels: new Map([["compressed", 1]]) }).at(-1)).toMatchObject({
        kind: "texture", id: "compressed", desiredLevel: 1,
      });
    expect(() => planPacketResidencyRequests(prepared, [],
      { textureMipLevels: new Map([["compressed", 2]]) })).toThrow("texture mip target is invalid");
    const invalidBase = { ...prepared, textures: prepared.textures.map(texture => ({ ...texture,
      levels: texture.levels.map((level, index) => index === 0
        ? { ...level, width: 2, height: 2 } : level) })) };
    expect(() => createPacketResidencyRequestPlanner(invalidBase))
      .toThrow("Compressed texture has no independently uploadable level");
  });

  it("rejects unknown visibility identities, impossible LODs and invalid texture mips", () => {
    const prepared = packet(), batch = prepared.batches[0]!;
    expect(() => planPacketResidencyRequests(prepared, [{ batchKey: "missing" }]))
      .toThrow("Unknown packet residency batch");
    expect(() => planPacketResidencyRequests(prepared,
      [{ batchKey: batch.key, instanceId: "missing" }])).toThrow("Unknown packet residency instance");
    expect(() => planPacketResidencyRequests(prepared,
      [{ batchKey: batch.key, desiredLod: 3 }])).toThrow("Desired LOD");
    expect(() => planPacketResidencyRequests(prepared, [{ batchKey: batch.key }],
      { textureMipLevels: new Map([["base", 3]]) })).toThrow("texture mip target is invalid");
    expect(() => planPacketResidencyRequests(prepared, [],
      { textureMipLevels: new Map([["missing", 0]]) })).toThrow("Unknown packet residency texture");
    expect(() => planPacketResidencyRequests(prepared,
      [{ batchKey: "missing", instanceId: "missing", desiredLod: 99, priority: Number.POSITIVE_INFINITY }]))
      .toThrow("Unknown packet residency batch");
    expect(() => planPacketResidencyRequests(prepared,
      [{ batchKey: batch.key, instanceId: "missing", desiredLod: 99, priority: Number.POSITIVE_INFINITY }]))
      .toThrow("Unknown packet residency instance");
    expect(() => planPacketResidencyRequests(prepared,
      [{ batchKey: batch.key, desiredLod: 99, priority: Number.POSITIVE_INFINITY }]))
      .toThrow("priority");
  });
});
