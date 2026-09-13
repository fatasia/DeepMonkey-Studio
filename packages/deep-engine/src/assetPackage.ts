import type { AssetCompatibilityProfile, AssetImporterKind, AssetSourceKind } from "./assetCompatibility.js";

export const DEEP_ASSET_PACKAGE_SCHEMA_VERSION = 1 as const;
export const DEEP_ASSET_PACKAGE_BUDGETS = Object.freeze({
  maxBlobs: 65_536,
  maxResources: 65_536,
  maxDependenciesPerResource: 4_096,
  maxJsonDepth: 32,
  maxJsonNodes: 500_000,
  maxStringLength: 8_192,
  maxIssues: 256,
});

export type DeepAssetResourceKind =
  | "scene" | "mesh" | "material" | "texture" | "animation" | "skin" | "morph"
  | "metadata" | "pmi" | "behavior" | "audio" | "other";

export interface DeepAssetBlobDescriptor {
  /** The storage adapter must recompute this digest from the blob bytes before committing them. */
  readonly hash: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export interface DeepAssetResource {
  readonly id: string;
  readonly kind: DeepAssetResourceKind;
  readonly logicalPath: string;
  readonly blobHash: string;
  readonly dependencies: readonly string[];
}

export interface DeepAssetSourceProvenance {
  readonly kind: AssetSourceKind;
  readonly logicalName: string;
  readonly contentHash: string;
  readonly byteLength: number;
}

export interface DeepAssetImporterProvenance {
  readonly kind: AssetImporterKind;
  readonly id: string;
  readonly version: string;
  readonly recipeHash: string;
  readonly deterministic: true;
}

export interface DeepAssetManifest {
  readonly schemaVersion: 1;
  readonly packageId: string;
  readonly source: DeepAssetSourceProvenance;
  readonly importer: DeepAssetImporterProvenance;
  readonly compatibility: AssetCompatibilityProfile;
  readonly resources: readonly DeepAssetResource[];
  readonly entryScene: string;
}

export interface DeepAssetPackage {
  readonly schemaVersion: 1;
  readonly manifest: DeepAssetManifest;
  readonly blobs: readonly DeepAssetBlobDescriptor[];
}

export type DeepAssetPackageIssueCode =
  | "invalid-type" | "invalid-value" | "unknown-field" | "budget-exceeded"
  | "non-deterministic" | "duplicate-id" | "duplicate-path" | "duplicate-hash-conflict"
  | "missing-blob" | "missing-dependency" | "dependency-cycle" | "invalid-entry-scene"
  | "compatibility-mismatch";

export interface DeepAssetPackageIssue {
  readonly code: DeepAssetPackageIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface DeepAssetPackageValidation {
  readonly valid: boolean;
  readonly issues: readonly DeepAssetPackageIssue[];
  readonly resourceOrder: readonly string[];
  readonly value?: DeepAssetPackage;
}

export interface DeepAssetActiveRevision {
  readonly packageId: string;
  readonly sourceHash: string;
  readonly recipeHash: string;
}

export interface DeepAssetStoreSnapshot {
  readonly revision: number;
  readonly active: DeepAssetActiveRevision | null;
  readonly blobHashes: readonly string[];
}

export interface DeepAssetImportCommit {
  /** Persistence must compare-and-swap this revision; this pure plan never mutates the store. */
  readonly expectedRevision: number;
  readonly nextRevision: number;
  readonly nextActive: DeepAssetActiveRevision;
  readonly entryScene: string;
  readonly resourceOrder: readonly string[];
  readonly addBlobHashes: readonly string[];
  readonly reuseBlobHashes: readonly string[];
}

export interface DeepAssetImportPlan {
  readonly status: "ready" | "rejected";
  readonly issues: readonly DeepAssetPackageIssue[];
  readonly commit: DeepAssetImportCommit | null;
}
