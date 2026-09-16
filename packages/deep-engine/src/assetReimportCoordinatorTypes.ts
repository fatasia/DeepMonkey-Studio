import type { DeepAssetImportCommit, DeepAssetPackage, DeepAssetResource,
  DeepAssetStoreSnapshot } from "./assetPackage.js";
import type { DeepAssetReimportIssue, DeepAssetReimportPlan, DeepAssetUserOverride } from "./assetReimport.js";
import type { DeepAssetStoreCommitOutcome } from "./assetPackageStoreTypes.js";

export type DeepAssetPreparedDisposition = "prepared" | "reused";
export type DeepAssetPreparedReleaseDisposition = "committed" | "rolled-back";

export interface DeepAssetPreparedResource<THandle> {
  readonly resourceId: string;
  readonly disposition: DeepAssetPreparedDisposition;
  readonly handle: THandle;
}

export interface DeepAssetReimportPrepareRequest {
  readonly generation: number;
  readonly packageValue: DeepAssetPackage;
  readonly resource: DeepAssetResource;
  readonly overrides: readonly DeepAssetUserOverride[];
}

export interface DeepAssetReimportApplyRequest<THandle> {
  readonly kind: "publish" | "remove";
  readonly resource: DeepAssetResource;
  readonly prepared?: DeepAssetPreparedResource<THandle>;
  readonly overrides: readonly DeepAssetUserOverride[];
}

export interface DeepAssetReimportBeginRequest<THandle> {
  readonly generation: number;
  readonly packageValue: DeepAssetPackage;
  readonly plan: DeepAssetReimportPlan;
  readonly prepared: readonly DeepAssetPreparedResource<THandle>[];
}

export interface DeepAssetReimportCommitRequest<TTransaction> {
  readonly generation: number;
  readonly transaction: TTransaction;
  readonly packageValue: DeepAssetPackage;
  readonly packageCommit: DeepAssetImportCommit;
  readonly plan: DeepAssetReimportPlan;
  /** Must be checked atomically with packageCommit.expectedRevision. */
  readonly isCurrent: () => boolean;
}

/** Adapter apply operations remain invisible until the synchronous CAS commit succeeds. */
export interface DeepAssetReimportAdapter<THandle, TTransaction> {
  readSnapshot(signal: AbortSignal): Promise<DeepAssetStoreSnapshot>;
  /** A rejected prepare call must clean up any handle it did not return. */
  prepare(request: DeepAssetReimportPrepareRequest, signal: AbortSignal): Promise<DeepAssetPreparedResource<THandle>>;
  /** Starts an isolated package/resource transaction; addBlobHashes must be staged before it resolves. */
  beginApply(request: DeepAssetReimportBeginRequest<THandle>, signal: AbortSignal): Promise<TTransaction>;
  apply(transaction: TTransaction, request: DeepAssetReimportApplyRequest<THandle>, signal: AbortSignal): Promise<void>;
  commit(request: DeepAssetReimportCommitRequest<TTransaction>): DeepAssetStoreCommitOutcome;
  rollback(transaction: TTransaction, rollbackOrder: readonly string[], cause: unknown): void | Promise<void>;
  release(resource: DeepAssetPreparedResource<THandle>, disposition: DeepAssetPreparedReleaseDisposition): void | Promise<void>;
}

export interface DeepAssetReimportCoordinatorOptions {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly overrides?: readonly DeepAssetUserOverride[];
}

export type DeepAssetReimportCoordinatorStatus = "committed" | "unchanged" | "conflicted" | "rejected"
  | "revision-conflict" | "superseded" | "aborted" | "failed";

export interface DeepAssetReimportCoordinatorResult {
  readonly status: DeepAssetReimportCoordinatorStatus;
  readonly generation: number;
  readonly concurrency: number;
  readonly plan: DeepAssetReimportPlan | null;
  readonly issues: readonly DeepAssetReimportIssue[];
  readonly preparedResources: number;
  readonly reusedResources: number;
  readonly appliedOperations: number;
  readonly releasedResources: number;
  readonly rollbackAttempted: boolean;
  readonly rollbackFailure?: string;
  readonly releaseFailures: readonly string[];
  readonly failure?: string;
}
