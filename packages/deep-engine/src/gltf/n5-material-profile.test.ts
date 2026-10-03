import { describe, expect, it, vi } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { buildCapabilityInventory } from "./capabilityInventory.js";
import { decodeTexturedGlb } from "./decodeTexturedGlb.js";
import type { GltfImageDecoder } from "./textureTypes.js";
import type { JsonObject } from "./validation.js";

/** N5 第三方 GLB 材质/切线 profile：最小 Node 内拼字节夹具，锁定零配置导入三态与损失账本合同。 */

const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const decoder = (): GltfImageDecoder => ({ decode: vi.fn(async () => ({ width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) })) });

const f32 = (values: number[]) => new Uint8Array(Float32Array.from(values).buffer);
const u16 = (values: number[]) => new Uint8Array(Uint16Array.from(values).buffer);

interface PrimitiveSpec {
  readonly positions: number[]; readonly normals?: number[]; readonly uv0?: number[];
  readonly indices: number[]; readonly tangents?: number[];
}

/** 最小 GLB：单网格图元 + 单材质；可选共享 PNG 贴图槽（仅签名，解码由宿主 mock）。 */
function buildGlb(options: {
  primitives: readonly PrimitiveSpec[];
  material?: JsonObject;
  extensionsUsed?: readonly string[];
  extensionsRequired?: readonly string[];
  baseColorTexture?: boolean;
  normalTexture?: boolean;
}): Uint8Array {
  const binary: number[] = [];
  let offset = 0;
  const views: JsonObject[] = [], accessors: JsonObject[] = [];
  const segment = (bytes: Uint8Array) => {
    const padding = (4 - offset % 4) % 4;
    for (let index = 0; index < padding; index++) binary.push(0);
    const view = offset;
    for (const byte of bytes) binary.push(byte);
    views.push({ buffer: 0, byteOffset: view, byteLength: bytes.length });
    offset += view - offset + padding + bytes.length;
    return views.length - 1;
  };
  const accessor = (bytes: Uint8Array, type: string, componentType: number, count: number) => {
    const view = segment(bytes);
    accessors.push({ bufferView: view, componentType, count, type });
    return accessors.length - 1;
  };
  const hasTextures = options.baseColorTexture === true || options.normalTexture === true;
  const builtPrimitives = options.primitives.map(spec => {
    const attributes: JsonObject = { POSITION: accessor(f32(spec.positions), "VEC3", 5126, spec.positions.length / 3) };
    if (spec.normals) attributes.NORMAL = accessor(f32(spec.normals), "VEC3", 5126, spec.normals.length / 3);
    if (spec.tangents) attributes.TANGENT = accessor(f32(spec.tangents), "VEC4", 5126, spec.tangents.length / 4);
    if (spec.uv0) attributes.TEXCOORD_0 = accessor(f32(spec.uv0), "VEC2", 5126, spec.uv0.length / 2);
    return { attributes, indices: accessor(u16(spec.indices), "SCALAR", 5123, spec.indices.length), mode: 4, material: 0 };
  });
  const material: JsonObject = { ...(options.material ?? { pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1] } }) };
  if (options.baseColorTexture) {
    const pbr = (material.pbrMetallicRoughness as JsonObject | undefined) ?? {};
    material.pbrMetallicRoughness = { baseColorFactor: [0.8, 0.8, 0.8, 1], ...pbr, baseColorTexture: { index: 0 } };
  }
  if (options.normalTexture) material.normalTexture = { index: 0 };
  const textureSection = hasTextures
    ? { images: [{ bufferView: segment(PNG_STUB), mimeType: "image/png" }], textures: [{ source: 0 }], samplers: [{}] } : {};
  const document: JsonObject = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: builtPrimitives }], materials: [material],
    buffers: [{ byteLength: offset }], bufferViews: views, accessors,
    ...textureSection,
    ...(options.extensionsUsed ? { extensionsUsed: options.extensionsUsed } : {}),
    ...(options.extensionsRequired ? { extensionsRequired: options.extensionsRequired } : {}),
  };
  const text = JSON.stringify(document), jsonPadding = (4 - new TextEncoder().encode(text).length % 4) % 4;
  const json = new TextEncoder().encode(text + " ".repeat(jsonPadding));
  const binaryLength = binary.length + (4 - binary.length % 4) % 4;
  const result = new Uint8Array(12 + 8 + json.length + 8 + binaryLength), view = new DataView(result.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, result.length, true);
  view.setUint32(12, json.length, true); view.setUint32(16, 0x4e4f534a, true); result.set(json, 20);
  const header = 20 + json.length;
  view.setUint32(header, binaryLength, true); view.setUint32(header + 4, 0x004e4942, true);
  result.set(binary, header + 8);
  return result;
}

