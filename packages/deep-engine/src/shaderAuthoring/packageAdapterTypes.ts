import type { ShaderCompileCapabilities } from "../shader/types.js";
import type { DeepPbrMeshShaderAbiId } from "../shaderAbi/types.js";
import type { DeepShaderPackageV2, ShaderPackagePipelineSelection } from "../shaderPackage/types.js";

export const DEEP_SL_PACKAGE_ADAPTER_SCHEMA = "deep.deepsl-package-adapter" as const;
export const DEEP_SL_PACKAGE_ADAPTER_SCHEMA_VERSION = 1 as const;
export const DEEP_SL_PACKAGE_ADAPTER_PROFILE = "deep.pbr.mesh.v1/deepsl-standard-plain.v2" as const;
export const DEEP_SL_PACKAGE_TEXTURE_ADAPTER_PROFILE = "deep.pbr.mesh.v1/deepsl-standard-textures.v2" as const;
export const DEEP_SL_PACKAGE_CSM_ADAPTER_PROFILE = "deep.pbr.mesh.v2/deepsl-standard-plain.v2" as const;
export const DEEP_SL_PACKAGE_CSM_TEXTURE_ADAPTER_PROFILE = "deep.pbr.mesh.v2/deepsl-standard-textures.v2" as const;
export const DEEP_SL_UNLIT_PACKAGE_ADAPTER_PROFILE = "deep.pbr.mesh.v1/deepsl-unlit-plain.v2" as const;
export const DEEP_SL_UNLIT_PACKAGE_TEXTURE_ADAPTER_PROFILE = "deep.pbr.mesh.v1/deepsl-unlit-textures.v2" as const;
export const DEEP_SL_UNLIT_PACKAGE_CSM_ADAPTER_PROFILE = "deep.pbr.mesh.v2/deepsl-unlit-plain.v2" as const;
export const DEEP_SL_UNLIT_PACKAGE_CSM_TEXTURE_ADAPTER_PROFILE = "deep.pbr.mesh.v2/deepsl-unlit-textures.v2" as const;
export const DEEP_SL_PACKAGE_AUXILIARY_ADAPTER_PROFILE = "deep.pbr.mesh.v3/deepsl-standard-plain.v2" as const;
export const DEEP_SL_PACKAGE_AUXILIARY_TEXTURE_ADAPTER_PROFILE = "deep.pbr.mesh.v3/deepsl-standard-textures.v2" as const;
export const DEEP_SL_UNLIT_PACKAGE_AUXILIARY_ADAPTER_PROFILE = "deep.pbr.mesh.v3/deepsl-unlit-plain.v2" as const;
export const DEEP_SL_UNLIT_PACKAGE_AUXILIARY_TEXTURE_ADAPTER_PROFILE = "deep.pbr.mesh.v3/deepsl-unlit-textures.v2" as const;

export interface DeepSlPackageAdapterInput {
  readonly targetAbi?: DeepPbrMeshShaderAbiId;
  readonly schemaVersion: 1;
  readonly source: string;
  readonly packageId?: string;
  readonly packageVersion: string;
  readonly compilerVersion: string;
  readonly capabilities: ShaderCompileCapabilities;
}

export type DeepSlPackageCompatibilityIssueCode =
  | "invalid-request"
  | "invalid-deepsl"
  | "unsupported-surface"
  | "unsupported-unlit-field"
  | "unsupported-capability"
  | "shader-ir-build-failed"
  | "shader-compile-failed"
  | "package-build-failed";

