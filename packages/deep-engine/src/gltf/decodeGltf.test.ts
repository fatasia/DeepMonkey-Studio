import { describe, expect, it, vi } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { decodeGltf } from "./decodeGltf.js";
import { GltfImportError, MAX_BYTES, type JsonObject } from "./validation.js";

function fixture(): { document: JsonObject; bytes: Uint8Array; primitive: JsonObject } {
  const vertices = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]);
  const bytes = new Uint8Array(78);
  bytes.set(new Uint8Array(vertices.buffer));
  new DataView(bytes.buffer).setUint16(74, 1, true);
  new DataView(bytes.buffer).setUint16(76, 2, true);
  const primitive = { attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 };
  return { bytes, primitive, document: {
    asset: { version: "2.0" }, buffers: [{ byteLength: 78, uri: "https://not-requested.invalid/model.bin" }],
    bufferViews: [{ buffer: 0, byteLength: 72, byteStride: 24 }, { buffer: 0, byteOffset: 72, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
    meshes: [{ primitives: [primitive] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.25, 0.5, 0.75, 0.3], metallicFactor: 0.2, roughnessFactor: 0.4 } }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }],
  } };
}
function expectError(action: () => unknown, code: string, path?: string): GltfImportError {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(GltfImportError);
  const error = caught as GltfImportError;
  expect(error.code).toBe(code);
  if (path) expect(error.path).toContain(path);
  return error;
}

function withTangents(source: ReturnType<typeof fixture>, values: readonly number[]): Uint8Array {
  const tangentOffset = 80, bytes = new Uint8Array(tangentOffset + values.length * 4);
  bytes.set(source.bytes);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(tangentOffset + index * 4, value, true));
  (source.document.buffers as JsonObject[])[0]!.byteLength = bytes.length;
  (source.document.bufferViews as JsonObject[]).push({ buffer: 0, byteOffset: tangentOffset,
    byteLength: values.length * 4, target: 34962 });
  (source.document.accessors as JsonObject[]).push({ bufferView: 2, componentType: 5126,
    count: values.length / 4, type: "VEC4" });
  (source.primitive.attributes as JsonObject).TANGENT = 3;
  return bytes;
}

