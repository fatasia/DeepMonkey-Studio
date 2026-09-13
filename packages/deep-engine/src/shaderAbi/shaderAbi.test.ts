import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEEP_PBR_MESH_V1, DEEP_PBR_MESH_V1_CANONICAL_JSON,
  DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS, DEEP_PBR_MESH_V1_SHA256,
} from "./index.js";

const byId = <T extends { readonly id: string }>(values: readonly T[], id: string): T => {
  const value = values.find(candidate => candidate.id === id);
  if (!value) throw new Error(`Missing ABI item: ${id}`);
  return value;
};

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe("deep.pbr.mesh.v1 shader ABI", () => {
  it("matches its independent SHA-256 golden and is recursively immutable", () => {
    expect(createHash("sha256").update(DEEP_PBR_MESH_V1_CANONICAL_JSON).digest("hex"))
      .toBe(DEEP_PBR_MESH_V1_SHA256);
    expect(JSON.parse(DEEP_PBR_MESH_V1_CANONICAL_JSON)).toEqual(DEEP_PBR_MESH_V1);
    expectDeepFrozen(DEEP_PBR_MESH_V1);
  });

  it("pins the 208/160/144-byte records and all three vertex streams", () => {
    expect(DEEP_PBR_MESH_V1.dataLayouts.map(layout => [layout.id, layout.byteSize, layout.byteAlignment]))
      .toEqual([["frame", 208, 16], ["material", 160, 16], ["instance", 144, 16]]);
    for (const layout of DEEP_PBR_MESH_V1.dataLayouts) {
      const end = Math.max(...layout.members.map(member => member.byteOffset + member.byteSize));
      expect(end).toBe(layout.byteSize);
    }
    expect(DEEP_PBR_MESH_V1.vertexStreams.map(stream => [stream.id, stream.slot, stream.arrayStride, stream.stepMode]))
      .toEqual([["geometry", 0, 40, "vertex"], ["instance", 1, 144, "instance"], ["tangent", 2, 16, "vertex"]]);
    expect(byId(DEEP_PBR_MESH_V1.vertexStreams, "geometry").attributes.map(attribute =>
      [attribute.semantic, attribute.shaderLocation, attribute.byteOffset, attribute.format])).toEqual([
      ["POSITION", 0, 0, "float32x3"], ["NORMAL", 1, 12, "float32x3"],
      ["TEXCOORD_0", 10, 24, "float32x2"], ["TEXCOORD_1", 13, 32, "float32x2"],
    ]);
    expect(byId(DEEP_PBR_MESH_V1.vertexStreams, "instance").attributes.map(attribute => attribute.shaderLocation))
      .toEqual([2, 3, 4, 5, 6, 7, 8, 9, 12]);
    expect(byId(DEEP_PBR_MESH_V1.vertexStreams, "tangent").attributes[0])
      .toEqual({ semantic: "TANGENT", shaderLocation: 11, format: "float32x4", byteOffset: 0 });
  });

  it("versions emissive strength as a reserved v1 material scalar without structural ABI drift", () => {
    expect(DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS).toEqual({
      schemaVersion: 1,
      emissiveStrength: { member: "emissiveRow1", component: "w", floatOffset: 39, defaultValue: 1 },
    });
    expect(DEEP_PBR_MESH_V1.dataLayouts.find((layout) => layout.id === "material")?.byteSize).toBe(160);
  });

  it("pins forward/shadow bindings, attachments, alpha and raster semantics", () => {
    const forward = byId(DEEP_PBR_MESH_V1.bindGroupLayouts, "forward-frame");
    const shadow = byId(DEEP_PBR_MESH_V1.bindGroupLayouts, "shadow-frame");
    const material = byId(DEEP_PBR_MESH_V1.bindGroupLayouts, "material");
    expect([forward.group, shadow.group, material.group]).toEqual([0, 0, 1]);
    expect(forward.bindings.map(binding => [binding.binding, binding.name])).toEqual([
      [0, "frame"], [1, "shadowMap"], [2, "shadowSampler"], [3, "specularEnvironment"],
      [4, "diffuseEnvironment"], [5, "brdfLut"], [6, "environmentSampler"],
    ]);
    expect(shadow.bindings.map(binding => [binding.binding, binding.name, binding.visibility])).toEqual([[0, "frame", ["vertex"]]]);
    expect(material.bindings.map(binding => [binding.binding, binding.name])).toEqual([
      [0, "baseColorMap"], [1, "baseColorSampler"], [2, "metallicRoughnessMap"],
      [3, "metallicRoughnessSampler"], [4, "materialTextures"], [5, "occlusionMap"],
      [6, "occlusionSampler"], [7, "normalMap"], [8, "normalSampler"], [9, "emissiveMap"], [10, "emissiveSampler"],
    ]);

    expect(DEEP_PBR_MESH_V1.attachmentProfiles).toEqual([
      expect.objectContaining({ id: "forward-opaque", sampleCount: 4, resolve: "required",
        colorAttachments: [{ format: "rgba16float", writeMask: "all", blend: null }],
        depthAttachment: expect.objectContaining({ format: "depth24plus", depthWriteEnabled: true }) }),
      expect.objectContaining({ id: "forward-blend", sampleCount: 4, resolve: "required",
        depthAttachment: expect.objectContaining({ format: "depth24plus", depthWriteEnabled: false }) }),
      expect.objectContaining({ id: "shadow", sampleCount: 1, resolve: "none", colorAttachments: [],
        depthAttachment: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: 1, depthBiasSlopeScale: 1 } }),
    ]);
    expect(DEEP_PBR_MESH_V1.alphaModes.map(mode => [mode.mode, mode.shadow, mode.sort]))
      .toEqual([["OPAQUE", "solid", "none"], ["MASK", "alpha-cutout", "none"], ["BLEND", "none", "back-to-front"]]);
    expect(DEEP_PBR_MESH_V1.rasterModes).toEqual([
      { id: "ccw", frontFace: "ccw", cullMode: "back" }, { id: "cw", frontFace: "cw", cullMode: "back" },
      { id: "double", frontFace: "ccw", cullMode: "none" },
    ]);
  });

  it("fully selects forward and shadow layouts without executor inference", () => {
    expect(DEEP_PBR_MESH_V1.passVariants.map(variant => variant.id)).toEqual([
      "forward-plain", "forward-material", "forward-normal",
      "shadow-solid", "shadow-mask-plain", "shadow-mask-material",
    ]);
    expect(byId(DEEP_PBR_MESH_V1.passVariants, "forward-normal")).toMatchObject({
      entryPoints: { vertex: "vertexNormalMapped", fragment: "fragmentMaterial" },
      attachmentProfiles: ["forward-opaque", "forward-blend"],
      bindGroupLayouts: ["forward-frame", "material"],
      vertexStreams: ["geometry", "instance", "tangent"],
      alphaModes: ["OPAQUE", "MASK", "BLEND"], rasterModes: ["ccw", "cw", "double"],
    });
    expect(byId(DEEP_PBR_MESH_V1.passVariants, "shadow-solid")).toMatchObject({
      entryPoints: { vertex: "shadowMain", fragment: null }, bindGroupLayouts: ["shadow-frame"],
      vertexStreams: ["geometry", "instance"], attachmentProfiles: ["shadow"], alphaModes: ["OPAQUE"],
    });
    expect(byId(DEEP_PBR_MESH_V1.passVariants, "shadow-mask-plain")).toMatchObject({
      entryPoints: { vertex: "shadowMaskMain", fragment: "shadowMaskPlain" }, bindGroupLayouts: ["shadow-frame"],
      vertexStreams: ["geometry", "instance"], attachmentProfiles: ["shadow"], alphaModes: ["MASK"],
    });
    expect(byId(DEEP_PBR_MESH_V1.passVariants, "shadow-mask-material")).toMatchObject({
      entryPoints: { vertex: "shadowMaskMain", fragment: "shadowMaskTextured" },
      bindGroupLayouts: ["shadow-frame", "material"], vertexStreams: ["geometry", "instance"],
      attachmentProfiles: ["shadow"], alphaModes: ["MASK"],
    });
  });
});
