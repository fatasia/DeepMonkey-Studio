export const DEEP_SHADER_SCHEMA_VERSION = 1 as const;

export type ShaderValueType =
  | "f32" | "i32" | "u32" | "bool"
  | "vec2f" | "vec3f" | "vec4f" | "color"
  | "mat3x3f" | "mat4x4f";
export type ShaderScope = "frame" | "material" | "object" | "pass";
export type ShaderStage = "vertex" | "fragment";
export type ShaderPassKind = "forward" | "depth" | "shadow" | "picking";

export interface ShaderProperty {
  readonly name: string;
  readonly type: ShaderValueType;
  readonly scope: ShaderScope;
  readonly default: number | boolean | readonly number[];
}

export type ShaderResourceKind =
  | "texture-2d-f32" | "texture-depth-2d"
  | "sampler" | "comparison-sampler"
  | "storage-buffer-read";

export interface ShaderResourceBinding {
  readonly name: string;
  readonly scope: ShaderScope;
  /** Binding zero is reserved for the generated property uniform of each scope. */
  readonly binding: number;
  readonly kind: ShaderResourceKind;
  readonly visibility: readonly ShaderStage[];
}

export type ShaderVertexFormat =
  | "float32" | "float32x2" | "float32x3" | "float32x4" | "uint32";

export interface ShaderVertexAttribute {
  readonly name: string;
  readonly semantic: string;
  readonly location: number;
  readonly format: ShaderVertexFormat;
  readonly type: ShaderValueType;
}

export type ShaderInterpolation = "perspective" | "linear" | "flat";
export interface ShaderVarying {
  readonly name: string;
  readonly location: number;
  readonly type: ShaderValueType;
  readonly interpolation?: ShaderInterpolation;
}

export type ShaderCapability =
  | "depth-clip-control" | "float32-filterable" | "indirect-first-instance"
  | "shader-f16" | "texture-compression-bc" | "texture-compression-etc2"
  | "texture-compression-astc";

export interface ShaderTargetRequirements {
  readonly webgpu: true;
  readonly features?: readonly ShaderCapability[];
  readonly minLimits?: Readonly<{
    maxBindGroups?: number;
    maxBindingsPerBindGroup?: number;
    maxInterStageShaderVariables?: number;
  }>;
}

export interface ShaderKeyword {
  readonly name: string;
  readonly values: readonly string[];
  readonly default: string;
}

export type ShaderFeaturePredicate =
  | Readonly<{ op: "keyword"; name: string; equals: string }>
  | Readonly<{ op: "capability"; name: ShaderCapability }>
  | Readonly<{ op: "all" | "any"; terms: readonly ShaderFeaturePredicate[] }>
  | Readonly<{ op: "not"; term: ShaderFeaturePredicate }>;

export type ShaderBlendFactor =
  | "zero" | "one" | "src" | "one-minus-src"
  | "src-alpha" | "one-minus-src-alpha" | "dst" | "one-minus-dst"
  | "dst-alpha" | "one-minus-dst-alpha";
export type ShaderBlendOperation = "add" | "subtract" | "reverse-subtract" | "min" | "max";
export interface ShaderBlendComponent {
  readonly srcFactor: ShaderBlendFactor;
  readonly dstFactor: ShaderBlendFactor;
  readonly operation: ShaderBlendOperation;
}
export interface ShaderBlendState {
  readonly color: ShaderBlendComponent;
  readonly alpha: ShaderBlendComponent;
}
export interface ShaderRenderState {
  readonly topology: "triangle-list" | "triangle-strip" | "line-list" | "line-strip" | "point-list";
  readonly cullMode: "none" | "front" | "back";
  readonly frontFace: "ccw" | "cw";
  readonly depthCompare: "never" | "less" | "equal" | "less-equal" | "greater" | "not-equal" | "greater-equal" | "always";
  readonly depthWrite: boolean;
  readonly colorWriteMask: number;
  readonly blend?: ShaderBlendState;
}

interface ShaderNodeBase { readonly id: string; readonly type: ShaderValueType }
export type ShaderNode =
  | (ShaderNodeBase & Readonly<{ op: "literal"; value: number | boolean | readonly number[] }>)
  | (ShaderNodeBase & Readonly<{ op: "property"; name: string }>)
  | (ShaderNodeBase & Readonly<{ op: "attribute"; name: string }>)
  | (ShaderNodeBase & Readonly<{ op: "varying"; name: string }>)
  | (ShaderNodeBase & Readonly<{ op: "pbr-frame-view" }>)
  | (ShaderNodeBase & Readonly<{
      op: "add" | "subtract" | "multiply" | "divide" | "min" | "max" | "pow" | "dot" | "cross" | "scale"
        | "transform-direction" | "transform-position";
      inputs: readonly [string, string];
    }>)
  | (ShaderNodeBase & Readonly<{ op: "select" | "clamp" | "mix"; inputs: readonly [string, string, string] }>)
  | (ShaderNodeBase & Readonly<{ op: "normalize" | "negate" | "saturate"; inputs: readonly [string] }>)
  | (ShaderNodeBase & Readonly<{ op: "compose-vec4"; inputs: readonly [string, string] }>)
  | (ShaderNodeBase & Readonly<{ op: "swizzle"; inputs: readonly [string]; mask: string }>)
  | (ShaderNodeBase & Readonly<{
      op: "texture-sample";
      texture: string;
      sampler: string;
      inputs: readonly [string];
    }>);

