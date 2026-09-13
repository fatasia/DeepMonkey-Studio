import type {
  DeepPbrMeshShaderAbi, DeepPbrMeshShaderAbiId, ShaderAbiAlphaMode, ShaderAbiAttachmentProfileId,
  ShaderAbiPassVariant, ShaderAbiRasterMode,
} from "../shaderAbi/types.js";
import type { DeepWgslModuleDescriptor, ShaderSourceMapEntry } from "../shader/types.js";
import type {
  DEEP_SHADER_PACKAGE_SCHEMA, DEEP_SHADER_PACKAGE_SCHEMA_VERSION,
  DEEP_SHADER_TARGET_PROFILE,
} from "./constants.js";

export interface ShaderPackageHash {
  readonly algorithm: "sha256";
  readonly value: string;
}

export interface ShaderPackageDependency {
  readonly id: string;
  readonly contentHash: ShaderPackageHash;
}

export interface ShaderPackageModule {
  readonly id: string;
  readonly language: "wgsl";
  readonly source: string;
  readonly sourceHash: ShaderPackageHash;
  readonly dependencyIds: readonly string[];
}

export interface ShaderPackageAbiReference {
  readonly id: DeepPbrMeshShaderAbiId;
  readonly contentHash: ShaderPackageHash;
  readonly contract: DeepPbrMeshShaderAbi;
}

export interface ShaderPackagePipelineSelection {
  readonly passVariantId: ShaderAbiPassVariant["id"];
  readonly attachmentProfileId: ShaderAbiAttachmentProfileId;
  readonly alphaMode: ShaderAbiAlphaMode["mode"];
  readonly rasterMode: ShaderAbiRasterMode["id"];
}

export interface ShaderPackageEntryPoints {
  readonly vertex: string;
  readonly fragment: string | null;
}

export interface ShaderPackagePass {
  readonly id: string;
  readonly techniqueId: string;
  readonly passId: string;
  readonly kind: ShaderAbiPassVariant["pass"];
  readonly moduleId: string;
  readonly cacheKey: string;
  readonly entryPoints: ShaderPackageEntryPoints;
  readonly sourceMap: readonly ShaderSourceMapEntry[];
  readonly pipeline: ShaderPackagePipelineSelection;
}

export interface DeepShaderPackageV2 {
  readonly schema: typeof DEEP_SHADER_PACKAGE_SCHEMA;
  readonly schemaVersion: typeof DEEP_SHADER_PACKAGE_SCHEMA_VERSION;
  readonly packageId: string;
  readonly packageVersion: string;
  readonly compilerVersion: string;
  readonly targetProfile: typeof DEEP_SHADER_TARGET_PROFILE;
  readonly shaderAbi: ShaderPackageAbiReference;
  readonly dependencies: readonly ShaderPackageDependency[];
  readonly modules: readonly ShaderPackageModule[];
  readonly passes: readonly ShaderPackagePass[];
  readonly packageCacheKey: string;
}

export type ShaderPackageIssueCode =
  | "invalid-type" | "invalid-value" | "unknown-field" | "budget-exceeded"
  | "non-canonical" | "duplicate-id" | "duplicate-cache-key"
  | "missing-reference" | "hash-mismatch" | "cache-key-mismatch";

export interface ShaderPackageDiagnostic {
  readonly code: ShaderPackageIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface ShaderPackageValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly ShaderPackageDiagnostic[];
  readonly value?: DeepShaderPackageV2;
}

export interface ShaderPackagePassBuildInput {
  readonly techniqueId: string;
  readonly passId: string;
  readonly kind: ShaderAbiPassVariant["pass"];
  readonly module: DeepWgslModuleDescriptor;
  readonly entryPoints: ShaderPackageEntryPoints;
  readonly sourceMap?: readonly ShaderSourceMapEntry[];
  readonly dependencyIds?: readonly string[];
  readonly pipeline: ShaderPackagePipelineSelection;
}

export interface DeepShaderPackageBuildInput {
  readonly targetAbi?: DeepPbrMeshShaderAbiId;
  readonly packageId: string;
  readonly packageVersion: string;
  readonly compilerVersion: string;
  readonly targetProfile?: typeof DEEP_SHADER_TARGET_PROFILE;
  readonly dependencies?: readonly ShaderPackageDependency[];
  readonly passes: readonly ShaderPackagePassBuildInput[];
}

export interface ShaderPackageBuildResult {
  readonly success: boolean;
  readonly diagnostics: readonly ShaderPackageDiagnostic[];
  readonly value?: DeepShaderPackageV2;
}

export interface ResolvedShaderPackagePipeline {
  readonly passVariant: ShaderAbiPassVariant;
  readonly attachmentProfile: DeepPbrMeshShaderAbi["attachmentProfiles"][number];
  readonly alphaMode: ShaderAbiAlphaMode;
  readonly rasterMode: ShaderAbiRasterMode;
  readonly bindGroupLayouts: DeepPbrMeshShaderAbi["bindGroupLayouts"];
  readonly vertexStreams: DeepPbrMeshShaderAbi["vertexStreams"];
  readonly dataLayouts: DeepPbrMeshShaderAbi["dataLayouts"];
}
