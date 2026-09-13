import { describe, expect, it, vi } from "vitest";
import { extractGltfTextureManifest, gltfTextureTransformMatrix } from "./textureManifest.js";
import { GltfImportError, type JsonObject } from "./validation.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ktx2 = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

function fixture(component: 5121 | 5123 | 5126 = 5126) {
  const size = component === 5121 ? 1 : component === 5123 ? 2 : 4, uvLength = 6 * size;
  const bytes = new Uint8Array(uvLength + png.length), view = new DataView(bytes.buffer);
  const uv = [0, 0.25, 0.5, 0.75, 1, 1];
  uv.forEach((value, index) => component === 5126 ? view.setFloat32(index * size, value, true)
    : component === 5121 ? view.setUint8(index, Math.round(value * 255)) : view.setUint16(index * size, Math.round(value * 65_535), true));
  bytes.set(png, uvLength);
  const document: JsonObject = {
    asset: { version: "2.0" }, extensionsUsed: ["KHR_texture_transform"],
    buffers: [{ byteLength: bytes.length }], bufferViews: [
      { buffer: 0, byteLength: uvLength, target: 34962 }, { buffer: 0, byteOffset: uvLength, byteLength: png.length }],
    accessors: [
      { bufferView: 0, componentType: component, ...(component === 5126 ? {} : { normalized: true }), count: 3, type: "VEC2" },
      { componentType: 5126, count: 3, type: "VEC3" },
    ],
    images: [{ bufferView: 1, mimeType: "image/png" }],
    samplers: [{ wrapS: 33071, wrapT: 33648, magFilter: 9728, minFilter: 9986 }],
    textures: [{ source: 0, sampler: 0 }],
    materials: [{ pbrMetallicRoughness: {
      baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { offset: [0.1, 0.2], scale: [2, 3], rotation: 0.5 } } },
      metallicRoughnessTexture: { index: 0 },
    }, normalTexture: { index: 0, scale: 0.7 }, occlusionTexture: { index: 0, strength: 0.35 }, emissiveTexture: { index: 0 } }],
    meshes: [{ primitives: [{ attributes: { TEXCOORD_0: 0, POSITION: 1 }, material: 0 }] }],
  };
  return { document, bytes, uvLength };
}

function fixtureWithUv1() {
  const source = fixture(), uv1Values = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
  const bytes = new Uint8Array(source.bytes.length + uv1Values.length * 4);
  bytes.set(source.bytes);
  const offset = source.bytes.length, view = new DataView(bytes.buffer);
  uv1Values.forEach((value, index) => view.setFloat32(offset + index * 4, value, true));
  (source.document.buffers as JsonObject[])[0]!.byteLength = bytes.length;
  (source.document.bufferViews as JsonObject[]).push({ buffer: 0, byteOffset: offset, byteLength: uv1Values.length * 4, target: 34962 });
  (source.document.accessors as JsonObject[]).push({ bufferView: 2, componentType: 5126, count: 3, type: "VEC2" });
  const primitive = ((source.document.meshes as JsonObject[])[0]!.primitives as JsonObject[])[0]!;
  (primitive.attributes as JsonObject).TEXCOORD_1 = 2;
  (source.document.materials as JsonObject[])[0]!.occlusionTexture = { index: 0, texCoord: 1, strength: 0.35 };
  return { document: source.document, bytes, uv1Values };
}

function expectError(action: () => unknown, code: "invalid" | "unsupported" | "limit", path: string): GltfImportError {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(GltfImportError);
  expect(caught).toMatchObject({ code });
  expect((caught as GltfImportError).path).toContain(path);
  return caught as GltfImportError;
}

