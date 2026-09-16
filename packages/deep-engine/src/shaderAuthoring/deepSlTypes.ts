import type { ShaderCompileCapabilities } from "../shader/index.js";
import type { ShaderAuthoringDiagnostic, ShaderTextRange } from "./types.js";

export interface DeepSlTextureTransform {
  readonly texCoord: 0 | 1;
  readonly offset: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotation: number;
}

export interface DeepSlSurfaceModel {
  readonly shaderId: string;
  readonly surface: "standard" | "unlit";
  readonly baseColor: readonly [number, number, number, number];
  readonly metallic: number;
  readonly roughness: number;
  readonly alpha: "opaque" | "blend" | "mask";
  readonly doubleSided: boolean;
  readonly baseColorTexture: boolean;
  readonly metallicRoughnessTexture: boolean;
  readonly normalTexture: boolean;
  readonly occlusionTexture: boolean;
  readonly emissiveTexture: boolean;
  readonly baseColorTextureTransform: DeepSlTextureTransform;
  readonly metallicRoughnessTextureTransform: DeepSlTextureTransform;
  readonly normalTextureTransform: DeepSlTextureTransform;
  readonly occlusionTextureTransform: DeepSlTextureTransform;
  readonly emissiveTextureTransform: DeepSlTextureTransform;
  readonly normalScale: number;
  readonly occlusionStrength: number;
  readonly emissiveFactor: readonly [number, number, number];
  readonly emissiveStrength: number;
  readonly clearcoatFactor: number;
  readonly clearcoatRoughness: number;
}

export interface DeepSlInspection {
  readonly success: boolean;
  readonly diagnostics: readonly ShaderAuthoringDiagnostic[];
  readonly model?: DeepSlSurfaceModel;
}

export interface DeepSlCompilerOptions {
  readonly capabilities: ShaderCompileCapabilities;
}

export type DeepSlTextureFieldName = "baseColorTexture" | "metallicRoughnessTexture" | "normalTexture"
  | "occlusionTexture" | "emissiveTexture";
export type DeepSlTextureTransformFieldName = `${"baseColor" | "metallicRoughness" | "normal" | "occlusion" | "emissive"}TextureTransform`;
export type DeepSlFieldName = "shader" | "surface" | "baseColor" | "metallic" | "roughness" | "alpha" | "doubleSided"
  | DeepSlTextureFieldName | DeepSlTextureTransformFieldName | "normalScale" | "occlusionStrength" | "emissiveFactor" | "emissiveStrength"
  | "clearcoatFactor" | "clearcoatRoughness";

export interface DeepSlParsedLine {
  readonly line: number;
  readonly firstColumn: number;
  readonly text: string;
}

export interface DeepSlMutableModel {
  shaderId: string; surface: "standard" | "unlit";
  baseColor: [number, number, number, number]; metallic: number; roughness: number;
  alpha: "opaque" | "blend" | "mask"; doubleSided: boolean;
  baseColorTexture: boolean; metallicRoughnessTexture: boolean; normalTexture: boolean;
  occlusionTexture: boolean; emissiveTexture: boolean;
  baseColorTextureTransform: DeepSlTextureTransform; metallicRoughnessTextureTransform: DeepSlTextureTransform;
  normalTextureTransform: DeepSlTextureTransform; occlusionTextureTransform: DeepSlTextureTransform;
  emissiveTextureTransform: DeepSlTextureTransform; normalScale: number; occlusionStrength: number;
  emissiveFactor: [number, number, number]; emissiveStrength: number;
  clearcoatFactor: number; clearcoatRoughness: number;
}

export interface DeepSlParseState {
  readonly model: DeepSlMutableModel;
  readonly diagnostics: ShaderAuthoringDiagnostic[];
  readonly fields: Map<DeepSlFieldName, ShaderTextRange>;
  opened: boolean;
  closed: boolean;
}

export interface DeepSlParsedDocument {
  readonly inspection: DeepSlInspection;
  readonly fields: ReadonlyMap<string, ShaderTextRange>;
}