export type ShaderLightingContextId = "deep-lighting-v1";
export interface ShaderStandardSurfaceFields {
  readonly baseColor: string;
  readonly normal: string;
  readonly metallic: string;
  readonly roughness: string;
  readonly occlusion: string;
  readonly emission: string;
  readonly alpha: string;
}
export type ShaderStageOutput =
  | Readonly<{ semantic: "position"; node: string }>
  | Readonly<{ semantic: "color"; node: string }>
  | Readonly<{ semantic: "varying"; node: string; name: string }>
  | Readonly<{
      semantic: "surface";
      model: "standard-pbr";
      context: ShaderLightingContextId;
      fields: ShaderStandardSurfaceFields;
    }>;
export interface ShaderStageGraph {
  readonly nodes: readonly ShaderNode[];
  readonly outputs: readonly ShaderStageOutput[];
}

export interface ShaderPass {
  readonly id: string;
  readonly kind: ShaderPassKind;
  readonly predicate?: ShaderFeaturePredicate;
  readonly requirements?: ShaderTargetRequirements;
  readonly state: ShaderRenderState;
  readonly vertex: ShaderStageGraph;
  readonly fragment?: ShaderStageGraph;
}
export interface ShaderTechnique {
  readonly id: string;
  readonly predicate?: ShaderFeaturePredicate;
  readonly requirements: ShaderTargetRequirements;
  readonly passes: readonly ShaderPass[];
}
export interface DeepShaderAsset {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly label?: string;
  readonly properties: readonly ShaderProperty[];
  readonly resources: readonly ShaderResourceBinding[];
  readonly attributes: readonly ShaderVertexAttribute[];
  readonly varyings: readonly ShaderVarying[];
  readonly keywords: readonly ShaderKeyword[];
  readonly techniques: readonly ShaderTechnique[];
}

export type ShaderIssueCode =
  | "invalid-type" | "invalid-value" | "unknown-field" | "budget-exceeded"
  | "duplicate-symbol" | "duplicate-binding" | "missing-symbol" | "type-mismatch"
  | "invalid-stage" | "invalid-state" | "graph-cycle" | "non-deterministic"
  | "variant-budget" | "unsupported-capability" | "unsupported-surface-lighting";
export interface ShaderDiagnostic {
  readonly severity: "error";
  readonly code: ShaderIssueCode;
  readonly path: string;
  readonly message: string;
}
export interface ShaderValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly ShaderDiagnostic[];
  readonly value?: DeepShaderAsset;
}

export interface ShaderCompileCapabilities {
  readonly features: readonly ShaderCapability[];
  readonly limits: Readonly<{
    maxBindGroups: number;
    maxBindingsPerBindGroup: number;
    maxInterStageShaderVariables: number;
  }>;
}
export interface ShaderVariant {
  readonly key: string;
  readonly keywords: Readonly<Record<string, string>>;
  readonly techniqueIds: readonly string[];
  readonly passIds: readonly string[];
}
export interface ShaderVariantPlan {
  readonly valid: boolean;
  readonly diagnostics: readonly ShaderDiagnostic[];
  readonly variants: readonly ShaderVariant[];
}

export interface ShaderPropertyLayoutEntry {
  readonly name: string;
  readonly type: ShaderValueType;
  readonly group: number;
  readonly binding: 0;
  readonly offset: number;
  readonly byteSize: number;
}
export interface ShaderSourceMapEntry {
  readonly stage: ShaderStage;
  readonly nodeId: string;
  readonly generatedLine: number;
}
export interface DeepWgslModuleDescriptor { readonly label: string; readonly code: string }
export interface ShaderCompilerBindingLayoutEntry {
  readonly name: string;
  readonly group: number;
  readonly binding: number;
  readonly visibility: readonly ShaderStage[];
  readonly resource: "uniform-buffer" | "texture-depth-2d" | "comparison-sampler"
    | "texture-cube-f32" | "texture-2d-f32" | "sampler";
  readonly dataLayout?: "frame";
  readonly minBindingSize?: number;
}
export interface ShaderCompilerDataLayoutMember {
  readonly name: string;
  readonly type: "mat4x4f" | "vec4f";
  readonly byteOffset: number;
  readonly byteSize: number;
  readonly components?: readonly string[];
}
export interface ShaderCompilerDataLayout {
  readonly id: "frame";
  readonly byteSize: number;
  readonly byteAlignment: 16;
  readonly members: readonly ShaderCompilerDataLayoutMember[];
}
export interface ShaderLightingContextLayoutV1 {
  readonly id: "deep-lighting-v1";
  readonly abiVersion: 1;
  readonly frameAbi: "deep.pbr.mesh.v1/forward-frame";
  readonly packageCompatibility: "requires-layout-adapter";
  readonly directLightCapacity: 1;
  readonly worldPositionVarying: "worldPosition";
  readonly dataLayouts: readonly ShaderCompilerDataLayout[];
  readonly bindings: readonly ShaderCompilerBindingLayoutEntry[];
}
export interface CompiledShaderPass {
  readonly techniqueId: string;
  readonly passId: string;
  readonly kind: ShaderPassKind;
  readonly cacheKey: string;
  readonly module: DeepWgslModuleDescriptor;
  readonly entryPoints: Readonly<{ vertex: "deepVertex"; fragment?: "deepFragment" }>;
  readonly propertyLayout: readonly ShaderPropertyLayoutEntry[];
  readonly lightingContext?: ShaderLightingContextLayoutV1;
  readonly sourceMap: readonly ShaderSourceMapEntry[];
  readonly renderState: ShaderRenderState;
}
export interface ShaderCompileResult {
  readonly success: boolean;
  readonly diagnostics: readonly ShaderDiagnostic[];
  readonly value?: CompiledShaderPass;
}