describe("glTF texture manifest extraction", () => {
  it("extracts the fixed upstream Khronos BoxTextured GLB payload and UV data", () => {
    const glb = readFileSync(new URL("../../lab/assets/BoxTextured.glb", import.meta.url));
    expect(createHash("sha256").update(glb).digest("hex")).toBe("b510eca2e2ef33f62f9ed57d6e7ce2d10ebb2bdebc4a8e59d347719ba81abdf4");
    const jsonLength = glb.readUInt32LE(12), json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
    const binaryHeader = 20 + jsonLength, binaryLength = glb.readUInt32LE(binaryHeader);
    const binary = glb.subarray(binaryHeader + 8, binaryHeader + 8 + binaryLength);
    const manifest = extractGltfTextureManifest(json, [binary], { resourcePrefix: "official-box" });
    expect(manifest.images).toMatchObject([{ mimeType: "image/png", data: { byteLength: 3750 } }]);
    expect(manifest.resources).toMatchObject([{ id: "official-box/texture/0/baseColor", semantic: "baseColor" }]);
    expect(manifest.uvSets).toHaveLength(1);
    expect(manifest.uvSets[0]!.values).toHaveLength(48);
    expect(Math.max(...manifest.uvSets[0]!.values)).toBe(6);
  });

  it("extracts embedded bytes, glTF sampler semantics, all PBR slots, transform and UV0 without IO", () => {
    const { document, bytes, uvLength } = fixture(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    try {
      const manifest = extractGltfTextureManifest(document, [bytes], { resourcePrefix: "asset/a" });
      expect(manifest.images).toHaveLength(1);
      expect([...manifest.images[0]!.data]).toEqual([...png]);
      expect(manifest.resources.map(value => [value.id, value.semantic])).toEqual([
        ["asset/a/texture/0/baseColor", "baseColor"], ["asset/a/texture/0/metallicRoughness", "metallicRoughness"],
        ["asset/a/texture/0/normal", "normal"], ["asset/a/texture/0/occlusion", "occlusion"],
        ["asset/a/texture/0/emissive", "emissive"],
      ]);
      expect(manifest.resources[0]!.sampler).toEqual({ addressModeU: "clamp-to-edge", addressModeV: "mirror-repeat",
        magFilter: "nearest", minFilter: "nearest", mipmapFilter: "linear", maxAnisotropy: 1 });
      expect(manifest.materials[0]!.baseColorTexture).toMatchObject({ texture: "asset/a/texture/0/baseColor", texCoord: 0,
        offset: [0.1, 0.2], scale: [2, 3], rotation: 0.5 });
      expect(manifest.materials[0]!.normalTexture).toMatchObject({ texture: "asset/a/texture/0/normal", normalScale: 0.7 });
      expect(manifest.materials[0]!.occlusionTexture).toMatchObject({ texture: "asset/a/texture/0/occlusion", strength: 0.35 });
      expect(manifest.materials[0]!.emissiveTexture).toMatchObject({ texture: "asset/a/texture/0/emissive" });
      expect([...manifest.uvSets[0]!.values]).toEqual([0, 0.25, 0.5, 0.75, 1, 1]);
      expect(manifest.uvSets[0]!.geometry).toBe("asset/a/mesh/0/primitive/0");
      bytes.fill(0, uvLength);
      expect([...manifest.images[0]!.data]).toEqual([...png]);
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("validates KHR_materials_emissive_strength declarations for textured materials", () => {
    const source = fixture();
    source.document.extensionsUsed = ["KHR_texture_transform", "KHR_materials_emissive_strength"];
    source.document.extensionsRequired = ["KHR_materials_emissive_strength"];
    (source.document.materials as JsonObject[])[0]!.extensions = {
      KHR_materials_emissive_strength: { emissiveStrength: 16 },
    };
    expect(extractGltfTextureManifest(source.document, [source.bytes]).materials[0])
      .toMatchObject({ emissiveStrength: 16 });

    const undeclared = fixture();
    (undeclared.document.materials as JsonObject[])[0]!.extensions = {
      KHR_materials_emissive_strength: { emissiveStrength: 2 },
    };
    expectError(() => extractGltfTextureManifest(undeclared.document, [undeclared.bytes]),
      "invalid", "KHR_materials_emissive_strength");
    const missingUsed = fixture(); missingUsed.document.extensionsRequired = ["KHR_materials_emissive_strength"];
    expectError(() => extractGltfTextureManifest(missingUsed.document, [missingUsed.bytes]),
      "invalid", "extensionsRequired");
  });

  it("selects an embedded KHR_texture_basisu source without a core fallback", () => {
    const source = fixture(); source.bytes.set(ktx2, source.uvLength);
    source.document.extensionsUsed = ["KHR_texture_transform", "KHR_texture_basisu"];
    source.document.extensionsRequired = ["KHR_texture_basisu"];
    (source.document.images as JsonObject[])[0]!.mimeType = "image/ktx2";
    source.document.textures = [{ sampler: 0, extensions: { KHR_texture_basisu: { source: 0 } } }];
    const manifest = extractGltfTextureManifest(source.document, [source.bytes], { resourcePrefix: "basis" });
    expect(manifest.images).toMatchObject([{ id: "basis/image/0", mimeType: "image/ktx2" }]);
    expect([...manifest.images[0]!.data]).toEqual([...ktx2]);
    expect(manifest.resources[0]).toMatchObject({ image: "basis/image/0", semantic: "baseColor" });
  });

  it("retains an optional core image fallback beside the preferred BasisU source", () => {
    const source = fixture(), bytes = new Uint8Array(source.bytes.length + ktx2.length);
    bytes.set(source.bytes); bytes.set(ktx2, source.bytes.length);
    (source.document.buffers as JsonObject[])[0]!.byteLength = bytes.length;
    (source.document.bufferViews as JsonObject[]).push({ buffer: 0, byteOffset: source.bytes.length, byteLength: ktx2.length });
    source.document.images = [
      { bufferView: 1, mimeType: "image/png" }, { bufferView: 2, mimeType: "image/ktx2" },
    ];
    source.document.extensionsUsed = ["KHR_texture_transform", "KHR_texture_basisu"];
    source.document.textures = [{ source: 0, sampler: 0, extensions: { KHR_texture_basisu: { source: 1 } } }];
    const manifest = extractGltfTextureManifest(source.document, [bytes], { resourcePrefix: "fallback" });
    expect(manifest.resources[0]).toMatchObject({
      image: "fallback/image/1", fallbackImage: "fallback/image/0", semantic: "baseColor",
    });
  });

  it("rejects undeclared, wrongly typed and corrupt BasisU sources", () => {
    const undeclared = fixture(); undeclared.bytes.set(ktx2, undeclared.uvLength);
    (undeclared.document.images as JsonObject[])[0]!.mimeType = "image/ktx2";
    undeclared.document.textures = [{ extensions: { KHR_texture_basisu: { source: 0 } } }];
    expectError(() => extractGltfTextureManifest(undeclared.document, [undeclared.bytes]), "invalid", "KHR_texture_basisu");
    const wrong = fixture(); wrong.document.extensionsUsed = ["KHR_texture_transform", "KHR_texture_basisu"];
    wrong.document.textures = [{ extensions: { KHR_texture_basisu: { source: 0 } } }];
    expectError(() => extractGltfTextureManifest(wrong.document, [wrong.bytes]), "invalid", "source");
    const corrupt = fixture(); corrupt.document.extensionsUsed = ["KHR_texture_transform", "KHR_texture_basisu"];
    (corrupt.document.images as JsonObject[])[0]!.mimeType = "image/ktx2";
    corrupt.document.textures = [{ extensions: { KHR_texture_basisu: { source: 0 } } }];
    expectError(() => extractGltfTextureManifest(corrupt.document, [corrupt.bytes]), "invalid", "images[0]");
  });

  it.each([5121, 5123] as const)("normalizes unsigned component %s UV coordinates", component => {
    const { document, bytes } = fixture(component), values = extractGltfTextureManifest(document, [bytes]).uvSets[0]!.values;
    expect(values[0]).toBe(0); expect(values[4]).toBe(1); expect(values[5]).toBe(1);
    expect(values[2]).toBeCloseTo(0.5, 2);
  });

  it("decodes distinct TEXCOORD_0/TEXCOORD_1 streams and preserves each material slot selection", () => {
    const source = fixtureWithUv1(), manifest = extractGltfTextureManifest(source.document, [source.bytes], { resourcePrefix: "uv-pair" });
    expect(manifest.uvSets.map(set => set.texCoord)).toEqual([0, 1]);
    expect([...manifest.uvSets[0]!.values]).toEqual([0, 0.25, 0.5, 0.75, 1, 1]);
    expect([...manifest.uvSets[1]!.values]).toEqual(source.uv1Values.map(Math.fround));
    expect(manifest.materials[0]!.baseColorTexture?.texCoord).toBe(0);
    expect(manifest.materials[0]!.occlusionTexture?.texCoord).toBe(1);
  });

  it("lets KHR_texture_transform select UV1 while retaining its transform", () => {
    const source = fixtureWithUv1();
    const material = (source.document.materials as JsonObject[])[0]!, pbr = material.pbrMetallicRoughness as JsonObject;
    pbr.baseColorTexture = { index: 0, extensions: { KHR_texture_transform: {
      texCoord: 1, offset: [0.2, 0.3], scale: [4, 5], rotation: 0.25,
    } } };
    const manifest = extractGltfTextureManifest(source.document, [source.bytes]);
    expect(manifest.materials[0]!.baseColorTexture).toMatchObject({ texCoord: 1, offset: [0.2, 0.3], scale: [4, 5], rotation: 0.25 });
  });

  it("reads authored FLOAT VEC4 tangents for normal-mapped primitives", () => {
    const source = fixture(), tangentValues = [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1];
    const tangentBytes = tangentValues.length * 4, bytes = new Uint8Array(source.uvLength + tangentBytes + png.length);
    bytes.set(source.bytes.subarray(0, source.uvLength));
    const view = new DataView(bytes.buffer);
    tangentValues.forEach((value, index) => view.setFloat32(source.uvLength + index * 4, value, true));
    bytes.set(png, source.uvLength + tangentBytes);
    source.document.buffers = [{ byteLength: bytes.length }];
    source.document.bufferViews = [
      { buffer: 0, byteLength: source.uvLength, target: 34962 },
      { buffer: 0, byteOffset: source.uvLength, byteLength: tangentBytes, target: 34962 },
      { buffer: 0, byteOffset: source.uvLength + tangentBytes, byteLength: png.length },
    ];
    source.document.images = [{ bufferView: 2, mimeType: "image/png" }];
    (source.document.accessors as JsonObject[]).push({ bufferView: 1, componentType: 5126, count: 3, type: "VEC4" });
    ((((source.document.meshes as JsonObject[])[0]!.primitives as JsonObject[])[0]!.attributes as JsonObject)).TANGENT = 2;
    const manifest = extractGltfTextureManifest(source.document, [bytes]);
    expect(manifest.uvSets[0]).toMatchObject({ requiresTangents: true, tangents: new Float32Array(tangentValues) });

    view.setFloat32(source.uvLength + 3 * 4, 0, true);
    expectError(() => extractGltfTextureManifest(source.document, [bytes]), "invalid", "accessors[2]");
  });

  it("deduplicates resources only for the same texture and semantic", () => {
    const { document, bytes } = fixture();
    const materials = document.materials as JsonObject[];
    materials.push({ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } });
    const manifest = extractGltfTextureManifest(document, [bytes]);
    expect(manifest.resources.filter(value => value.semantic === "baseColor")).toHaveLength(1);
    expect(manifest.materials[0]!.baseColorTexture!.texture).toBe(manifest.materials[1]!.baseColorTexture!.texture);
  });

  it("uses the normative T*R*S matrix and preserves glTF's upper-left UV origin", () => {
    const matrix = gltfTextureTransformMatrix({ offset: [0.25, 0.5], scale: [2, 3], rotation: Math.PI / 2 });
    const u = 1, v = 1;
    expect(matrix[0]! * u + matrix[3]! * v + matrix[6]!).toBeCloseTo(-2.75);
    expect(matrix[1]! * u + matrix[4]! * v + matrix[7]!).toBeCloseTo(2.5);
    const identity = gltfTextureTransformMatrix({ offset: [0, 0], scale: [1, 1], rotation: 0 });
    expect([identity[0]! * 0.2 + identity[3]! * 0.8 + identity[6]!, identity[1]! * 0.2 + identity[4]! * 0.8 + identity[7]!]).toEqual([0.2, 0.8]);
  });

  it("rejects image IO ambiguity, signature mismatch and invalid image buffer-view use", () => {
    const a = fixture(); (a.document.images as JsonObject[])[0] = { uri: "texture.png" };
    expectError(() => extractGltfTextureManifest(a.document, [a.bytes]), "unsupported", "images[0].uri");
    const b = fixture(); b.bytes[b.uvLength] = 0;
    expectError(() => extractGltfTextureManifest(b.document, [b.bytes]), "invalid", "images[0]");
    const c = fixture(); (c.document.bufferViews as JsonObject[])[1]!.target = 34962;
    expectError(() => extractGltfTextureManifest(c.document, [c.bytes]), "invalid", "images[0].bufferView");
  });

  it("rejects undeclared/unknown transforms, missing UV1 and coordinate sets above one", () => {
    const a = fixture(); delete a.document.extensionsUsed;
    expectError(() => extractGltfTextureManifest(a.document, [a.bytes]), "invalid", "KHR_texture_transform");
    const b = fixture(); ((b.document.materials as JsonObject[])[0]!.pbrMetallicRoughness as JsonObject).baseColorTexture = { index: 0, texCoord: 1 };
    expectError(() => extractGltfTextureManifest(b.document, [b.bytes]), "invalid", "TEXCOORD_1");
    const high = fixture(); ((high.document.materials as JsonObject[])[0]!.pbrMetallicRoughness as JsonObject).baseColorTexture = { index: 0, texCoord: 2 };
    expectError(() => extractGltfTextureManifest(high.document, [high.bytes]), "unsupported", "texCoord");
    const c = fixture(); c.document.extensionsUsed = ["KHR_materials_unlit"];
    expectError(() => extractGltfTextureManifest(c.document, [c.bytes]), "unsupported", "extensionsUsed");
  });
  it("validates the normative occlusion strength range", () => {
    for (const strength of [-0.1, 1.1, NaN, Infinity, "1"]) {
      const source = fixture();
      (source.document.materials as JsonObject[])[0]!.occlusionTexture = { index: 0, strength };
      expectError(() => extractGltfTextureManifest(source.document, [source.bytes]), "invalid", "occlusionTexture.strength");
    }
  });

  it("rejects invalid samplers, references, UV representation and textured primitive contracts", () => {
    const a = fixture(); (a.document.samplers as JsonObject[])[0]!.wrapS = 7;
    expectError(() => extractGltfTextureManifest(a.document, [a.bytes]), "invalid", "wrapS");
    const b = fixture(); (b.document.textures as JsonObject[])[0]!.source = 2;
    expectError(() => extractGltfTextureManifest(b.document, [b.bytes]), "invalid", "source");
    const c = fixture(5121); (c.document.accessors as JsonObject[])[0]!.normalized = false;
    expectError(() => extractGltfTextureManifest(c.document, [c.bytes]), "invalid", "normalized");
    const d = fixture(); delete (((d.document.meshes as JsonObject[])[0]!.primitives as JsonObject[])[0]!.attributes as JsonObject).TEXCOORD_0;
    expectError(() => extractGltfTextureManifest(d.document, [d.bytes]), "invalid", "TEXCOORD_0");
    const e = fixture(); (e.document.accessors as JsonObject[])[1]!.count = 2;
    expectError(() => extractGltfTextureManifest(e.document, [e.bytes]), "invalid", "primitives[0]");
  });

  it("enforces input and expanded UV budgets before returning partial data", () => {
    const a = fixture(); (a.document.buffers as JsonObject[])[0]!.byteLength = a.bytes.length + 1;
    expectError(() => extractGltfTextureManifest(a.document, [a.bytes]), "invalid", "buffers[0]");
    const chunk = new Uint8Array(1024 * 1024), many = Array(129).fill(chunk);
    expectError(() => extractGltfTextureManifest({ asset: { version: "2.0" },
      buffers: Array(129).fill({ byteLength: 1 }), images: [], textures: [], materials: [], meshes: [] }, many), "limit", "buffers");
  });
});
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
