import type {
  DeepAssetBlobDescriptor, DeepAssetImportCommit, DeepAssetPackage,
  DeepAssetPackageIssue, DeepAssetStoreSnapshot,
} from "./assetPackage.js";

export const DEEP_ASSET_STORE_MAX_CONCURRENCY = 16 as const;

/** Evidence that the adapter hashed the complete staged bytes with SHA-256. */
export interface DeepAssetBlobVerification {
  readonly authority: "adapter-sha256";
  readonly algorithm: "sha256";
  readonly contentHash: string;
  readonly byteLength: number;
  readonly verified: true;
}

export interface DeepAssetStagedBlob<THandle> {
  readonly descriptor: DeepAssetBlobDescriptor;
  readonly handle: THandle;
  readonly verification: DeepAssetBlobVerification;
}

export interface DeepAssetStoreCommitRequest<THandle> {
  readonly generation: number;
  readonly packageValue: DeepAssetPackage;
  readonly commit: DeepAssetImportCommit;
  readonly stagedBlobs: readonly DeepAssetStagedBlob<THandle>[];
  /** Must be checked inside the same atomic transaction as expectedRevision. */
  readonly isCurrent: () => boolean;
}

export type DeepAssetStoreCommitOutcome = "committed" | "revision-conflict" | "superseded";
export type DeepAssetStageDisposition = "committed" | "rolled-back";

export interface DeepAssetPackageStoreAdapter<THandle> {
  readSnapshot(signal: AbortSignal): Promise<DeepAssetStoreSnapshot>;
  /** A rejected stage operation must clean up any handle it did not return. */
  stageBlob(descriptor: DeepAssetBlobDescriptor, packageValue: DeepAssetPackage,
    signal: AbortSignal): Promise<DeepAssetStagedBlob<THandle>>;
  /**
   * Atomically checks expectedRevision and isCurrent(), publishes every package reference,
   * and returns without yielding. It must never expose staged content on failure.
   */
  commit(request: DeepAssetStoreCommitRequest<THandle>): DeepAssetStoreCommitOutcome;
  /** Releases the temporary handle; committed content remains owned by the store. */
  releaseBlob(staged: DeepAssetStagedBlob<THandle>, disposition: DeepAssetStageDisposition): void | Promise<void>;
}

export interface DeepAssetPackageStoreOptions {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
}

export type DeepAssetPackageStoreStatus =
  | "committed" | "unchanged" | "rejected" | "revision-conflict"
  | "superseded" | "aborted" | "failed";

export interface DeepAssetPackageStoreResult {
  readonly status: DeepAssetPackageStoreStatus;
  readonly generation: number;
  readonly concurrency: number;
  readonly commit: DeepAssetImportCommit | null;
  readonly issues: readonly DeepAssetPackageIssue[];
  readonly stagedBlobs: number;
  readonly reusedBlobs: number;
  readonly committedBlobs: number;
  readonly releasedBlobs: number;
  readonly releaseFailures: readonly string[];
  readonly failure?: string;
}
