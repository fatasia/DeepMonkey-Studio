import { describe, expect, it } from "vitest";
import {
  prepareInstanceUpdate,
  prepareRenderPacket,
  type GeometryFeatures,
  type GeometryResource,
  type RenderPacket,
} from "./renderPacket.js";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function geometry(id: string, triangles: number, features: { uv?: boolean; tangents?: boolean } = {}): GeometryResource {
  const vertices = new Float32Array([
    0, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 1,
    0, 1, 0, 0, 0, 1,
  ]);
  return {
    id,
    revision: 0,
    vertices,
    indices: new Uint32Array(Array.from({ length: triangles * 3 }, (_, index) => index % 3)),
    ...(features.uv ? { uv0: new Float32Array([0, 0, 1, 0, 0, 1]) } : {}),
    ...(features.tangents ? { tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]) } : {}),
  };
}

function packet(features: { uv?: boolean; tangents?: boolean } = {}): RenderPacket {
  return {
    geometries: [geometry("high", 8, features), geometry("medium", 4, features), geometry("low", 1, features),
      geometry("unused", 2)],
    materials: [{ id: "surface", baseColor: [0.3, 0.5, 0.7], metallic: 0.2, roughness: 0.6 }],
    instances: [{
      id: "part",
      geometry: "high",
      material: "surface",
      transform: identity,
      lod: { hysteresisRatio: 0.15, levels: [
        { geometry: "high", minProjectedDiameterPixels: 120, geometricError: 0, resident: true },
        { geometry: "medium", minProjectedDiameterPixels: 32, geometricError: 0.25, resident: false },
        { geometry: "low", minProjectedDiameterPixels: 0, geometricError: 1 },
      ] },
    }],
  };
}