export interface DeepSlPackageCompatibilityIssue {
  readonly code: DeepSlPackageCompatibilityIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface DeepPbrMeshV1MaterialDefaults {
  readonly baseColorMetallic: readonly [number, number, number, number];
  readonly roughnessAlphaCutoffHandednessFlags: readonly [number, number, number, number];
  readonly emissiveAlpha: readonly [number, number, number, number];
}

export interface DeepSlClearcoatDefaults {
  readonly factor: number;
  readonly roughness: number;
  readonly source: "compile-time-v3";
}

export type DeepPbrMeshV1TextureSemantic = "baseColor" | "metallicRoughness" | "normal" | "occlusion" | "emissive";

interface DeepPbrMeshV1MaterialTextureSlotDefaults {
  readonly semantic: DeepPbrMeshV1TextureSemantic;
  readonly enabled: boolean;
  readonly colorSpace: "linear" | "srgb";
  readonly texCoord: 0 | 1;
  readonly supportedTexCoords: readonly [0, 1];
  readonly offset: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotation: number;
  readonly uvTransform: readonly [number, number, number, number, number, number];
}

export interface DeepPbrMeshV1MaterialTextureDefaults {
  readonly byteSize: 160;
  readonly parameters: readonly number[];
  readonly enabledSlots: readonly DeepPbrMeshV1TextureSemantic[];
  readonly baseColor: Readonly<DeepPbrMeshV1MaterialTextureSlotDefaults & { semantic: "baseColor"; colorSpace: "srgb" }>;
  readonly metallicRoughness: Readonly<DeepPbrMeshV1MaterialTextureSlotDefaults & {
    semantic: "metallicRoughness"; colorSpace: "linear"; metallicChannel: "b"; roughnessChannel: "g";
  }>;
  readonly normal: Readonly<DeepPbrMeshV1MaterialTextureSlotDefaults & {
    semantic: "normal"; colorSpace: "linear"; normalScale: number;
  }>;
  readonly occlusion: Readonly<DeepPbrMeshV1MaterialTextureSlotDefaults & {
    semantic: "occlusion"; colorSpace: "linear"; channel: "r"; strength: number;
  }>;
  readonly emissive: Readonly<DeepPbrMeshV1MaterialTextureSlotDefaults & {
    semantic: "emissive"; colorSpace: "srgb"; emissiveStrength: number;
  }>;
  readonly dummySlots: readonly Readonly<{
    binding: DeepPbrMeshV1TextureSemantic;
    colorSpace: "linear" | "srgb";
  }>[];
}

export interface DeepSlPackagePassCompatibility {
  readonly passId: string;
  readonly kind: "forward" | "depth" | "shadow" | "picking";
  readonly entryPoints: Readonly<{ vertex: string; fragment: string | null }>;
  readonly pipeline: ShaderPackagePipelineSelection;
}

export interface DeepSlPackageCompatibilityReport {
  readonly schema: typeof DEEP_SL_PACKAGE_ADAPTER_SCHEMA;
  readonly schemaVersion: typeof DEEP_SL_PACKAGE_ADAPTER_SCHEMA_VERSION;
  readonly adapterProfile: typeof DEEP_SL_PACKAGE_ADAPTER_PROFILE | typeof DEEP_SL_PACKAGE_TEXTURE_ADAPTER_PROFILE
    | typeof DEEP_SL_PACKAGE_CSM_ADAPTER_PROFILE | typeof DEEP_SL_PACKAGE_CSM_TEXTURE_ADAPTER_PROFILE
    | typeof DEEP_SL_PACKAGE_AUXILIARY_ADAPTER_PROFILE | typeof DEEP_SL_PACKAGE_AUXILIARY_TEXTURE_ADAPTER_PROFILE
    | typeof DEEP_SL_UNLIT_PACKAGE_ADAPTER_PROFILE | typeof DEEP_SL_UNLIT_PACKAGE_TEXTURE_ADAPTER_PROFILE
    | typeof DEEP_SL_UNLIT_PACKAGE_CSM_ADAPTER_PROFILE | typeof DEEP_SL_UNLIT_PACKAGE_CSM_TEXTURE_ADAPTER_PROFILE
    | typeof DEEP_SL_UNLIT_PACKAGE_AUXILIARY_ADAPTER_PROFILE | typeof DEEP_SL_UNLIT_PACKAGE_AUXILIARY_TEXTURE_ADAPTER_PROFILE;
  readonly status: "direct-package-ready" | "rejected";
  readonly shaderAbi: DeepPbrMeshShaderAbiId;
  readonly materialSource: "instance-stream" | "instance-and-material-bind-group";
  readonly bindGroupLayouts: readonly ("forward-frame" | "shadow-frame" | "view-frame" | "material")[];
  readonly vertexStreams: readonly ("geometry" | "instance" | "tangent")[];
  readonly passSelections: readonly DeepSlPackagePassCompatibility[];
  readonly materialDefaults?: DeepPbrMeshV1MaterialDefaults;
  readonly materialTextureDefaults?: DeepPbrMeshV1MaterialTextureDefaults;
  readonly clearcoat?: DeepSlClearcoatDefaults;
  readonly issues: readonly DeepSlPackageCompatibilityIssue[];
}

export type DeepSlPackageAdapterResult =
  | Readonly<{
      success: true;
      report: DeepSlPackageCompatibilityReport & Readonly<{ status: "direct-package-ready" }>;
      package: DeepShaderPackageV2;
    }>
  | Readonly<{
      success: false;
      report: DeepSlPackageCompatibilityReport & Readonly<{ status: "rejected" }>;
    }>;
