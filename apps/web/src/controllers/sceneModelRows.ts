import type { ModelRecord } from "@bim-studio/contracts";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";

/** 场景目录只展示当前场景实例；项目库存统一留在“资源”浮窗。 */
interface SceneModelRow {
  rowKey: string;
  asset: ModelRecord;
  model: ModelRecord;
  loaded: LoadedSceneModel | undefined;
}
export function sceneModelRows(assets: readonly ModelRecord[], loaded: readonly LoadedSceneModel[]) {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return loaded.flatMap<SceneModelRow>((instance) => {
    if (instance.kind !== "model") return [];
    const asset = byId.get(instance.assetModelId ?? instance.id);
    if (!asset) return [];
    return [{ rowKey: `instance:${instance.id}`, asset, model: { ...asset, id: instance.id, name: instance.name }, loaded: instance }];
  });
}
