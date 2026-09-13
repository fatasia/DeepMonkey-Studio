import type { DeepShaderAsset } from "../shader/types.js";

export type SurfaceAlphaMode = "opaque" | "blend" | "mask";
export type ShaderPresetTextureToggle = boolean | "switchable";

export interface SurfacePassOptions {
  readonly depth?: boolean;
  readonly shadow?: boolean;
  readonly picking?: boolean;
}

export interface SurfaceShaderOptions {
  readonly id?: string;
  readonly label?: string;
  readonly baseColor?: readonly [number, number, number, number];
  readonly baseColorTexture?: ShaderPresetTextureToggle;
  readonly alphaMode?: SurfaceAlphaMode;
  /** Emits opaque and blend variants only when a shared shader asset really needs both. */
  readonly switchableAlpha?: boolean;
  readonly doubleSided?: boolean;
  readonly passes?: SurfacePassOptions;
}

/** Unlit positions are already in clip space; this path does not claim mesh-scene transforms. */
export interface UnlitShaderOptions extends SurfaceShaderOptions {
  readonly normalTexture?: boolean;
  readonly occlusionTexture?: boolean;
}

/** Uses canonical mesh vertex locations and deep.pbr.mesh.v1's forward-frame; material/package layout still needs an adapter. */
export interface StandardSurfaceShaderOptions extends SurfaceShaderOptions {
  readonly metallic?: number;
  readonly roughness?: number;
  readonly metallicRoughnessTexture?: boolean;
  readonly normalTexture?: boolean;
  readonly occlusionTexture?: boolean;
}

export type ShaderPresetIssueCode = "invalid-option" | "unsupported-feature" | "invalid-asset";

export interface ShaderPresetIssue {
  readonly severity: "warning" | "error";
  readonly code: ShaderPresetIssueCode;
  readonly path: string;
  readonly feature?: string;
  readonly message: string;
}

export type ShaderPresetBuildResult =
  | Readonly<{ ok: true; asset: DeepShaderAsset; issues: readonly ShaderPresetIssue[] }>
  | Readonly<{ ok: false; issues: readonly ShaderPresetIssue[] }>;
