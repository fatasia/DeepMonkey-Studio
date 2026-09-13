import { describe, expect, it } from "vitest";
import { packTransform } from "./instanceTransform.js";
import { prepareInstanceUpdate, prepareRenderPacket, type RenderPacket } from "./renderPacket.js";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function packet(): RenderPacket {
  return { geometries: [{ id: "mesh", revision: 0, vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }],
    materials: [{ id: "coat", baseColor: [0.1, 0.5, 0.7], metallic: 0.4, roughness: 0.6 }],
    instances: [{ id: "part", geometry: "mesh", material: "coat", transform: [...identity] }] };
}

describe("render packet projection", () => {
  it("shares a geometry batch across materials and separates mirrored winding", () => {
    const p = packet();
    const result = prepareRenderPacket({ ...p, materials: [...p.materials, { ...p.materials[0]!, id: "metal", metallic: 1 }], instances: [p.instances[0]!,
      { ...p.instances[0]!, id: "second", material: "metal" }, { ...p.instances[0]!, id: "mirror", transform: [-1, ...identity.slice(1)] }] });
    expect(result.geometries.size).toBe(1);
    expect(result.batches.map(b => [b.count, b.mirrored])).toEqual([[2, false], [1, true]]);
    expect(result.batches[0]!.data[27]).toBeCloseTo(0.4);
    expect(result.batches[0]!.data[63]).toBe(1);
  });
  it("owns snapshots independently of subsequent author edits", () => {
    const p = packet(), result = prepareRenderPacket(p);
    p.geometries[0]!.vertices[0] = 42; p.geometries[0]!.indices[0] = 2;
    (p.instances[0]!.transform as number[])[12] = 100;
    expect(result.geometries.get("mesh")!.vertices[0]).toBe(0);
    expect(result.geometries.get("mesh")!.indices[0]).toBe(0);
    expect(result.batches[0]!.data[3]).toBe(0);
  });
  it("releases unused geometry from the projection and accepts an empty scene", () => {
    expect(prepareRenderPacket({ ...packet(), instances: [] }).geometries.size).toBe(0);
    expect(prepareRenderPacket({ geometries: [], materials: [], instances: [] }).batches).toEqual([]);
  });
  it("rejects duplicate IDs, missing references and oversized instance lists", () => {
    const p = packet();
    for (const key of ["geometries", "materials", "instances"] as const) expect(() => prepareRenderPacket({ ...p, [key]: [...p[key], ...p[key]] })).toThrow("duplicate");
    expect(() => prepareRenderPacket({ ...p, instances: [{ ...p.instances[0]!, material: "missing" }] })).toThrow("Missing");
    expect(() => prepareRenderPacket({ ...p, instances: Array(16_385).fill(p.instances[0]) })).toThrow("limits");
  });
  it("rejects malformed geometry, invalid materials and zero normals before upload", () => {
    const p = packet(), g = p.geometries[0]!;
    const cases = [{ ...g, revision: -1 }, { ...g, indices: new Uint32Array([0, 1]) }, { ...g, indices: new Uint32Array([0, 1, 3]) },
      { ...g, vertices: new Float32Array(18) }, { ...g, vertices: new Float32Array([NaN, ...g.vertices.slice(1)]) }];
    for (const geometry of cases) expect(() => prepareRenderPacket({ ...p, geometries: [geometry] })).toThrow();
    for (const roughness of [-1, Infinity, NaN, 1.01]) expect(() => prepareRenderPacket({ ...p, materials: [{ ...p.materials[0]!, roughness }] })).toThrow("material");
  });
  it("keeps interleaved groups in first-occurrence order without ambiguous ID keys", () => {
    const p = packet(), ids = ["0mesh", "1mesh", '["mesh",true]'];
    const instances = Array.from({ length: 90 }, (_, i) => ({ ...p.instances[0]!, id: `part-${i}`, geometry: ids[i % ids.length]!,
      transform: identity.map((x, k) => k === 0 && i % 2 ? -x : k === 12 ? i : x) }));
    const result = prepareInstanceUpdate(new Set(ids), { materials: p.materials, instances });
    expect(result).toHaveLength(6);
    expect(result.map(batch => batch.key)).toEqual([JSON.stringify([ids[0], false, false, "OPAQUE", null, null]), JSON.stringify([ids[1], true, false, "OPAQUE", null, null]),
      JSON.stringify([ids[2], false, false, "OPAQUE", null, null]), JSON.stringify([ids[0], true, false, "OPAQUE", null, null]),
      JSON.stringify([ids[1], false, false, "OPAQUE", null, null]), JSON.stringify([ids[2], true, false, "OPAQUE", null, null])]);
    for (const batch of result) {
      const expected = instances.filter(instance => instance.geometry === batch.geometry && (instance.transform[0]! < 0) === batch.mirrored);
      expect(batch.count).toBe(expected.length);
      expected.forEach((instance, index) => expect(batch.data[index * 36 + 3]).toBe(instance.transform[12]));
      expect(batch.data.buffer.byteLength).toBe(batch.count * 144);
    }
  });
  it("owns single and multiple batch updates independently across calls and author mutations", () => {
    for (const count of [1, 2]) {
      const p = packet(), instances = Array.from({ length: count }, (_, i) => ({ ...p.instances[0]!, id: `p${i}`,
        transform: identity.map((x, k) => k === 0 && i ? -x : x) }));
      const update = { materials: p.materials, instances }, first = prepareInstanceUpdate(new Set(["mesh"]), update);
      const second = prepareInstanceUpdate(new Set(["mesh"]), update);
      instances[0]!.transform[12] = 50;
      (p.materials[0]!.baseColor as number[])[0] = 1;
      first[0]!.data.fill(42);
      expect(second[0]!.data[3]).toBe(0); expect(second[0]!.data[24]).toBeCloseTo(0.1);
      if (count === 2) expect(first[1]!.data[3]).toBe(0);
    }
  });
  it("validates all materials and duplicate instance IDs even when no geometry copy is needed", () => {
    const p = packet(), geometries = new Set(["mesh"]);
    expect(() => prepareInstanceUpdate(geometries, { ...p, instances: [p.instances[0]!, p.instances[0]!] })).toThrow("duplicate instance");
    for (const value of [NaN, Infinity, -0.1, 1.1, "0.5"] as const) {
      const material = { ...p.materials[0]!, baseColor: [value, 0, 0] as unknown as [number, number, number] };
      expect(() => prepareInstanceUpdate(geometries, { instances: [], materials: [material] })).toThrow("material");
    }
    const lateInvalid = { ...p.instances[0]!, id: "late", transform: [0, ...identity.slice(1)] };
    const retained = prepareInstanceUpdate(geometries, p);
    expect(() => prepareInstanceUpdate(geometries, { ...p, instances: [p.instances[0]!, lateInvalid] })).toThrow("singular");
    expect(retained[0]!.data[0]).toBe(1);
  });
  it("owns both UV sets, preserves out-of-range repeat coordinates and groups texture bindings", () => {
    const p = packet(), uv0 = new Float32Array([-1, 0, 2, 0, 0.5, 3]);
    const uv1 = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const textures = [
      { id: "albedo", revision: 0, semantic: "baseColor" as const, width: 1, height: 1, data: new Uint8Array([128, 64, 32, 255]) },
      { id: "mr", revision: 0, semantic: "metallicRoughness" as const, width: 1, height: 1, data: new Uint8Array([0, 128, 255, 255]) },
    ];
    const result = prepareRenderPacket({ ...p, textures, geometries: [{ ...p.geometries[0]!, uv0, uv1 }], materials: [
      { ...p.materials[0]!, baseColorTexture: { texture: "albedo", texCoord: 1, offset: [0.25, 0.5], scale: [2, 3], rotation: Math.PI / 2 },
        metallicRoughnessTexture: { texture: "mr" } },
    ] });
    uv0.fill(9); uv1.fill(9); textures[0]!.data.fill(0);
    expect(result.geometries.get("mesh")!.uv0).toEqual(new Float32Array([-1, 0, 2, 0, 0.5, 3]));
    expect(result.geometries.get("mesh")!.uv1).toEqual(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]));
    expect(result.textures.map(texture => [texture.id, texture.format])).toEqual([["albedo", "rgba8unorm-srgb"], ["mr", "rgba8unorm"]]);
    const transform = result.batches[0]!.textures?.baseColor?.uvTransform;
    expect(transform?.[0]).toBeCloseTo(0); expect(transform?.[1]).toBe(-3); expect(transform?.[2]).toBe(0.25);
    expect(transform?.[3]).toBe(2); expect(transform?.[4]).toBeCloseTo(0); expect(transform?.[5]).toBe(0.5);
    expect(result.batches[0]!.textures?.baseColor?.texCoord).toBe(1);
    expect(result.batches[0]!.textures?.metallicRoughness?.texCoord).toBe(0);
    expect(result.batches[0]!.textures?.metallicRoughness?.uvTransform).toEqual([1, 0, 0, 0, 1, 0]);
  });
  it("rejects invalid UV layouts, missing or mismatched texture semantics and normal maps without TBN", () => {
    const p = packet(), texture = { id: "map", revision: 0, semantic: "baseColor" as const,
      width: 1, height: 1, data: new Uint8Array(4) };
    for (const [name, uv] of [["uv0", new Float32Array(5)], ["uv0", new Float32Array([0, 0, 1, 0, NaN, 1])],
      ["uv1", new Float32Array(5)], ["uv1", new Float32Array([0, 0, 1, 0, NaN, 1])]] as const) {
      expect(() => prepareRenderPacket({ ...p, geometries: [{ ...p.geometries[0]!, [name]: uv }] })).toThrow(name.toUpperCase());
    }
    expect(() => prepareRenderPacket({ ...p, textures: [texture], materials: [{ ...p.materials[0]!, baseColorTexture: { texture: "map" } }] })).toThrow("requires UV0");
    const textured = { ...p, textures: [texture], geometries: [{ ...p.geometries[0]!, uv0: new Float32Array(6) }] };
    expect(() => prepareRenderPacket({ ...textured, materials: [{ ...p.materials[0]!, metallicRoughnessTexture: { texture: "map" } }] })).toThrow("semantic mismatch");
    expect(() => prepareRenderPacket({ ...textured, materials: [{ ...p.materials[0]!, baseColorTexture: { texture: "map", texCoord: 1 } }] })).toThrow("requires UV1");
    expect(() => prepareRenderPacket({ ...textured, materials: [{ ...p.materials[0]!, baseColorTexture:
      { texture: "map", texCoord: 2 as unknown as 0 } }] })).toThrow("coordinate sets 0 and 1");
    const normalTexture = { ...texture, semantic: "normal" as const };
    expect(() => prepareRenderPacket({ ...textured, textures: [normalTexture],
      materials: [{ ...p.materials[0]!, normalTexture: { texture: "map", normalScale: 0.5 } }] })).toThrow("tangent basis");
    expect(() => prepareRenderPacket({ ...p, textures: null as unknown as RenderPacket["textures"] })).toThrow("Texture resource count");
  });
  it("owns tangent bases, preserves normal scale and carries mirrored handedness separately", () => {
    const p = packet(), tangents = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
    const result = prepareRenderPacket({ ...p,
      geometries: [{ ...p.geometries[0]!, uv0: new Float32Array([0, 0, 1, 0, 0, 1]), tangents }],
      textures: [{ id: "normal", revision: 0, semantic: "normal", width: 1, height: 1, data: new Uint8Array([128, 128, 255, 255]) }],
      materials: [{ ...p.materials[0]!, normalTexture: { texture: "normal", normalScale: -0.5, scale: [-2, 3] } }],
      instances: [p.instances[0]!, { ...p.instances[0]!, id: "mirror", transform: [-1, ...identity.slice(1)] }],
    });
    tangents.fill(0);
    expect(result.geometries.get("mesh")!.tangents).toEqual(new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]));
    expect(result.textures).toMatchObject([{ id: "normal", format: "rgba8unorm" }]);
    expect(result.batches.map(batch => [batch.textures?.normal?.normalScale, batch.data[30]])).toEqual([[-0.5, 1], [-0.5, -1]]);
  });
  it("preserves independent AO transform/strength and batches mirrored double-sided instances", () => {
    const p = packet(), uv0 = new Float32Array([0, 0, 1, 0, 0, 1]);
    const result = prepareRenderPacket({ ...p, geometries: [{ ...p.geometries[0]!, uv0 }],
      textures: [{ id: "ao", revision: 0, semantic: "occlusion", width: 1, height: 1, data: new Uint8Array([64, 255, 255, 255]) }],
      materials: [{ ...p.materials[0]!, doubleSided: true,
        occlusionTexture: { texture: "ao", strength: 0.4, offset: [0.2, 0.3], scale: [2, 3] } }],
      instances: [p.instances[0]!, { ...p.instances[0]!, id: "mirror", transform: [-1, ...identity.slice(1)] }] });
    expect(result.textures).toMatchObject([{ id: "ao", semantic: "occlusion", format: "rgba8unorm" }]);
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]).toMatchObject({ count: 2, mirrored: false, doubleSided: true,
      textures: { occlusion: { texture: "ao" } } });
    expect(result.batches[0]!.textures!.occlusion!.strength).toBeCloseTo(0.4);
    expect(result.batches[0]!.textures!.occlusion!.uvTransform).toEqual([
      2, 0, Math.fround(0.2), 0, 3, Math.fround(0.3),
    ]);
    expect([result.batches[0]!.data[30], result.batches[0]!.data[66]]).toEqual([1, -1]);
    expect([result.batches[0]!.data[31], result.batches[0]!.data[67]]).toEqual([1, 1]);
    for (const strength of [-0.1, 1.1, NaN, Infinity]) expect(() => prepareRenderPacket({ ...p,
      geometries: [{ ...p.geometries[0]!, uv0 }], textures: result.textures.map(texture => ({ ...texture,
        width: texture.levels[0]!.width, height: texture.levels[0]!.height, data: texture.levels[0]!.data })),
      materials: [{ ...p.materials[0]!, occlusionTexture: { texture: "ao", strength } }] })).toThrow("strength");
    expect(() => prepareRenderPacket({ ...p, materials: [{ ...p.materials[0]!, doubleSided: 1 as unknown as boolean }] })).toThrow("doubleSided");
  });
  it("projects emissive and alpha coverage while batching BLEND instances for weighted OIT", () => {
    const p = packet(), uv0 = new Float32Array([0, 0, 1, 0, 0, 1]);
    const result = prepareRenderPacket({ ...p, geometries: [{ ...p.geometries[0]!, uv0 }],
      textures: [{ id: "emit", revision: 0, semantic: "emissive", width: 1, height: 1, data: new Uint8Array([255, 128, 0, 255]) }],
      materials: [{ ...p.materials[0]!, emissiveFactor: [0.4, 0.3, 0.2], emissiveTexture: { texture: "emit" },
        baseColorAlpha: 0.35, alphaMode: "BLEND" }],
      instances: [p.instances[0]!, { ...p.instances[0]!, id: "far", transform: identity.map((value, index) => index === 14 ? -4 : value) }] });
    expect(result.textures).toMatchObject([{ semantic: "emissive", format: "rgba8unorm-srgb" }]);
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]).toMatchObject({ alphaMode: "BLEND", count: 2 });
    expect([...result.batches[0]!.data.slice(32, 36)]).toEqual([0.4, 0.3, 0.2, 0.35].map(Math.fround));
    expect([...result.batches[0]!.data.slice(68, 72)]).toEqual([0.4, 0.3, 0.2, 0.35].map(Math.fround));
    for (const material of [{ ...p.materials[0]!, alphaMode: "bad" as "OPAQUE" },
      { ...p.materials[0]!, baseColorAlpha: 2 }, { ...p.materials[0]!, alphaCutoff: -1 },
      { ...p.materials[0]!, emissiveFactor: [0, 2, 0] as [number, number, number] }]) {
      expect(() => prepareRenderPacket({ ...p, materials: [material] })).toThrow("material");
    }
  });
  it("carries HDR emissive strength without changing the 36-float instance record", () => {
    const p = packet(), uv0 = new Float32Array([0, 0, 1, 0, 0, 1]);
    const plain = prepareRenderPacket({ ...p, materials: [{ ...p.materials[0]!,
      emissiveFactor: [0.25, 0.5, 1], emissiveStrength: 8 }] });
    expect(plain.batches[0]!.data).toHaveLength(36);
    expect([...plain.batches[0]!.data.slice(32, 35)]).toEqual([2, 4, 8]);

    const textured = prepareRenderPacket({ ...p, geometries: [{ ...p.geometries[0]!, uv0 }],
      textures: [{ id: "base", revision: 0, semantic: "baseColor", width: 1, height: 1,
        data: new Uint8Array([255, 255, 255, 255]) }],
      materials: [{ ...p.materials[0]!, emissiveFactor: [0.25, 0.5, 1], emissiveStrength: 8,
        baseColorTexture: { texture: "base" } }] });
    expect(textured.batches[0]!.textures?.emissiveStrength).toBe(8);
    expect([...textured.batches[0]!.data.slice(32, 35)]).toEqual([0.25, 0.5, 1]);
    for (const emissiveStrength of [-0.1, 256.1, NaN, Infinity]) {
      expect(() => prepareRenderPacket({ ...p, materials: [{ ...p.materials[0]!, emissiveStrength }] }))
        .toThrow("emissiveStrength");
    }
  });
  it("does not derive CPU sort bounds for weighted OIT batches", () => {
    const p = packet();
    const vertices = new Float32Array([
      3e38, 0, 0, 1, 0, 0,
      3e38, 2, 0, 1, 0, 0,
      3e38, 0, 2, 1, 0, 0,
      -3e38, 0, 0, 1, 0, 0,
    ]);
    const result = prepareRenderPacket({
      ...p,
      geometries: [{ ...p.geometries[0]!, vertices, indices: new Uint32Array([0, 1, 2]) }],
      materials: [{ ...p.materials[0]!, alphaMode: "BLEND" }],
    });
    expect(result.batches[0]).toMatchObject({ alphaMode: "BLEND", count: 1 });
    expect(result.batches[0]!.sortCenter).toBeUndefined();
  });
  it("rejects malformed tangent bases and singular normal UV transforms", () => {
    const p = packet(), uv0 = new Float32Array([0, 0, 1, 0, 0, 1]);
    const normal = { id: "normal", revision: 0, semantic: "normal" as const, width: 1, height: 1, data: new Uint8Array(4) };
    const material = { ...p.materials[0]!, normalTexture: { texture: "normal" } };
    const run = (tangents: Float32Array) => prepareRenderPacket({ ...p, textures: [normal], materials: [material],
      geometries: [{ ...p.geometries[0]!, uv0, tangents }] });
    for (const tangents of [new Float32Array(11), new Float32Array([2, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
      new Float32Array([1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1]),
      new Float32Array([1, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1])]) expect(run.bind(undefined, tangents)).toThrow("tangent");
    expect(() => prepareRenderPacket({ ...p, textures: [normal], materials: [{ ...p.materials[0]!,
      normalTexture: { texture: "normal", scale: [0, 1] } }], geometries: [{ ...p.geometries[0]!, uv0,
        tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]) }] })).toThrow("singular");
  });
});

