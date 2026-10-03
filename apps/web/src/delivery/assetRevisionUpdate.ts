import type { ModelRecord, SceneModelState, SceneSnapshot } from "@bim-studio/contracts";
import {
  DeepAssetReimportCoordinator,
  type DeepAssetPackage,
  type DeepAssetPreparedReleaseDisposition,
  type DeepAssetPreparedResource,
  type DeepAssetReimportAdapter,
  type DeepAssetReimportApplyRequest,
  type DeepAssetReimportBeginRequest,
  type DeepAssetReimportCommitRequest,
  type DeepAssetReimportCoordinatorResult,
  type DeepAssetReimportPrepareRequest,
  type DeepAssetStoreCommitOutcome,
  type DeepAssetStoreSnapshot,
} from "@bim-studio/deep-engine";
import type { StaleAssetRevision } from "../viewer/assetRevisionSnapshot";
import { request } from "../api";
import { createDeepAssetApi } from "../apiClients/deepAssetApi";

export interface AssetRevisionUpdate {
  readonly scenes: readonly SceneSnapshot[];
  readonly changedSceneIds: readonly string[];
  readonly updatedInstances: number;
}

interface DeepPackageDocument {
  readonly package: DeepAssetPackage;
}

type JsonLoader = (url: string, signal?: AbortSignal) => Promise<unknown>;

const deepAssetApi = createDeepAssetApi(request);
const defaultJsonLoader: JsonLoader = (url, signal) => deepAssetApi.loadDeepAssetPackage(url, signal);

export async function runAssetRevisionReimport(
  stale: StaleAssetRevision,
  model: ModelRecord,
  options: { loadJson?: JsonLoader; signal?: AbortSignal } = {},
): Promise<DeepAssetReimportCoordinatorResult> {
  const reference = model.manifest?.deepAssetPackage;
  if (!reference?.packageUrl) throw new Error(`模型“${model.name}”缺少资产包引用，请重新转换后再更新`);
  if (reference.packageId !== stale.packageId) throw new Error("资产包身份已变化，请刷新资源列表后重试");
  const latest = await loadPackage(reference.packageUrl, options.loadJson ?? defaultJsonLoader, options.signal);
  if (latest.manifest.packageId !== stale.packageId) throw new Error("资产包 manifest 与项目记录不一致，请重新转换该模型");
  const previous = withSceneRevision(latest, stale.sceneSourceHash);
  const adapter = new SceneRevisionReimportAdapter({
    revision: stale.sceneRevision,
    active: {
      packageId: stale.packageId,
      sourceHash: stale.sceneSourceHash,
      recipeHash: previous.manifest.importer.recipeHash,
    },
    blobHashes: latest.blobs.map(blob => blob.hash),
  });
  const coordinator = new DeepAssetReimportCoordinator(adapter);
  try {
    const result = await coordinator.publish(previous, latest, { concurrency: 4, ...(options.signal ? { signal: options.signal } : {}) });
    if (result.status !== "committed" && result.status !== "unchanged") {
      const detail = result.failure ?? result.issues[0]?.message ?? result.status;
      throw new Error(`资产修订更新未完成：${detail}`);
    }
    return result;
  } finally {
    coordinator.dispose();
  }
}

export function applyAssetRevisionToScenes(
  scenes: readonly SceneSnapshot[],
  model: ModelRecord,
  staleReports: readonly StaleAssetRevision[],
): AssetRevisionUpdate {
  const reference = model.manifest?.deepAssetPackage;
  if (!reference) throw new Error(`模型“${model.name}”缺少资产包引用，请重新转换后再更新`);
  const staleModelIds = new Set(staleReports.map(report => report.modelId));
  const changedSceneIds: string[] = [];
  let updatedInstances = 0;
  const nextScenes = scenes.map(scene => {
    let changed = false;
    const models = scene.models.map(item => {
      if (!shouldUpdateRevision(item, model.id, reference.packageId, reference.revision, staleModelIds)) return item;
      changed = true;
      updatedInstances += 1;
      return {
        ...item,
        assetRevision: {
          packageId: reference.packageId,
          revision: reference.revision,
          sourceHash: reference.sourceHash,
        },
      };
    });
    if (!changed) return scene;
    changedSceneIds.push(scene.id);
    return { ...scene, models, updatedAt: new Date().toISOString() };
  });
  return { scenes: nextScenes, changedSceneIds, updatedInstances };
}

async function loadPackage(url: string, loadJson: JsonLoader, signal?: AbortSignal): Promise<DeepAssetPackage> {
  const value = await loadJson(url, signal);
  if (!isDeepPackageDocument(value)) throw new Error("资产包 manifest 格式无效，请重新转换该模型");
  return value.package;
}

function isDeepPackageDocument(value: unknown): value is DeepPackageDocument {
  return Boolean(value && typeof value === "object" && "package" in value);
}

function withSceneRevision(value: DeepAssetPackage, sourceHash: string): DeepAssetPackage {
  return {
    ...structuredClone(value),
    manifest: {
      ...structuredClone(value.manifest),
      source: { ...value.manifest.source, contentHash: sourceHash },
    },
  };
}

function shouldUpdateRevision(
  model: SceneModelState,
  assetModelId: string,
  packageId: string,
  latestRevision: number,
  staleModelIds: ReadonlySet<string>,
): boolean {
  const snapshot = model.assetRevision;
  if (!snapshot || snapshot.packageId !== packageId || snapshot.revision >= latestRevision) return false;
  return staleModelIds.has(model.modelId) || (model.assetModelId ?? model.modelId) === assetModelId;
}

class SceneRevisionReimportAdapter implements DeepAssetReimportAdapter<string, { readonly generation: number }> {
  constructor(private snapshot: DeepAssetStoreSnapshot) {}

  async readSnapshot(): Promise<DeepAssetStoreSnapshot> {
    return this.snapshot;
  }

  async prepare(request: DeepAssetReimportPrepareRequest): Promise<DeepAssetPreparedResource<string>> {
    return { resourceId: request.resource.id, disposition: "reused", handle: request.resource.blobHash };
  }

  async beginApply(request: DeepAssetReimportBeginRequest<string>): Promise<{ readonly generation: number }> {
    return { generation: request.generation };
  }

  async apply(
    _transaction: { readonly generation: number },
    _request: DeepAssetReimportApplyRequest<string>,
  ): Promise<void> {}

  commit(request: DeepAssetReimportCommitRequest<{ readonly generation: number }>): DeepAssetStoreCommitOutcome {
    if (!request.isCurrent()) return "superseded";
    if (request.packageCommit.expectedRevision !== this.snapshot.revision) return "revision-conflict";
    this.snapshot = {
      revision: request.packageCommit.nextRevision,
      active: request.packageCommit.nextActive,
      blobHashes: [...new Set([...this.snapshot.blobHashes, ...request.packageCommit.addBlobHashes])],
    };
    return "committed";
  }

  async rollback(): Promise<void> {}

  async release(
    _resource: DeepAssetPreparedResource<string>,
    _disposition: DeepAssetPreparedReleaseDisposition,
  ): Promise<void> {}
}
