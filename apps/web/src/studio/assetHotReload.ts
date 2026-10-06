/**
 * 资产热重载编排服务:把"文件变更/手动重载"翻译成引擎 setter 调用。
 *
 * 传播面以既有资产 id 体系为准:LoadedSceneModel.assetModelId(项目素材 id)
 * + engine.listModels() 索引——同一素材的每个运行中实例都得到一次原位重载,
 * 实例引用(transform/材质覆盖/层/动画)由引擎替换事务(fail-closed)保留。
 * 纹理资产不走实例重载:引擎内按 managed 纹理来源 URL 全局刷新,持久化零漂移。
 *
 * 本服务不触 UI:失败/未使用都以结构化报告返回,由调用方(toast)披露。
 */
import type { ModelManifest, ModelRecord } from "@bim-studio/contracts";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";
import { manifestAssetUrls } from "../viewer/assetReloadUrls";

export interface AssetHotReloadEngine {
  listModels(): LoadedSceneModel[];
  reloadModelAsset(instanceId: string, manifest: ModelManifest, canCommit?: () => boolean): Promise<LoadedSceneModel>;
  refreshManagedTextures(url: string, bustToken: string | number): Promise<{ url: string; refreshed: number; failures: readonly string[] }>;
}

export type AssetHotReloadStatus = "updated" | "unused" | "failed";

export interface AssetHotReloadReport {
  readonly kind: "model" | "texture";
  readonly status: AssetHotReloadStatus;
  /** 更新(或尝试更新)的运行中实例/纹理挂载点数量。 */
  readonly updated: number;
  readonly failures: readonly string[];
}

/** 按项目素材 id 收集运行中实例(传播面索引;assetModelId 缺省的旧实例以 id 兜底)。 */
export function loadedInstancesForModel(models: readonly LoadedSceneModel[], modelId: string): LoadedSceneModel[] {
  return models.filter(item => item.kind === "model" && (item.assetModelId ?? item.id) === modelId);
}

/** manifest 引用了该资产 URL 的项目素材(几何/LOD/元数据任一命中)。 */
export function modelsReferencingAssetUrl(records: readonly ModelRecord[], assetUrl: string): ModelRecord[] {
  return records.filter(record => manifestAssetUrls(record.manifest).includes(assetUrl));
}

function report(kind: AssetHotReloadReport["kind"], status: AssetHotReloadStatus, updated: number, failures: readonly string[]): AssetHotReloadReport {
  return { kind, status, updated, failures };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 单个编排会话:同素材的并发重载合并为一次(双击/连续 FS 事件只跑一遍)。 */
export function createAssetHotReloadService(engine: AssetHotReloadEngine, models: readonly ModelRecord[]) {
  const inFlight = new Map<string, Promise<AssetHotReloadReport>>();
  let sequence = 0;
  const nextToken = () => `reload-${Date.now()}-${sequence += 1}`;

  const runExclusive = (key: string, task: () => Promise<AssetHotReloadReport>): Promise<AssetHotReloadReport> => {
    const pending = inFlight.get(key);
    if (pending) return pending;
    const operation = task().finally(() => { if (inFlight.get(key) === operation) inFlight.delete(key); });
    inFlight.set(key, operation);
    return operation;
  };

  /** 手动重载:把某项目素材的全部运行中实例原位重取(引擎侧逐实例 fail-closed)。 */
  const reloadModelAssetInstances = (model: ModelRecord): Promise<AssetHotReloadReport> =>
    runExclusive(`model:${model.id}`, async () => {
      if (!model.manifest || model.status !== "ready") {
        return report("model", "failed", 0, [`素材“${model.name}”尚无可用清单，请等待转换完成`]);
      }
      const instances = loadedInstancesForModel(engine.listModels(), model.id);
      if (instances.length === 0) return report("model", "unused", 0, []);
      const failures: string[] = [];
      let updated = 0;
      for (const instance of instances) {
        try {
          await engine.reloadModelAsset(instance.id, model.manifest);
          updated += 1;
        } catch (error) {
          failures.push(`${instance.id}: ${messageOf(error)}`);
        }
      }
      return report("model", updated > 0 ? "updated" : "failed", updated, failures);
    });

  /** 开发热重载入口:变更 URL → 清单反查模型实例重载,否则按 managed 纹理全局刷新。 */
  const reloadAssetByUrl = (assetUrl: string): Promise<AssetHotReloadReport> =>
    runExclusive(`url:${assetUrl}`, async () => {
      const referencing = modelsReferencingAssetUrl(models, assetUrl);
      if (referencing.length > 0) {
        const failures: string[] = [];
        let updated = 0;
        let touched = false;
        for (const model of referencing) {
          const result = await reloadModelAssetInstances(model);
          if (result.status !== "unused") touched = true;
          updated += result.updated;
          failures.push(...result.failures);
        }
        if (!touched) return report("model", "unused", 0, []);
        return report("model", updated > 0 ? "updated" : "failed", updated, failures);
      }
      const token = nextToken();
      const result = await engine.refreshManagedTextures(assetUrl, token);
      if (result.failures.length > 0) {
        return report("texture", "failed", result.refreshed, [...result.failures]);
      }
      if (result.refreshed === 0) return report("texture", "unused", 0, []);
      return report("texture", "updated", result.refreshed, []);
    });

  return { reloadModelAssetInstances, reloadAssetByUrl };
}

export type AssetHotReloadService = ReturnType<typeof createAssetHotReloadService>;
