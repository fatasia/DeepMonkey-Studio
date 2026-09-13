import { describe, expect, it, vi } from "vitest";
import { prepareRenderPacket, type GeometryResource, type PreparedPacket } from "../renderPacket.js";
import type { GpuResidencyUploadRequest } from "../streaming/index.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import { createPacketResidencyCatalog } from "./packetResidencyCatalog.js";

function geometry(id = "mesh", revision = 3): GeometryResource {
  return { id, revision,
    vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    uv0: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
}

function decodedTexture(id = "base", revision = 7): DecodedTexture {
  return { id, revision, semantic: "baseColor", width: 4, height: 4,
    data: new Uint8Array(64).fill(1), mipmaps: [
      { width: 2, height: 2, data: new Uint8Array(16).fill(2) },
      { width: 1, height: 1, data: new Uint8Array(4).fill(3) },
    ] };
}

function packet(sameId = false): PreparedPacket {
  const geometryId = sameId ? "shared" : "mesh", textureId = sameId ? "shared" : "base";
  return prepareRenderPacket({ geometries: [geometry(geometryId)], textures: [decodedTexture(textureId)],
    materials: [{ id: "mat", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
      baseColorTexture: { texture: textureId } }],
    instances: [{ id: "instance", geometry: geometryId, material: "mat",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
  });
}

function request(changes: Partial<GpuResidencyUploadRequest> = {}): GpuResidencyUploadRequest {
  return { id: "base", kind: "texture", revision: 7, level: 0, expectedByteLength: 84,
    signal: new AbortController().signal, ...changes };
}

describe("createPacketResidencyCatalog", () => {
  it("builds exact geometry and complete mip-suffix profiles and default closure", () => {
    const catalog = createPacketResidencyCatalog(packet());
    expect(catalog.profiles).toEqual([
      { id: "mesh", revision: 3, kind: "geometry",
        levels: [{ level: 0, byteLength: 132, sourceId: "mesh" }] },
      { id: "base", revision: 7, kind: "texture", levels: [
        { level: 0, byteLength: 84, sourceId: "base" },
        { level: 1, byteLength: 20, sourceId: "base" },
        { level: 2, byteLength: 4, sourceId: "base" },
      ] },
    ]);
    expect(catalog.requests).toEqual([
      { id: "mesh", kind: "geometry", desiredLevel: 0, required: true },
      { id: "base", kind: "texture", desiredLevel: 0, required: true },
    ]);
    const texture = catalog.sourceFor(request({ level: 1, expectedByteLength: 20 }));
    expect(texture.kind).toBe("texture");
    if (texture.kind === "texture" && "levels" in texture.source.texture) {
      expect(texture.source).toMatchObject({ level: 1, texture: { id: "base", byteLength: 20 } });
      expect(texture.source.texture.levels.map(level => [level.width, level.height, level.byteLength]))
        .toEqual([[2, 2, 16], [1, 1, 4]]);
    }
    expect(catalog.sourceFor(request({ id: "mesh", kind: "geometry", revision: 3,
      level: 0, expectedByteLength: 132 }))).toMatchObject({ kind: "geometry",
      source: { id: "mesh", revision: 3 } });
  });

  it("keeps equal public geometry and texture ids separate by kind", () => {
    const catalog = createPacketResidencyCatalog(packet(true));
    expect(catalog.profiles.map(profile => `${profile.kind}:${profile.id}`))
      .toEqual(["geometry:shared", "texture:shared"]);
    expect(catalog.sourceFor(request({ id: "shared", kind: "geometry", revision: 3,
      expectedByteLength: 132 }))).toMatchObject({ kind: "geometry" });
    expect(catalog.sourceFor(request({ id: "shared" }))).toMatchObject({ kind: "texture" });
  });

  it("exposes only block-aligned compressed suffix bases while retaining tail mips", () => {
    const compressed: DecodedTexture = { id: "base", revision: 7, semantic: "baseColor",
      compression: "bc1-rgba", width: 8, height: 8, data: new Uint8Array(32), mipmaps: [
        { width: 4, height: 4, data: new Uint8Array(8) },
        { width: 2, height: 2, data: new Uint8Array(8) },
        { width: 1, height: 1, data: new Uint8Array(8) },
      ] };
    const base = packet(), prepared = prepareRenderPacket({
      geometries: Array.from(base.geometries.values()), textures: [compressed],
      materials: [{ id: "mat", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
        baseColorTexture: { texture: "base" } }],
      instances: [{ id: "instance", geometry: "mesh", material: "mat",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
    });
    const catalog = createPacketResidencyCatalog(prepared);
    expect(catalog.profiles[1]?.levels).toEqual([
      { level: 0, byteLength: 56, sourceId: "base" },
      { level: 1, byteLength: 24, sourceId: "base" },
    ]);
    const source = catalog.sourceFor(request({ level: 1, expectedByteLength: 24 }));
    expect(source.kind === "texture" && "levels" in source.source.texture
      && source.source.texture.levels.map(level => [level.width, level.height]))
      .toEqual([[4, 4], [2, 2], [1, 1]]);
    expect(() => catalog.sourceFor(request({ level: 2, expectedByteLength: 16 })))
      .toThrow("Unknown texture residency level");
  });

  it("registers frozen profiles and isolates sources from later packet mutation", () => {
    const prepared = packet(), originalGeometry = prepared.geometries.get("mesh")!;
    const originalTexture = prepared.textures[0]!, register = vi.fn();
    const catalog = createPacketResidencyCatalog(prepared);
    originalGeometry.vertices[0] = 99; originalTexture.levels[0]!.data[0] = 99;
    catalog.registerInto({ register });

    expect(register.mock.calls.map(call => call[0])).toEqual(catalog.profiles);
    expect(Object.isFrozen(catalog.profiles)).toBe(true);
    const geometrySource = catalog.sourceFor(request({ id: "mesh", kind: "geometry",
      revision: 3, expectedByteLength: 132 }));
    const textureSource = catalog.sourceFor(request());
    expect(geometrySource.kind === "geometry" && geometrySource.source.vertices[0]).toBe(0);
    expect(textureSource.kind === "texture" && "levels" in textureSource.source.texture
      && textureSource.source.texture.levels[0]!.data[0]).toBe(1);
  });

  it("rejects duplicate or inconsistent prepared identities", () => {
    const prepared = packet();
    expect(() => createPacketResidencyCatalog({ ...prepared,
      textures: [prepared.textures[0]!, prepared.textures[0]!] })).toThrow("Duplicate prepared texture identity");
    expect(() => createPacketResidencyCatalog({ ...prepared,
      geometries: new Map([["wrong", prepared.geometries.get("mesh")!]]) }))
      .toThrow("Invalid prepared geometry identity");
    expect(() => createPacketResidencyCatalog({ ...prepared, geometries: new Map() }))
      .toThrow("Missing prepared geometry dependency: mesh");
  });

  it("rejects unknown, stale, wrong-sized, and out-of-range upload requests", () => {
    const catalog = createPacketResidencyCatalog(packet());
    expect(() => catalog.sourceFor(request({ id: "missing" }))).toThrow("Unknown GPU residency source");
    expect(() => catalog.sourceFor(request({ revision: 6 }))).toThrow("source variant differs");
    expect(() => catalog.sourceFor(request({ expectedByteLength: 83 }))).toThrow("source variant differs");
    expect(() => catalog.sourceFor(request({ level: 3, expectedByteLength: 1 })))
      .toThrow("Unknown texture residency level");
    expect(() => catalog.sourceFor(request({ id: "mesh", kind: "texture",
      revision: 3, expectedByteLength: 132 }))).toThrow("Unknown GPU residency source: texture:mesh");
  });
});
