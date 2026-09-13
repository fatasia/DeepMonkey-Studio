import type { Deep2dColor, Deep2dDisplayList, Deep2dMatrix } from "../deep2dDisplayList.js";
import type { RenderPacket } from "../renderPacketTypes.js";
import type { DeepShaderPackageV2 } from "../shaderPackage/types.js";

export const DEEP_RUNTIME_PACKAGE_SCHEMA = "deep-engine.runtime-package" as const;
export const DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION = 1 as const;
export const DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION = 2 as const;
export const DEEP_RUNTIME_PACKAGE_BUDGETS = Object.freeze({
  inputBytes: 256 * 1024 * 1024, nodes: 2_000_000, depth: 32, resources: 132, shaderPackages: 128,
});
export type RuntimeJson = null | boolean | number | string | readonly RuntimeJson[] | { readonly [key: string]: RuntimeJson };
export interface RuntimeContentHash { readonly algorithm: "sha256"; readonly value: string }
export type RuntimeResourceKind = "render-packet" | "deep2d-runtime" | "ibl-environment" | "shader-package";
export interface RuntimeResourceIndexEntry {
  readonly id: string;
  readonly kind: RuntimeResourceKind;
  readonly revision: number;
  readonly contentHash: RuntimeContentHash;
}
export interface RuntimeEntrypoints {
  readonly renderPacket: string;
  readonly deep2d: string | null;
  readonly environment: string;
  readonly shaderPackages: readonly string[];
}
export interface DeepRuntimePackageV1 {
  readonly schema: typeof DEEP_RUNTIME_PACKAGE_SCHEMA;
  readonly schemaVersion: typeof DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION;
  readonly packageId: string;
  readonly packageVersion: string;
  readonly entrypoints: RuntimeEntrypoints;
  readonly resources: readonly RuntimeResourceIndexEntry[];
  readonly payloads: Readonly<Record<string, RuntimeJson>>;
  readonly packageHash: RuntimeContentHash;
}
export interface RuntimeMaterialShaderBinding {
  readonly materialId: string;
  readonly packageId: string;
  readonly techniqueId: string;
}
/** v2 makes executable material ownership explicit; v1 wire bytes remain unchanged. */
export interface DeepRuntimePackageV2 extends Omit<DeepRuntimePackageV1, "schemaVersion"> {
  readonly schemaVersion: typeof DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION;
  readonly materialBindings: readonly RuntimeMaterialShaderBinding[];
}
export type DeepRuntimePackage = DeepRuntimePackageV1 | DeepRuntimePackageV2;
export interface Deep2dRuntimeAtlas {
  readonly id: string;
  readonly revision: number;
  readonly kind: "glyph" | "image";
  readonly format: "r8unorm" | "rgba8unorm-srgb";
  readonly width: number;
  readonly height: number;
  readonly sampling: "nearest" | "linear";
  readonly dataBase64: string;
}
export interface Deep2dRuntimeQuad {
  readonly id: string;
  readonly zOrder: number;
  readonly transform: Deep2dMatrix;
  readonly atlasId: string;
  readonly source: readonly [number, number, number, number];
  readonly destination: readonly [number, number, number, number];
  readonly color: Deep2dColor;
  readonly opacity?: number;
}
export interface Deep2dRuntimePackage {
  readonly schema: "deep-engine.deep2d-runtime";
  readonly schemaVersion: 1 | 2;
  readonly id: string;
  readonly revision: number;
  readonly composition: "path-then-atlas" | "z-ordered";
  readonly displayList: Deep2dDisplayList;
  readonly atlases: readonly Deep2dRuntimeAtlas[];
  readonly quads: readonly Deep2dRuntimeQuad[];
}
export interface BuildDeepRuntimePackageInput {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly renderPacket: { readonly id: string; readonly revision: number; readonly value: RenderPacket };
  readonly deep2d?: Deep2dRuntimePackage;
  readonly shaderPackages?: readonly { readonly revision: number; readonly value: DeepShaderPackageV2 }[];
  readonly materialBindings?: readonly RuntimeMaterialShaderBinding[];
}
export interface RuntimePackageIssue { readonly path: string; readonly message: string }
export type RuntimePackageValidation =
  | { readonly valid: true; readonly value: DeepRuntimePackage; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly RuntimePackageIssue[] };
