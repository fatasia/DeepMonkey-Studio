import type { ModelRecord, SceneModelState } from "@bim-studio/contracts";

export interface StaleAssetRevision {
  /** 场景实例的稳定 ID。 */
  modelId: string;
  assetModelId: string;
  packageId: string;
  /** 实例保存时所用修订。 */
  sceneRevision: number;
  sceneSourceHash: string;
  /** 素材库当前最新修订。 */
  latestRevision: number;
  latestSourceHash: string;
}

/**
 * 对比场景实例保存时的资产包修订快照与素材库当前 manifest：
 * 同 packageId 且素材已有更高修订时报告陈旧——只诊断，不阻塞加载（旧修订内容仍在存储中）。
 */
export function detectStaleAssetRevisions(
  sceneModels: readonly SceneModelState[],
  projectModels: readonly ModelRecord[],
): StaleAssetRevision[] {
  const latestByPackage = new Map<string, { revision: number; sourceHash: string }>();
  for (const model of projectModels) {
    const reference = model.manifest?.deepAssetPackage;
    if (!reference) continue;
    const current = latestByPackage.get(reference.packageId);
    if (current === undefined || reference.revision > current.revision) {
      latestByPackage.set(reference.packageId, { revision: reference.revision, sourceHash: reference.sourceHash });
    }
  }
  const stale: StaleAssetRevision[] = [];
  for (const state of sceneModels) {
    const snapshot = state.assetRevision;
    if (!snapshot) continue;
    const latest = latestByPackage.get(snapshot.packageId);
    if (latest !== undefined && latest.revision > snapshot.revision) {
      stale.push({
        modelId: state.modelId,
        assetModelId: state.assetModelId ?? state.modelId,
        packageId: snapshot.packageId,
        sceneRevision: snapshot.revision,
        sceneSourceHash: snapshot.sourceHash,
        latestRevision: latest.revision,
        latestSourceHash: latest.sourceHash,
      });
    }
  }
  return stale;
}
