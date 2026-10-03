import { describe, expect, it } from "vitest";
import { adaptDeepSlStandardToShaderPackage } from "../shaderAuthoring/packageAdapter.js";
import { ALL_TEXTURES, OPAQUE, packageRequest } from "../shaderAuthoring/packageAdapter.testFixture.js";
import { createRuntimeDeepSlMaterial } from "./deepSlMaterial.js";
import { normalizeRuntimeRenderPacket } from "./renderPacket.js";
import { prepareShaderPackageInstanceStream } from "./shaderInstanceProfile.js";
import { prepareRenderPacket } from "../renderPacket.js";
import { DEEP_PBR_MESH_V3 } from "../shaderAbi/index.js";

const refs = { baseColor: "color", metallicRoughness: "mr", normal: "normal", occlusion: "ao", emissive: "emission" } as const;
function compile(source: string, targetAbi = "deep.pbr.mesh.v2") {
  return adaptDeepSlStandardToShaderPackage({ ...packageRequest(source), targetAbi });
}
function parameterized(source: string): string {
  return source.replace("\n}", `
  emissiveFactor [0.1, 0.2, 0.3];
  emissiveStrength 8;
}`);
}

describe("DeepSL material defaults in runtime packages", () => {
  it("preserves five slots, second UVs, transforms and authored scalar parameters", () => {
    const source = parameterized(ALL_TEXTURES).replace("\n}", `
  baseColorTextureTransform texCoord 1 offset [0.25, -0.5] scale [2, 3] rotation 0.3;
  normalScale -0.75;
  occlusionStrength 0.35;
}`);
    const value = createRuntimeDeepSlMaterial("custom", compile(source), refs);
    expect(value.binding).toEqual({ materialId: "custom", packageId: "deep.package", techniqueId: "webgpu" });
    expect(value.material).toMatchObject({ baseColor: [0.12, 0.42, 0.9], metallic: 0.65, roughness: 0.24,
      baseColorTexture: { texture: "color", texCoord: 1, offset: [0.25, -0.5], scale: [2, 3], rotation: 0.3 },
      metallicRoughnessTexture: { texture: "mr" }, normalTexture: { texture: "normal", normalScale: -0.75 },
      occlusionTexture: { texture: "ao", strength: 0.35 }, emissiveTexture: { texture: "emission" },
      emissiveFactor: [0.1, 0.2, 0.3], emissiveStrength: 8,
    });
    expect(Object.isFrozen(value.material.baseColorTexture?.offset)).toBe(true);
  });

  it("applies emissive gain exactly once in plain and textured native exports", () => {
    for (const [source, references] of [[OPAQUE, {}], [ALL_TEXTURES, refs]] as const) {
      const authored = createRuntimeDeepSlMaterial("surface", compile(parameterized(source)), references);
      const packet = { materials: [JSON.parse(JSON.stringify(authored.material))] };
      normalizeRuntimeRenderPacket(packet);
      expect(packet.materials[0].emissiveFactor).toEqual([0.8, 1.6, 2.4]);
      expect(packet.materials[0]).not.toHaveProperty("emissiveStrength");
    }
  });

  it.each(["mask", "blend"])("preserves %s alpha and double-sided flags", mode => {
    const source = OPAQUE.replace("alpha opaque", `alpha ${mode}`).replace("doubleSided false", "doubleSided true");
    expect(createRuntimeDeepSlMaterial("surface", compile(source)).material).toMatchObject({
      alphaMode: mode.toUpperCase(), baseColorAlpha: 0.8, doubleSided: true, alphaCutoff: 0.5,
    });
  });

  it("binds a v3 clearcoat package only when the actual consumer explicitly declares v3 support", () => {
    const source = OPAQUE.replace("metallic 0.65;", "metallic 0.65;\n clearcoatFactor 0.85;\n clearcoatRoughness 0.08;");
    const compiled = compile(source, "deep.pbr.mesh.v3");
    expect(compiled.success).toBe(true);
    expect(() => createRuntimeDeepSlMaterial("coated", compiled)).toThrow("shader ABI");
    const explicit = createRuntimeDeepSlMaterial("coated", compiled, {}, { shaderAbis: ["deep.pbr.mesh.v3"] });
    expect(explicit.binding).toMatchObject({ materialId: "coated", techniqueId: "webgpu" });
    expect(explicit.material.baseColor).toEqual([0.12, 0.42, 0.9]);
    expect(explicit.material).not.toHaveProperty("extendedParameters"); // coat is already in compiled WGSL, never applied twice
  });

  it("binds actual prepared v2 rows to v3 stride and object-id lanes without corrupting the old prefix", () => {
    const material = createRuntimeDeepSlMaterial("surface", compile(OPAQUE)).material;
    const packet = { materials: [material], geometries: [{ id: "triangle", revision: 0,
      vertices: new Float32Array([-1, -1, 0, 0, 0, 1, 1, -1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }],
      instances: ["a", "b"].map((id, i) => ({ id, geometry: "triangle", material: "surface",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i * 3, 0, 0, 1] })) };
    const batch = prepareRenderPacket(packet).batches[0]!;
    const oldBytes = Uint8Array.from(new Uint8Array(batch.data.buffer));
    const v2 = prepareShaderPackageInstanceStream(batch, "deep.pbr.mesh.v2");
    expect(v2.arrayStride).toBe(144); expect(v2.data).toBe(batch.data);
    const v3 = prepareShaderPackageInstanceStream(batch, "deep.pbr.mesh.v3", new Map([["a", 0x01020304], ["b", 0xffffffff]]));
    const contract = DEEP_PBR_MESH_V3.vertexStreams.find(s => s.id === "instance")!;
    expect(v3.arrayStride).toBe(contract.arrayStride); expect(v3.data.byteLength).toBe(2 * 160);
    for (let row = 0; row < 2; row++) expect(v3.data.slice(row * 40, row * 40 + 36)).toEqual(batch.data.slice(row * 36, row * 36 + 36));
    expect(v3.data.slice(36, 40)).toEqual(Float32Array.from([4, 3, 2, 1].map(value => value / 255)));
    expect(v3.data.slice(76, 80)).toEqual(Float32Array.from([1, 1, 1, 1]));
    expect(contract.attributes.find(a => a.shaderLocation === 14)?.byteOffset).toBe(144);
    expect(new Uint8Array(batch.data.buffer)).toEqual(oldBytes);
    expect(() => prepareShaderPackageInstanceStream(batch, "deep.pbr.mesh.v3")).toThrow("object-id");
    expect(() => prepareShaderPackageInstanceStream({ ...batch, data: v3.data }, "deep.pbr.mesh.v3")).toThrow("stride");
    expect(() => prepareShaderPackageInstanceStream(batch, "deep.pbr.mesh.v3", new Map([["a", 0], ["b", 1]]))).toThrow("nonzero");
  });

  it("keeps v3 default-zero material values identical to the original v2 material without extending the wire profile", () => {
    const v2 = createRuntimeDeepSlMaterial("surface", compile(OPAQUE));
    const zero = OPAQUE.replace("metallic 0.65;", "metallic 0.65;\n clearcoatFactor 0;\n clearcoatRoughness 0.8;");
    const v3 = createRuntimeDeepSlMaterial("surface", compile(zero, "deep.pbr.mesh.v3"), {}, { shaderAbis: ["deep.pbr.mesh.v3"] });
    expect(v3).toEqual(v2);
    expect(JSON.parse(JSON.stringify(v3))).toEqual(JSON.parse(JSON.stringify(v2)));
    expect(() => createRuntimeDeepSlMaterial("surface", compile(OPAQUE, "deep.pbr.mesh.v1"), {}, { shaderAbis: ["deep.pbr.mesh.v3"] })).toThrow("shader ABI");
  });

  it("refuses missing or disabled texture references and rejected compilations", () => {
    expect(() => createRuntimeDeepSlMaterial("surface", compile(ALL_TEXTURES), { baseColor: "color" })).toThrow("resolved resource reference");
    expect(() => createRuntimeDeepSlMaterial("surface", compile(OPAQUE), { normal: "normal" })).toThrow("not enabled");
    expect(() => createRuntimeDeepSlMaterial("surface", compile("invalid source"))).toThrow("rejected DeepSL");
    expect(() => createRuntimeDeepSlMaterial("surface", compile(OPAQUE, "deep.pbr.mesh.v1"))).toThrow("CSM shader ABI");
  });
});
