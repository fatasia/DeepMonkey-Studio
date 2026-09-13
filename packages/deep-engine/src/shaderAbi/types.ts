export type ShaderAbiStage = "vertex" | "fragment";
export type ShaderAbiDataStorage = "uniform" | "vertex";
export type ShaderAbiDataFormat = "mat4x4<f32>" | "vec4<f32>";
export type ShaderAbiVertexFormat = "float32x2" | "float32x3" | "float32x4";
export type ShaderAbiDataLayoutId = "frame" | "material" | "instance" | "cascaded-shadow";
export type ShaderAbiVertexStreamId = "geometry" | "instance" | "tangent";
export type ShaderAbiBindGroupLayoutId = "forward-frame" | "shadow-frame" | "material";
export type ShaderAbiAttachmentProfileId = "forward-opaque" | "forward-blend" | "shadow";

export interface ShaderAbiDataMember {
  readonly name: string;
  readonly format: ShaderAbiDataFormat;
  readonly byteOffset: number;
  readonly byteSize: number;
}

export interface ShaderAbiDataLayout {
  readonly id: ShaderAbiDataLayoutId;
  readonly storage: ShaderAbiDataStorage;
  readonly byteSize: number;
  readonly byteAlignment: number;
  readonly members: readonly ShaderAbiDataMember[];
}

export interface ShaderAbiVertexAttribute {
  readonly semantic: string;
  readonly shaderLocation: number;
  readonly format: ShaderAbiVertexFormat;
  readonly byteOffset: number;
}

export interface ShaderAbiVertexStream {
  readonly id: ShaderAbiVertexStreamId;
  readonly slot: number;
  readonly arrayStride: number;
  readonly stepMode: "vertex" | "instance";
  readonly attributes: readonly ShaderAbiVertexAttribute[];
}

export interface ShaderAbiUniformBufferBinding {
  readonly kind: "uniform-buffer";
  readonly dataLayout: ShaderAbiDataLayoutId;
  readonly minBindingSize: number;
}

export interface ShaderAbiTextureBinding {
  readonly kind: "texture";
  readonly sampleType: "float" | "depth";
  readonly viewDimension: "2d" | "2d-array" | "cube";
  readonly multisampled: false;
}

export interface ShaderAbiSamplerBinding {
  readonly kind: "sampler";
  readonly samplerType: "filtering" | "comparison";
}

export type ShaderAbiBindingResource = ShaderAbiUniformBufferBinding | ShaderAbiTextureBinding | ShaderAbiSamplerBinding;

export interface ShaderAbiBinding {
  readonly name: string;
  readonly binding: number;
  readonly visibility: readonly ShaderAbiStage[];
  readonly resource: ShaderAbiBindingResource;
}

export interface ShaderAbiBindGroupLayout {
  readonly id: ShaderAbiBindGroupLayoutId;
  readonly group: 0 | 1;
  readonly bindings: readonly ShaderAbiBinding[];
}

export interface ShaderAbiBlendComponent {
  readonly srcFactor: "one" | "src-alpha";
  readonly dstFactor: "one-minus-src-alpha";
  readonly operation: "add";
}

export interface ShaderAbiColorAttachment {
  readonly format: "rgba16float";
  readonly writeMask: "all";
  readonly blend: null | {
    readonly color: ShaderAbiBlendComponent;
    readonly alpha: ShaderAbiBlendComponent;
  };
}

export interface ShaderAbiDepthAttachment {
  readonly format: "depth24plus" | "depth32float";
  readonly depthWriteEnabled: boolean;
  readonly depthCompare: "less";
  readonly depthBias: number;
  readonly depthBiasSlopeScale: number;
}

export interface ShaderAbiAttachmentProfile {
  readonly id: ShaderAbiAttachmentProfileId;
  readonly pass: "forward" | "shadow";
  readonly sampleCount: 1 | 4;
  readonly resolve: "required" | "none";
  readonly colorAttachments: readonly ShaderAbiColorAttachment[];
  readonly depthAttachment: ShaderAbiDepthAttachment;
}

export interface ShaderAbiAlphaMode {
  readonly mode: "OPAQUE" | "MASK" | "BLEND";
  readonly forwardAttachmentProfile: "forward-opaque" | "forward-blend";
  readonly depthWriteEnabled: boolean;
  readonly shadow: "solid" | "alpha-cutout" | "none";
  readonly sort: "none" | "back-to-front";
}

export interface ShaderAbiRasterMode {
  readonly id: "ccw" | "cw" | "double";
  readonly frontFace: "ccw" | "cw";
  readonly cullMode: "back" | "none";
}

export interface ShaderAbiMaterialMode {
  readonly id: "plain" | "material" | "normal";
  readonly bindGroupLayouts: readonly ShaderAbiBindGroupLayoutId[];
  readonly vertexStreams: readonly ShaderAbiVertexStreamId[];
}

export interface ShaderAbiEntryPoints {
  readonly vertex: "vertexMain" | "vertexNormalMapped" | "shadowMain" | "shadowMaskMain";
  readonly fragment: "fragmentMain" | "fragmentMaterial" | "shadowMaskPlain" | "shadowMaskTextured" | null;
}

export interface ShaderAbiPassVariant {
  readonly id: "forward-plain" | "forward-material" | "forward-normal"
    | "shadow-solid" | "shadow-mask-plain" | "shadow-mask-material";
  readonly pass: "forward" | "shadow";
  readonly entryPoints: ShaderAbiEntryPoints;
  readonly attachmentProfiles: readonly ShaderAbiAttachmentProfileId[];
  readonly bindGroupLayouts: readonly ShaderAbiBindGroupLayoutId[];
  readonly vertexStreams: readonly ShaderAbiVertexStreamId[];
  readonly materialMode: "plain" | "material" | "normal" | null;
  readonly shadowMode: "solid" | "maskPlain" | "maskMaterial" | null;
  readonly alphaModes: readonly ("OPAQUE" | "MASK" | "BLEND")[];
  readonly rasterModes: readonly ("ccw" | "cw" | "double")[];
}

export type DeepPbrMeshShaderAbiId = "deep.pbr.mesh.v1" | "deep.pbr.mesh.v2";
export interface DeepPbrMeshShaderAbi {
  readonly schema: "deep.shader-abi";
  readonly schemaVersion: 1;
  readonly id: DeepPbrMeshShaderAbiId;
  readonly dataLayouts: readonly ShaderAbiDataLayout[];
  readonly vertexStreams: readonly ShaderAbiVertexStream[];
  readonly bindGroupLayouts: readonly ShaderAbiBindGroupLayout[];
  readonly attachmentProfiles: readonly ShaderAbiAttachmentProfile[];
  readonly alphaModes: readonly ShaderAbiAlphaMode[];
  readonly rasterModes: readonly ShaderAbiRasterMode[];
  readonly materialModes: readonly ShaderAbiMaterialMode[];
  readonly passVariants: readonly ShaderAbiPassVariant[];
}
export interface DeepPbrMeshShaderAbiV1 extends DeepPbrMeshShaderAbi { readonly id: "deep.pbr.mesh.v1" }
export interface DeepPbrMeshShaderAbiV2 extends DeepPbrMeshShaderAbi { readonly id: "deep.pbr.mesh.v2" }