describe("affine instance transforms", () => {
  it("keeps transformed normals orthogonal under rotation, shear and nonuniform scale", () => {
    const m = [0, 2, 0, 0, -3, 1, 0, 0, 0.5, 0, 4, 0, 7, 8, 9, 1];
    const data = new Float32Array(32);
    expect(packTransform(m, data)).toBe(false);
    expect([...data.slice(0, 12)]).toEqual([0, -3, 0.5, 7, 2, 1, 0, 8, 0, 0, 4, 9]);
    for (let column = 0; column < 3; column++) for (let tangent = 0; tangent < 3; tangent++) {
      const dot = [0, 1, 2].reduce((sum, k) => sum + data[12 + column * 4 + k]! * m[tangent * 4 + k]!, 0);
      expect(dot).toBeCloseTo(column === tangent ? 1 : 0, 6);
    }
  });
  it("recognizes mirrored handedness without flipping the physical normal", () => {
    const data = new Float32Array(32);
    expect(packTransform([-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1], data)).toBe(true);
    expect(data[12]).toBe(-0.5); expect(data[17]).toBeCloseTo(1 / 3); expect(data[22]).toBe(0.25);
  });
  it("rejects zero scale, near-parallel axes, projective matrices and float32 overflow atomically", () => {
    const data = new Float32Array(32).fill(9);
    const cases = [[...identity.slice(1)], [0, ...identity.slice(1)], [1e40, ...identity.slice(1)],
      identity.map((x, i) => i === 3 ? 0.1 : x), identity.map((x, i) => i === 3 ? 1e-50 : x),
      [1, 0, 0, 0, 1, 1e-10, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]];
    for (const matrix of cases) {
      expect(() => packTransform(matrix, data)).toThrow();
      expect(data.every(x => x === 9)).toBe(true);
    }
  });
  it("checks post-float32 conditioning, inverse overflow and every affine row component", () => {
    const data = new Float32Array(64).fill(9);
    const cases = [identity.map((x, i) => [0, 5, 10].includes(i) ? 1e-39 : x),
      identity.map((x, i) => [0, 5, 10].includes(i) ? 1e-50 : x),
      [1, 1, 0, 0, 1, 1 + 1e-9, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      ...[3, 7, 11].map(index => identity.map((x, i) => i === index ? 1e-50 : x)),
      ...[12, 13, 14].map(index => identity.map((x, i) => i === index ? 1e40 : x)),
      identity.map((x, i) => i === 15 ? 1 + Number.EPSILON : x)];
    for (const matrix of cases) {
      expect(() => packTransform(matrix, data, 32)).toThrow();
      expect(data.every(x => x === 9)).toBe(true);
    }
    for (const scale of [1e-38, 1e38]) {
      expect(packTransform(identity.map((x, i) => [0, 5, 10].includes(i) ? scale : x), data, 32)).toBe(false);
      expect(data.slice(0, 32).every(x => x === 9)).toBe(true);
      expect(data.slice(56).every(x => x === 9)).toBe(true);
      expect([...data.slice(32, 56)].every(Number.isFinite)).toBe(true);
    }
  });
  it("keeps the destination unchanged when transform output capacity is insufficient", () => {
    const data = new Float32Array(40).fill(9);
    expect(() => packTransform(identity, data, 20)).toThrow(RangeError);
    expect(data.every(x => x === 9)).toBe(true);
    expect(() => packTransform(identity, data, -1)).toThrow(RangeError);
    expect(data.every(x => x === 9)).toBe(true);
  });
});