describe("RenderPacket multi-geometry LOD contract", () => {
  it("freezes an owned profile with authoritative triangle counts and retains every used level", () => {
    const source = packet();
    const prepared = prepareRenderPacket(source);
    expect([...prepared.geometries.keys()]).toEqual(["high", "medium", "low"]);
    expect(prepared.batches[0]!.lod).toEqual({ hysteresisRatio: 0.15, levels: [
      { geometry: "high", minProjectedDiameterPixels: 120, geometricError: 0, triangles: 8, resident: true },
      { geometry: "medium", minProjectedDiameterPixels: 32, geometricError: 0.25, triangles: 4, resident: false },
      { geometry: "low", minProjectedDiameterPixels: 0, geometricError: 1, triangles: 1, resident: true },
    ] });
    expect(Object.isFrozen(prepared.batches[0]!.lod)).toBe(true);
    expect(Object.isFrozen(prepared.batches[0]!.lod!.levels)).toBe(true);
    expect(prepared.batches[0]!.lod!.levels.every(Object.isFrozen)).toBe(true);
    const mutable = source.instances[0]!.lod!.levels as { geometry: string; minProjectedDiameterPixels: number }[];
    mutable[1]!.geometry = "unused";
    mutable[1]!.minProjectedDiameterPixels = 1;
    expect(prepared.batches[0]!.lod!.levels[1]).toMatchObject({ geometry: "medium", minProjectedDiameterPixels: 32 });
  });

  it("includes the normalized profile in batch identity", () => {
    const source = packet(), first = source.instances[0]!;
    const same = { ...first, id: "same", lod: { levels: first.lod!.levels, hysteresisRatio: 0.15 } };
    const different = { ...first, id: "different", lod: { levels: first.lod!.levels.map((level, index) =>
      index === 1 ? { ...level, resident: true } : level), hysteresisRatio: 0.15 } };
    const grouped = prepareRenderPacket({ ...source, instances: [first, same] });
    const split = prepareRenderPacket({ ...source, instances: [first, different] });
    expect(grouped.batches).toHaveLength(1);
    expect(grouped.batches[0]!.count).toBe(2);
    expect(split.batches).toHaveLength(2);
    expect(split.batches[0]!.key).not.toBe(split.batches[1]!.key);
  });

  it("rejects malformed level ordering, metadata, residency and primary geometry", () => {
    const source = packet(), instance = source.instances[0]!, levels = instance.lod!.levels;
    const run = (nextLevels: readonly unknown[], hysteresisRatio: number | undefined = 0.15) =>
      prepareRenderPacket({ ...source, instances: [{ ...instance,
        lod: { levels: nextLevels as typeof levels, ...(hysteresisRatio === undefined ? {} : { hysteresisRatio }) } }] });
    const cases: readonly [readonly unknown[], string][] = [
      [[levels[0]!], "2-8"],
      [Array.from({ length: 9 }, () => levels[0]!), "2-8"],
      [[{ ...levels[0]!, geometry: "medium" }, levels[1]!, levels[2]!], "primary geometry"],
      [[levels[0]!, { ...levels[1]!, geometry: "missing" }, levels[2]!], "Missing LOD geometry"],
      [[levels[0]!, { ...levels[1]!, minProjectedDiameterPixels: 120 }, levels[2]!], "strictly decrease"],
      [[levels[0]!, levels[1]!, { ...levels[2]!, minProjectedDiameterPixels: 1 }], "must be zero"],
      [[levels[0]!, { ...levels[1]!, geometry: "low" }, { ...levels[2]!, geometry: "medium" }], "triangle counts"],
      [[levels[0]!, { ...levels[1]!, geometricError: 2 }, levels[2]!], "geometric errors"],
      [[levels[0]!, { ...levels[1]!, resident: "yes" }, levels[2]!], "residency"],
      [[{ ...levels[0]!, resident: false }, levels[1]!, levels[2]!], "primary LOD geometry"],
      [[levels[0]!, levels[1]!, { ...levels[2]!, resident: false }], "coarsest LOD geometry"],
      [levels.map(level => ({ ...level, resident: false })), "resident level"],
      [[{ ...levels[0]!, minProjectedDiameterPixels: Infinity }, levels[1]!, levels[2]!], "threshold"],
      [[levels[0]!, { ...levels[1]!, geometricError: Number.NaN }, levels[2]!], "geometric error"],
    ];
    for (const [candidate, message] of cases) expect(() => run(candidate)).toThrow(message);
    for (const ratio of [-0.01, 0.5, Number.NaN]) expect(() => run(levels, ratio)).toThrow("hysteresis");
  });

  it("requires every LOD geometry to satisfy the material UV and tangent contract", () => {
    const textured = packet({ uv: true });
    const texturedGeometries = textured.geometries.map((item, index) => index === 2 ? geometry("low", 1) : item);
    const baseTexture = { id: "base", revision: 0, semantic: "baseColor" as const, width: 1, height: 1,
      data: new Uint8Array([255, 255, 255, 255]) };
    expect(() => prepareRenderPacket({ ...textured, geometries: texturedGeometries, textures: [baseTexture], materials: [{ ...textured.materials[0]!,
      baseColorTexture: { texture: "base" } }] })).toThrow("Geometry low requires UV0");

    const normalMapped = packet({ uv: true, tangents: true });
    const normalGeometries = normalMapped.geometries.map((item, index) =>
      index === 1 ? geometry("medium", 4, { uv: true }) : item);
    expect(() => prepareRenderPacket({ ...normalMapped, geometries: normalGeometries,
      textures: [{ ...baseTexture, semantic: "normal" }],
      materials: [{ ...normalMapped.materials[0]!, normalTexture: { texture: "base" } }] }))
      .toThrow("Geometry medium requires a tangent basis");
  });

  it("rejects thresholds that collapse on the GPU while accepting adjacent float32 values", () => {
    const source = packet(), instance = source.instances[0]!;
    const run = (thresholds: readonly number[]) => prepareRenderPacket({ ...source, instances: [{ ...instance,
      lod: { levels: instance.lod!.levels.map((level, index) => ({ ...level, minProjectedDiameterPixels: thresholds[index]! })) } }] });
    expect(() => run([120 + 1e-7, 120, 0])).toThrow("float32");
    expect(() => run([120, 1e-50, 0])).toThrow("float32");
    expect(() => run([120 + 2 ** -17, 120, 0])).not.toThrow();
  });

  it("requires triangle metadata on the instance-update fast path", () => {
    const source = packet(), update = { materials: source.materials, instances: source.instances };
    const feature = (triangles: number): GeometryFeatures => ({ uv0: false, uv1: false, tangents: false, triangles });
    const batches = prepareInstanceUpdate(new Map([
      ["high", feature(8)], ["medium", feature(4)], ["low", feature(1)],
    ]), update);
    expect(batches[0]!.lod!.levels.map(level => level.triangles)).toEqual([8, 4, 1]);
    expect(() => prepareInstanceUpdate(new Set(["high", "medium", "low"]), update)).toThrow("triangle count metadata");
  });
});
