import { canonicalShaderAbiJson } from "./canonical.js";
import { DEEP_PBR_MESH_V2 } from "./contractV2.js";
import type { DeepPbrMeshShaderAbiV3, ShaderAbiPassVariant } from "./types.js";

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const auxiliaryVariants: readonly ShaderAbiPassVariant[] = [
  { id: "depth-solid", pass: "depth", entryPoints: { vertex: "depthMain", fragment: null },
    attachmentProfiles: ["depth"], bindGroupLayouts: ["view-frame"], vertexStreams: ["geometry", "instance"],
    materialMode: null, shadowMode: null, alphaModes: ["OPAQUE"], rasterModes: ["ccw", "cw", "double"] },
  { id: "depth-mask-plain", pass: "depth", entryPoints: { vertex: "depthMaskMain", fragment: "depthMaskPlain" },
    attachmentProfiles: ["depth"], bindGroupLayouts: ["view-frame"], vertexStreams: ["geometry", "instance"],
    materialMode: null, shadowMode: null, alphaModes: ["MASK"], rasterModes: ["ccw", "cw", "double"] },
  { id: "depth-mask-material", pass: "depth", entryPoints: { vertex: "depthMaskMain", fragment: "depthMaskTextured" },
    attachmentProfiles: ["depth"], bindGroupLayouts: ["view-frame", "material"], vertexStreams: ["geometry", "instance"],
    materialMode: null, shadowMode: null, alphaModes: ["MASK"], rasterModes: ["ccw", "cw", "double"] },
  { id: "picking-solid", pass: "picking", entryPoints: { vertex: "pickingMain", fragment: "pickingPlain" },
    attachmentProfiles: ["picking"], bindGroupLayouts: ["view-frame"], vertexStreams: ["geometry", "instance"],
    materialMode: null, shadowMode: null, alphaModes: ["OPAQUE", "BLEND"], rasterModes: ["ccw", "cw", "double"] },
  { id: "picking-mask-plain", pass: "picking", entryPoints: { vertex: "pickingMaskMain", fragment: "pickingMaskPlain" },
    attachmentProfiles: ["picking"], bindGroupLayouts: ["view-frame"], vertexStreams: ["geometry", "instance"],
    materialMode: null, shadowMode: null, alphaModes: ["MASK"], rasterModes: ["ccw", "cw", "double"] },
  { id: "picking-mask-material", pass: "picking", entryPoints: { vertex: "pickingMaskMain", fragment: "pickingMaskTextured" },
    attachmentProfiles: ["picking"], bindGroupLayouts: ["view-frame", "material"], vertexStreams: ["geometry", "instance"],
    materialMode: null, shadowMode: null, alphaModes: ["MASK"], rasterModes: ["ccw", "cw", "double"] },
];

export const DEEP_PBR_MESH_V3_BYTE_SIZES = Object.freeze({
  instance: 160,
} as const);
export const DEEP_PBR_MESH_V3_OBJECT_ID_SEMANTICS = Object.freeze({
  member: "objectId", semantic: "OBJECT_ID_RGBA8", byteOffset: 144,
  encoding: "rgba8-unorm", background: Object.freeze([0, 0, 0, 0] as const),
} as const);

/** Auxiliary depth/object-id extension. v1/v2 remain byte-for-byte frozen. */
export const DEEP_PBR_MESH_V3: DeepPbrMeshShaderAbiV3 = freeze({
  ...DEEP_PBR_MESH_V2,
  id: "deep.pbr.mesh.v3",
  dataLayouts: DEEP_PBR_MESH_V2.dataLayouts.map((layout) => layout.id !== "instance" ? layout : ({
    ...layout, byteSize: DEEP_PBR_MESH_V3_BYTE_SIZES.instance,
    members: [...layout.members, { name: "objectId", format: "vec4<f32>", byteOffset: 144, byteSize: 16 }],
  })),
  vertexStreams: DEEP_PBR_MESH_V2.vertexStreams.map((stream) => stream.id !== "instance" ? stream : ({
    ...stream, arrayStride: DEEP_PBR_MESH_V3_BYTE_SIZES.instance,
    attributes: [...stream.attributes, {
      semantic: DEEP_PBR_MESH_V3_OBJECT_ID_SEMANTICS.semantic,
      shaderLocation: 14, format: "float32x4", byteOffset: 144,
    }],
  })),
  bindGroupLayouts: [...DEEP_PBR_MESH_V2.bindGroupLayouts, {
    id: "view-frame", group: 0, bindings: [{
      name: "frame", binding: 0, visibility: ["vertex"],
      resource: { kind: "uniform-buffer", dataLayout: "frame", minBindingSize: 208 },
    }],
  }],
  attachmentProfiles: [...DEEP_PBR_MESH_V2.attachmentProfiles,
    { id: "depth", pass: "depth", sampleCount: 1, resolve: "none", colorAttachments: [],
      depthAttachment: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less", depthBias: 0, depthBiasSlopeScale: 0 } },
    { id: "picking", pass: "picking", sampleCount: 1, resolve: "none", colorAttachments: [
      { format: "rgba16float", writeMask: "all", blend: null },
    ], depthAttachment: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less", depthBias: 0, depthBiasSlopeScale: 0 } },
  ],
  passVariants: [...DEEP_PBR_MESH_V2.passVariants, ...auxiliaryVariants],
} satisfies DeepPbrMeshShaderAbiV3);

export const DEEP_PBR_MESH_V3_CANONICAL_JSON = canonicalShaderAbiJson(DEEP_PBR_MESH_V3);
/** SHA-256 golden of DEEP_PBR_MESH_V3_CANONICAL_JSON. */
export const DEEP_PBR_MESH_V3_SHA256 = "4f6183fcd7f4303163e2de6814292dbc28f5e97d94545c6dae58d953aa343c2c";