describe("static glTF RenderPacket import", () => {
  it("decodes interleaved bytes into an independent renderable packet without IO", () => {
    const { document, bytes } = fixture(), fetch = vi.fn(() => { throw new Error("Unexpected IO"); });
    vi.stubGlobal("fetch", fetch);
    try {
      const packet = decodeGltf(document, [bytes], { resourcePrefix: "asset/a" });
      expect(packet.geometries).toHaveLength(1);
      expect([...packet.geometries[0]!.indices]).toEqual([0, 1, 2]);
      expect([...packet.geometries[0]!.vertices]).toEqual([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]);
      expect(packet.materials).toEqual([{ id: "asset/a/material/0", baseColor: [0.25, 0.5, 0.75], metallic: 0.2, roughness: 0.4 }]);
      expect(packet.instances[0]!.id).toBe("asset/a/node/0/primitive/0");
      expect(prepareRenderPacket(packet).batches[0]!.count).toBe(1);
      bytes.fill(0);
      expect(packet.geometries[0]!.vertices[11]).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("generates sequential indices and applies glTF metallic/roughness defaults", () => {
    const { document, bytes, primitive } = fixture();
    delete primitive.indices; delete primitive.material; delete document.materials;
    const packet = decodeGltf(document, [bytes]);
    expect([...packet.geometries[0]!.indices]).toEqual([0, 1, 2]);
    expect(packet.materials).toEqual([{ id: "gltf/material/default", baseColor: [1, 1, 1], metallic: 1, roughness: 1 }]);
  });
  it("owns and validates authored tangent attributes even when the material has no normal texture", () => {
    const source = fixture(), tangents = [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1];
    const bytes = withTangents(source, tangents), packet = decodeGltf(source.document, [bytes]);
    expect([...packet.geometries[0]!.tangents!]).toEqual(tangents);
    bytes.fill(0);
    expect([...packet.geometries[0]!.tangents!]).toEqual(tangents);

    const malformed = fixture();
    const malformedBytes = withTangents(malformed, [2, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
    expectError(() => decodeGltf(malformed.document, [malformedBytes]), "invalid", "TANGENT");
  });
  it("shares one decoded geometry between node instances and keeps primitive material identities", () => {
    const { document, bytes, primitive } = fixture();
    document.meshes = [{ primitives: [primitive, { ...primitive, material: undefined }] }];
    delete ((document.meshes as { primitives: JsonObject[] }[])[0]!.primitives[1]!).material;
    document.nodes = [{ mesh: 0 }, { mesh: 0, translation: [3, 0, 0] }];
    document.scenes = [{ nodes: [0, 1] }];
    const packet = decodeGltf(document, [bytes]);
    expect(packet.geometries).toHaveLength(2); expect(packet.instances).toHaveLength(4);
    expect(packet.instances.map(instance => instance.id)).toEqual(["gltf/node/0/primitive/0", "gltf/node/0/primitive/1", "gltf/node/1/primitive/0", "gltf/node/1/primitive/1"]);
    expect(packet.instances[0]!.geometry).toBe(packet.instances[2]!.geometry);
    expect(packet.instances[0]!.material).not.toBe(packet.instances[1]!.material);
    expect(prepareRenderPacket(packet).batches.map(batch => batch.count)).toEqual([2, 2]);
  });
  it("accepts an explicitly empty scene", () => {
    expect(decodeGltf({ asset: { version: "2.0" }, scenes: [{}] }, [])).toEqual({ geometries: [], materials: [], instances: [] });
  });
  it.each([
    ["textures", [{}]], ["images", [{}]], ["skins", [{}]], ["animations", [{}]], ["cameras", [{}]],
    ["extensionsUsed", ["KHR_materials_unlit"]], ["extensionsRequired", ["KHR_draco_mesh_compression"]],
    ["extensions", { KHR_lights_punctual: {} }],
  ])("rejects unsupported document feature %s without returning a partial packet", (field, value) => {
    const { document, bytes } = fixture(); document[field as string] = value;
    const error = expectError(() => decodeGltf(document, [bytes]), "unsupported", field as string);
    expect(error.feature).toBeTruthy();
  });
  it.each([
    { normalTexture: { index: 0 } }, { occlusionTexture: { index: 0 } }, { emissiveTexture: { index: 0 } },
    { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
    { pbrMetallicRoughness: { metallicRoughnessTexture: { index: 0 } } },
    { extensions: { KHR_materials_clearcoat: {} } },
  ])("rejects unsupported material %j", material => {
    const { document, bytes } = fixture(); document.materials = [material];
    expectError(() => decodeGltf(document, [bytes]), "unsupported", "materials[0]");
  });
  it("imports core emissive and MASK/BLEND material state without display-space conversion", () => {
    const first = fixture(); first.document.materials = [{ alphaMode: "MASK", alphaCutoff: 0.25,
      emissiveFactor: [0.1, 0.2, 0.3], pbrMetallicRoughness: { baseColorFactor: [0.4, 0.5, 0.6, 0.35] } }];
    expect(decodeGltf(first.document, [first.bytes]).materials[0]).toMatchObject({ alphaMode: "MASK", alphaCutoff: 0.25,
      baseColorAlpha: 0.35, emissiveFactor: [0.1, 0.2, 0.3] });
    const second = fixture(); second.document.materials = [{ alphaMode: "BLEND" }];
    expect(decodeGltf(second.document, [second.bytes]).materials[0]).toMatchObject({ alphaMode: "BLEND", baseColorAlpha: 1 });
  });
  it("imports required KHR_materials_emissive_strength and rejects undeclared or excessive values", () => {
    const supported = fixture();
    supported.document.extensionsUsed = ["KHR_materials_emissive_strength"];
    supported.document.extensionsRequired = ["KHR_materials_emissive_strength"];
    supported.document.materials = [{ emissiveFactor: [0.1, 0.2, 0.3],
      extensions: { KHR_materials_emissive_strength: { emissiveStrength: 8 } } }];
    const packet = decodeGltf(supported.document, [supported.bytes]);
    expect(packet.materials[0]).toMatchObject({ emissiveFactor: [0.1, 0.2, 0.3], emissiveStrength: 8 });
    expect([...prepareRenderPacket(packet).batches[0]!.data.slice(32, 35)])
      .toEqual([0.8, 1.6, 2.4].map(Math.fround));

    const undeclared = fixture();
    (undeclared.document.materials as JsonObject[])[0]!.extensions = {
      KHR_materials_emissive_strength: { emissiveStrength: 2 },
    };
    expectError(() => decodeGltf(undeclared.document, [undeclared.bytes]), "invalid", "KHR_materials_emissive_strength");
    for (const emissiveStrength of [-1, Infinity, 257]) {
      const invalid = fixture(); invalid.document.extensionsUsed = ["KHR_materials_emissive_strength"];
      (invalid.document.materials as JsonObject[])[0]!.extensions = {
        KHR_materials_emissive_strength: { emissiveStrength },
      };
      expectError(() => decodeGltf(invalid.document, [invalid.bytes]),
        Number.isFinite(emissiveStrength) && emissiveStrength > 256 ? "unsupported" : "invalid", "emissiveStrength");
    }
  });
  it("preserves double-sided material intent in the render packet", () => {
    const { document, bytes } = fixture();
    (document.materials as JsonObject[])[0]!.doubleSided = true;
    const packet = decodeGltf(document, [bytes]);
    expect(packet.materials[0]!.doubleSided).toBe(true);
    expect(prepareRenderPacket(packet).batches[0]).toMatchObject({ doubleSided: true, mirrored: false });
    expect(prepareRenderPacket(packet).batches[0]!.data[31]).toBe(1);
  });
  it.each([
    { mode: 5 }, { targets: [] }, { extensions: { KHR_draco_mesh_compression: {} } },
    { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 3 } }, { attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 3 } },
  ])("rejects unsupported primitives %j", changed => {
    const { document, bytes, primitive } = fixture(); Object.assign(primitive, changed);
    expectError(() => decodeGltf(document, [bytes]), "unsupported", "meshes[0]");
  });
  it.each([
    { pbrMetallicRoughness: { metallicFactor: -1 } }, { pbrMetallicRoughness: { roughnessFactor: 1.1 } },
    { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1] } }, { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 2] } },
    { doubleSided: "true" }, { emissiveFactor: [0, -1, 0] }, { alphaMode: "ADD" }, { alphaCutoff: -0.1 },
  ])("rejects invalid material data %j", material => {
    const { document, bytes } = fixture(); document.materials = [material];
    expectError(() => decodeGltf(document, [bytes]), "invalid", "materials[0]");
  });
  it("rejects out-of-range indices and differing attribute counts", () => {
    const first = fixture(); new DataView(first.bytes.buffer).setUint16(76, 3, true);
    expectError(() => decodeGltf(first.document, [first.bytes]), "invalid", "indices");
    const second = fixture(); (second.document.accessors as JsonObject[])[1]!.count = 2;
    expectError(() => decodeGltf(second.document, [second.bytes]), "invalid", "primitives[0]");
  });
  it("generates missing normals and rejects nonfinite vertices, zero authored normals and incomplete triangles", () => {
    const generated = fixture(); delete generated.primitive.attributes!.NORMAL;
    expect([...decodeGltf(generated.document, [generated.bytes]).geometries[0]!.vertices])
      .toEqual([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]);
    const first = fixture(); new DataView(first.bytes.buffer).setFloat32(0, Infinity, true);
    expectError(() => decodeGltf(first.document, [first.bytes]), "invalid", "accessors[0]");
    const second = fixture(); second.bytes.fill(0, 12, 24);
    expectError(() => decodeGltf(second.document, [second.bytes]), "invalid", "primitives[0]");
    const third = fixture(); (third.document.accessors as JsonObject[])[2]!.count = 2;
    expectError(() => decodeGltf(third.document, [third.bytes]), "invalid", "primitives[0]");
  });
  it("validates options, references and missing byte inputs with structured errors", () => {
    const { document, bytes, primitive } = fixture();
    expectError(() => decodeGltf(document, []), "invalid", "buffers");
    expectError(() => decodeGltf(document, [bytes], { resourcePrefix: "" }), "invalid", "options.resourcePrefix");
    expectError(() => decodeGltf(document, [bytes], null as never), "invalid", "options");
    primitive.material = 2;
    expectError(() => decodeGltf(document, [bytes]), "invalid", "material");
  });
  it("checks array, byte and expanded geometry budgets before unbounded allocation", () => {
    const empty = { asset: { version: "2.0" }, scenes: [{}], nodes: Array(16_385).fill({}) };
    expectError(() => decodeGltf(empty, []), "limit", "nodes");
    const byte = new Uint8Array(1024 * 1024);
    expectError(() => decodeGltf({ asset: { version: "2.0" }, buffers: Array(129).fill({ byteLength: 1 }), scenes: [{}] }, Array(129).fill(byte)), "limit", "buffers");
    const { document, bytes, primitive } = fixture(); document.meshes = [{ primitives: Array(4096).fill(primitive) }, { primitives: [primitive] }];
    expectError(() => decodeGltf(document, [bytes]), "limit", "geometries");
    expect(MAX_BYTES).toBe(128 * 1024 * 1024);
  });
  it("rejects sparse/cyclic/deep non-JSON inputs without native exceptions", () => {
    const a = fixture(); a.document.materials = Array(1);
    expectError(() => decodeGltf(a.document, [a.bytes]), "invalid", "materials");
    const b = fixture(); b.document.extras = b.document;
    expectError(() => decodeGltf(b.document, [b.bytes]), "invalid", "extras");
    const c = fixture(); let nested: JsonObject = {}; c.document.extras = nested;
    for (let i = 0; i < 130; i++) { const child = {}; nested.child = child; nested = child; }
    expectError(() => decodeGltf(c.document, [c.bytes]), "limit", "extras");
    const d = fixture(); d.document.extras = { value: undefined };
    expectError(() => decodeGltf(d.document, [d.bytes]), "invalid", "extras");
  });
  it.each(["pbrMetallicRoughness", "metallicFactor", "roughnessFactor", "baseColorFactor"])("does not substitute defaults for explicit null %s", field => {
    const { document, bytes } = fixture();
    document.materials = [field === "pbrMetallicRoughness" ? { [field]: null } : { pbrMetallicRoughness: { [field]: null } }];
    expectError(() => decodeGltf(document, [bytes]), "invalid", "materials[0]");
  });
  it("checks unsupported unused accessors and expanded instance count", () => {
    const a = fixture(); (a.document.accessors as JsonObject[]).push({ sparse: {} });
    expectError(() => decodeGltf(a.document, [a.bytes]), "invalid", "accessors[3]");
    const b = fixture(); b.document.meshes = [{ primitives: [b.primitive, b.primitive] }];
    b.document.nodes = Array.from({ length: 8193 }, () => ({ mesh: 0 }));
    b.document.scenes = [{ nodes: Array.from({ length: 8193 }, (_, index) => index) }];
    expectError(() => decodeGltf(b.document, [b.bytes]), "limit", "instances");
  });
});