/** 干净 UV 四边形（两三角同向）；MIRRORED 让共享顶点 0/2 承受相反 UV 手性。 */
const QUAD = { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uv0: [0, 0, 1, 0, 1, 1, 0, 1], indices: [0, 1, 2, 0, 2, 3] };
const MIRRORED = { ...QUAD, indices: [0, 1, 2, 0, 3, 2] };
const BAD_TANGENT = { ...QUAD, tangents: [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1] };
const UNLIT = { extensions: { KHR_materials_unlit: {} } };

const expectLossContract = (loss: { code: string; stage: string; assetPath: string; detail: string; count: number }): void => {
  expect(loss.code).toMatch(/^[a-z0-9-]{3,64}$/);
  expect(["decode", "material", "extension", "geometry", "animation", "texture"]).toContain(loss.stage);
  expect(loss.assetPath).not.toHaveLength(0);
  expect(loss.detail).not.toHaveLength(0);
  expect(loss.count).toBeGreaterThanOrEqual(1);
};

describe("N5 third-party material and tangent import profiles", () => {
  it("imports zero-config unlit materials with an honest per-material fallback loss", async () => {
    const packet = await decodeTexturedGlb(buildGlb({ primitives: [QUAD], material: UNLIT,
      extensionsUsed: ["KHR_materials_unlit"], baseColorTexture: true }), decoder(), { resourcePrefix: "n5" });
    expect(packet.materials).toHaveLength(1);
    expect(packet.materialLosses).toHaveLength(1);
    expectLossContract(packet.materialLosses![0]!);
    expect(packet.materialLosses![0]).toMatchObject({ code: "extension-fallback", stage: "extension",
      assetPath: "materials[0].extensions.KHR_materials_unlit" });
    expect(packet.materialLosses![0]!.detail).toContain("lit PBR");
    prepareRenderPacket(packet);
  });

  it("imports textureless unlit materials the same way", async () => {
    const packet = await decodeTexturedGlb(buildGlb({ primitives: [QUAD], material: UNLIT,
      extensionsUsed: ["KHR_materials_unlit"] }), decoder(), { resourcePrefix: "n5" });
    expect(packet.materials[0]).toMatchObject({ baseColor: [1, 1, 1], metallic: 1, roughness: 1 });
    expect(packet.materialLosses).toHaveLength(1);
    expect(packet.materialLosses![0]!.code).toBe("extension-fallback");
  });

  it("projects each known-fallback extension of a combo material separately", async () => {
    const packet = await decodeTexturedGlb(buildGlb({ primitives: [QUAD],
      material: { extensions: { KHR_materials_unlit: {}, KHR_materials_specular: {} } },
      extensionsUsed: ["KHR_materials_unlit", "KHR_materials_specular"], baseColorTexture: true }),
    decoder(), { resourcePrefix: "n5" });
    expect(packet.materialLosses!.map(loss => loss.assetPath)).toEqual([
      "materials[0].extensions.KHR_materials_unlit", "materials[0].extensions.KHR_materials_specular",
    ]);
  });

  it("drops unknown non-required material extensions with explicit losses instead of rejecting", async () => {
    const packet = await decodeTexturedGlb(buildGlb({ primitives: [QUAD],
      material: { extensions: { ACME_weathering: {} } }, extensionsUsed: ["ACME_weathering"], baseColorTexture: true }),
    decoder(), { resourcePrefix: "n5" });
    expectLossContract(packet.materialLosses![0]!);
    expect(packet.materialLosses![0]).toMatchObject({ code: "extension-unknown", stage: "extension",
      assetPath: "materials[0].extensions.ACME_weathering" });
    prepareRenderPacket(packet);
  });

  it("still fail-closes unknown required extensions and required unlit", async () => {
    await expect(decodeTexturedGlb(buildGlb({ primitives: [QUAD],
      material: { extensions: { ACME_weathering: {} } }, extensionsUsed: ["ACME_weathering"],
      extensionsRequired: ["ACME_weathering"], baseColorTexture: true }), decoder(), {}))
      .rejects.toMatchObject({ code: "unsupported", path: "extensionsUsed[0]" });
    await expect(decodeTexturedGlb(buildGlb({ primitives: [QUAD], material: UNLIT,
      extensionsUsed: ["KHR_materials_unlit"], extensionsRequired: ["KHR_materials_unlit"],
      baseColorTexture: true }), decoder(), {}))
      .rejects.toMatchObject({ code: "unsupported", path: "extensionsUsed[0]" });
  });

  it("keeps explicit optionalMaterialFallbacks loss-silent (caller made an informed choice)", async () => {
    const packet = await decodeTexturedGlb(buildGlb({ primitives: [QUAD], material: UNLIT,
      extensionsUsed: ["KHR_materials_unlit"], baseColorTexture: true }), decoder(),
    { resourcePrefix: "n5", optionalMaterialFallbacks: ["KHR_materials_unlit"] });
    expect(packet.materialLosses).toBeUndefined();
  });

  it("generates a tangent basis for normal-mapped primitives without authored TANGENT", async () => {
    const packet = await decodeTexturedGlb(buildGlb({ primitives: [QUAD], normalTexture: true }), decoder(),
      { resourcePrefix: "n5" });
    expect(packet.geometries[0]!.tangents).toHaveLength(16);
    expect(packet.materialLosses).toBeUndefined();
    expect(packet.materials[0]!.normalTexture).toBeDefined();
    prepareRenderPacket(packet);
  });

  it("degrades mirrored-UV normal maps with a loss instead of rejecting the asset", async () => {
    const packet = await decodeTexturedGlb(buildGlb({ primitives: [MIRRORED], normalTexture: true }), decoder(),
      { resourcePrefix: "n5" });
    expect(packet.geometries).toHaveLength(1);
    expect(packet.geometries[0]!.tangents).toBeUndefined();
    expect(packet.materials[0]!.normalTexture).toBeUndefined();
    expect(packet.materials[0]!.baseColorTexture).toBeUndefined();
    expect(packet.materialLosses).toHaveLength(1);
    expectLossContract(packet.materialLosses![0]!);
    expect(packet.materialLosses![0]).toMatchObject({ code: "material-normal-tangents-undeliverable", stage: "material",
      assetPath: "materials[0].normalTexture" });
    // 降级后材质与几何都不再引用法线贴图，包级一致性门必须通过。
    prepareRenderPacket(packet);
  });

  it("recovers an unusable authored TANGENT through geometric generation on clean UVs", async () => {
    const packet = await decodeTexturedGlb(buildGlb({ primitives: [BAD_TANGENT], normalTexture: true }), decoder(),
      { resourcePrefix: "n5" });
    expect(packet.geometries[0]!.tangents).toHaveLength(16);
    expect(packet.materials[0]!.normalTexture).toBeDefined();
    expect(packet.materialLosses).toBeUndefined();
    prepareRenderPacket(packet);
  });

  it("keeps loss entries valid under the capability inventory contract", async () => {
    const packet = await decodeTexturedGlb(buildGlb({ primitives: [MIRRORED], normalTexture: true,
      material: UNLIT, extensionsUsed: ["KHR_materials_unlit"] }), decoder(), { resourcePrefix: "n5" });
    const codes = new Set(packet.materialLosses!.map(loss => loss.code));
    expect(codes).toContain("extension-fallback");
    expect(codes).toContain("material-normal-tangents-undeliverable");
    buildCapabilityInventory({ schema: "deep-engine.capability-inventory", schemaVersion: 1, assetId: "asset.n5-fixture",
      path: "direct", objects: [{ objectId: "object/0", renderable: true, semanticsPreserved: true, failures: packet.materialLosses! }] });
  });
});
