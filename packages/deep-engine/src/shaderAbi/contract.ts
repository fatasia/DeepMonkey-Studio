import { canonicalShaderAbiJson } from "./canonical.js";
import type { DeepPbrMeshShaderAbiV1 } from "./types.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const vec4Members = (names: readonly string[]) => names.map((name, index) => ({
  name, format: "vec4<f32>" as const, byteOffset: index * 16, byteSize: 16,
}));

export const DEEP_PBR_MESH_V1_BYTE_SIZES = Object.freeze({
  frame: 208, material: 160, instance: 144, geometryVertex: 40, tangentVertex: 16,
} as const);

/** v1 的 160B material block 保留量语义表；只增加语义，不改变 ABI 指纹或 pipeline layout。 */
export const DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS = Object.freeze({
  schemaVersion: 1,
  emissiveStrength: Object.freeze({ member: "emissiveRow1", component: "w", floatOffset: 39, defaultValue: 1 }),
} as const);

/** Browser renderer's canonical mesh ABI. Any structural change requires a new id and golden fingerprint. */
export const DEEP_PBR_MESH_V1: DeepPbrMeshShaderAbiV1 = deepFreeze({
  schema: "deep.shader-abi",
  schemaVersion: 1,
  id: "deep.pbr.mesh.v1",
  dataLayouts: [
    { id: "frame", storage: "uniform", byteSize: DEEP_PBR_MESH_V1_BYTE_SIZES.frame, byteAlignment: 16, members: [
      { name: "view", format: "mat4x4<f32>", byteOffset: 0, byteSize: 64 },
      { name: "light", format: "mat4x4<f32>", byteOffset: 64, byteSize: 64 },
      ...vec4Members(["eye", "background", "floor", "lightDirection", "tuning"]).map((member, index) => ({
        ...member, byteOffset: 128 + index * 16,
      })),
    ] },
    { id: "material", storage: "uniform", byteSize: DEEP_PBR_MESH_V1_BYTE_SIZES.material, byteAlignment: 16, members: vec4Members([
      "baseRow0", "baseRow1", "mrRow0", "mrRow1", "occlusionRow0", "occlusionRow1",
      "normalRow0", "normalRow1", "emissiveRow0", "emissiveRow1",
    ]) },
    { id: "instance", storage: "vertex", byteSize: DEEP_PBR_MESH_V1_BYTE_SIZES.instance, byteAlignment: 16, members: vec4Members([
      "modelRow0", "modelRow1", "modelRow2", "normalColumn0", "normalColumn1", "normalColumn2",
      "baseColorMetallic", "roughnessAlphaCutoffHandednessFlags", "emissiveAlpha",
    ]) },
  ],
  vertexStreams: [
    { id: "geometry", slot: 0, arrayStride: DEEP_PBR_MESH_V1_BYTE_SIZES.geometryVertex, stepMode: "vertex", attributes: [
      { semantic: "POSITION", shaderLocation: 0, format: "float32x3", byteOffset: 0 },
      { semantic: "NORMAL", shaderLocation: 1, format: "float32x3", byteOffset: 12 },
      { semantic: "TEXCOORD_0", shaderLocation: 10, format: "float32x2", byteOffset: 24 },
      { semantic: "TEXCOORD_1", shaderLocation: 13, format: "float32x2", byteOffset: 32 },
    ] },
    { id: "instance", slot: 1, arrayStride: DEEP_PBR_MESH_V1_BYTE_SIZES.instance, stepMode: "instance", attributes: [
      { semantic: "MODEL_ROW_0", shaderLocation: 2, format: "float32x4", byteOffset: 0 },
      { semantic: "MODEL_ROW_1", shaderLocation: 3, format: "float32x4", byteOffset: 16 },
      { semantic: "MODEL_ROW_2", shaderLocation: 4, format: "float32x4", byteOffset: 32 },
      { semantic: "NORMAL_COLUMN_0", shaderLocation: 5, format: "float32x4", byteOffset: 48 },
      { semantic: "NORMAL_COLUMN_1", shaderLocation: 6, format: "float32x4", byteOffset: 64 },
      { semantic: "NORMAL_COLUMN_2", shaderLocation: 7, format: "float32x4", byteOffset: 80 },
      { semantic: "BASE_COLOR_METALLIC", shaderLocation: 8, format: "float32x4", byteOffset: 96 },
      { semantic: "ROUGHNESS_ALPHA_CUTOFF_HANDEDNESS_FLAGS", shaderLocation: 9, format: "float32x4", byteOffset: 112 },
      { semantic: "EMISSIVE_ALPHA", shaderLocation: 12, format: "float32x4", byteOffset: 128 },
    ] },
    { id: "tangent", slot: 2, arrayStride: DEEP_PBR_MESH_V1_BYTE_SIZES.tangentVertex, stepMode: "vertex", attributes: [
      { semantic: "TANGENT", shaderLocation: 11, format: "float32x4", byteOffset: 0 },
    ] },
  ],
  bindGroupLayouts: [
    { id: "forward-frame", group: 0, bindings: [
      { name: "frame", binding: 0, visibility: ["vertex", "fragment"], resource: { kind: "uniform-buffer", dataLayout: "frame", minBindingSize: DEEP_PBR_MESH_V1_BYTE_SIZES.frame } },
      { name: "shadowMap", binding: 1, visibility: ["fragment"], resource: { kind: "texture", sampleType: "depth", viewDimension: "2d", multisampled: false } },
      { name: "shadowSampler", binding: 2, visibility: ["fragment"], resource: { kind: "sampler", samplerType: "comparison" } },
      { name: "specularEnvironment", binding: 3, visibility: ["fragment"], resource: { kind: "texture", sampleType: "float", viewDimension: "cube", multisampled: false } },
      { name: "diffuseEnvironment", binding: 4, visibility: ["fragment"], resource: { kind: "texture", sampleType: "float", viewDimension: "cube", multisampled: false } },
      { name: "brdfLut", binding: 5, visibility: ["fragment"], resource: { kind: "texture", sampleType: "float", viewDimension: "2d", multisampled: false } },
      { name: "environmentSampler", binding: 6, visibility: ["fragment"], resource: { kind: "sampler", samplerType: "filtering" } },
    ] },
    { id: "shadow-frame", group: 0, bindings: [
      { name: "frame", binding: 0, visibility: ["vertex"], resource: { kind: "uniform-buffer", dataLayout: "frame", minBindingSize: DEEP_PBR_MESH_V1_BYTE_SIZES.frame } },
    ] },
    { id: "material", group: 1, bindings: [
      { name: "baseColorMap", binding: 0, visibility: ["fragment"], resource: { kind: "texture", sampleType: "float", viewDimension: "2d", multisampled: false } },
      { name: "baseColorSampler", binding: 1, visibility: ["fragment"], resource: { kind: "sampler", samplerType: "filtering" } },
      { name: "metallicRoughnessMap", binding: 2, visibility: ["fragment"], resource: { kind: "texture", sampleType: "float", viewDimension: "2d", multisampled: false } },
      { name: "metallicRoughnessSampler", binding: 3, visibility: ["fragment"], resource: { kind: "sampler", samplerType: "filtering" } },
      { name: "materialTextures", binding: 4, visibility: ["fragment"], resource: { kind: "uniform-buffer", dataLayout: "material", minBindingSize: DEEP_PBR_MESH_V1_BYTE_SIZES.material } },
      { name: "occlusionMap", binding: 5, visibility: ["fragment"], resource: { kind: "texture", sampleType: "float", viewDimension: "2d", multisampled: false } },
      { name: "occlusionSampler", binding: 6, visibility: ["fragment"], resource: { kind: "sampler", samplerType: "filtering" } },
      { name: "normalMap", binding: 7, visibility: ["fragment"], resource: { kind: "texture", sampleType: "float", viewDimension: "2d", multisampled: false } },
      { name: "normalSampler", binding: 8, visibility: ["fragment"], resource: { kind: "sampler", samplerType: "filtering" } },
      { name: "emissiveMap", binding: 9, visibility: ["fragment"], resource: { kind: "texture", sampleType: "float", viewDimension: "2d", multisampled: false } },
      { name: "emissiveSampler", binding: 10, visibility: ["fragment"], resource: { kind: "sampler", samplerType: "filtering" } },
    ] },
  ],
  attachmentProfiles: [
    { id: "forward-opaque", pass: "forward", sampleCount: 4, resolve: "required", colorAttachments: [
      { format: "rgba16float", writeMask: "all", blend: null },
    ], depthAttachment: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less", depthBias: 0, depthBiasSlopeScale: 0 } },
    { id: "forward-blend", pass: "forward", sampleCount: 4, resolve: "required", colorAttachments: [
      { format: "rgba16float", writeMask: "all", blend: {
        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      } },
    ], depthAttachment: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less", depthBias: 0, depthBiasSlopeScale: 0 } },
    { id: "shadow", pass: "shadow", sampleCount: 1, resolve: "none", colorAttachments: [],
      depthAttachment: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: 1, depthBiasSlopeScale: 1 } },
  ],
  alphaModes: [
    { mode: "OPAQUE", forwardAttachmentProfile: "forward-opaque", depthWriteEnabled: true, shadow: "solid", sort: "none" },
    { mode: "MASK", forwardAttachmentProfile: "forward-opaque", depthWriteEnabled: true, shadow: "alpha-cutout", sort: "none" },
    { mode: "BLEND", forwardAttachmentProfile: "forward-blend", depthWriteEnabled: false, shadow: "none", sort: "back-to-front" },
  ],
  rasterModes: [
    { id: "ccw", frontFace: "ccw", cullMode: "back" },
    { id: "cw", frontFace: "cw", cullMode: "back" },
    { id: "double", frontFace: "ccw", cullMode: "none" },
  ],
  materialModes: [
    { id: "plain", bindGroupLayouts: ["forward-frame"], vertexStreams: ["geometry", "instance"] },
    { id: "material", bindGroupLayouts: ["forward-frame", "material"], vertexStreams: ["geometry", "instance"] },
    { id: "normal", bindGroupLayouts: ["forward-frame", "material"], vertexStreams: ["geometry", "instance", "tangent"] },
  ],
  passVariants: [
    { id: "forward-plain", pass: "forward", entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" },
      attachmentProfiles: ["forward-opaque", "forward-blend"], bindGroupLayouts: ["forward-frame"],
      vertexStreams: ["geometry", "instance"], materialMode: "plain", shadowMode: null,
      alphaModes: ["OPAQUE", "MASK", "BLEND"], rasterModes: ["ccw", "cw", "double"] },
    { id: "forward-material", pass: "forward", entryPoints: { vertex: "vertexMain", fragment: "fragmentMaterial" },
      attachmentProfiles: ["forward-opaque", "forward-blend"], bindGroupLayouts: ["forward-frame", "material"],
      vertexStreams: ["geometry", "instance"], materialMode: "material", shadowMode: null,
      alphaModes: ["OPAQUE", "MASK", "BLEND"], rasterModes: ["ccw", "cw", "double"] },
    { id: "forward-normal", pass: "forward", entryPoints: { vertex: "vertexNormalMapped", fragment: "fragmentMaterial" },
      attachmentProfiles: ["forward-opaque", "forward-blend"], bindGroupLayouts: ["forward-frame", "material"],
      vertexStreams: ["geometry", "instance", "tangent"], materialMode: "normal", shadowMode: null,
      alphaModes: ["OPAQUE", "MASK", "BLEND"], rasterModes: ["ccw", "cw", "double"] },
    { id: "shadow-solid", pass: "shadow", entryPoints: { vertex: "shadowMain", fragment: null },
      attachmentProfiles: ["shadow"], bindGroupLayouts: ["shadow-frame"], vertexStreams: ["geometry", "instance"],
      materialMode: null, shadowMode: "solid", alphaModes: ["OPAQUE"], rasterModes: ["ccw", "cw", "double"] },
    { id: "shadow-mask-plain", pass: "shadow", entryPoints: { vertex: "shadowMaskMain", fragment: "shadowMaskPlain" },
      attachmentProfiles: ["shadow"], bindGroupLayouts: ["shadow-frame"], vertexStreams: ["geometry", "instance"],
      materialMode: null, shadowMode: "maskPlain", alphaModes: ["MASK"], rasterModes: ["ccw", "cw", "double"] },
    { id: "shadow-mask-material", pass: "shadow", entryPoints: { vertex: "shadowMaskMain", fragment: "shadowMaskTextured" },
      attachmentProfiles: ["shadow"], bindGroupLayouts: ["shadow-frame", "material"], vertexStreams: ["geometry", "instance"],
      materialMode: null, shadowMode: "maskMaterial", alphaModes: ["MASK"], rasterModes: ["ccw", "cw", "double"] },
  ],
} satisfies DeepPbrMeshShaderAbiV1);

export const DEEP_PBR_MESH_V1_CANONICAL_JSON = canonicalShaderAbiJson(DEEP_PBR_MESH_V1);

/** SHA-256 of DEEP_PBR_MESH_V1_CANONICAL_JSON. Update only when introducing a deliberate ABI revision. */
export const DEEP_PBR_MESH_V1_SHA256 = "cbfaa36e9f2f689684e4a9086a61f165873d2a3398b6a4633aa5b2bcb117f46c";
