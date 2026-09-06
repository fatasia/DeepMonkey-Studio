import type { ModelRecord } from "@bim-studio/contracts";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";

/** 场景行以实例为键；尚未载入的项目素材保留原有载入入口。 */
interface SceneModelRow {
  asset: ModelRecord;
  model: ModelRecord;
  loaded: LoadedSceneModel | undefined;
}
export function sceneModelRows(assets: readonly ModelRecord[], loaded: readonly LoadedSceneModel[]) {
  return assets.flatMap<SceneModelRow>(asset => {
    const instances = loaded.filter(item => item.kind === "model" && (item.assetModelId ?? item.id) === asset.id);
    return instances.length
      ? instances.map(instance => ({ asset, model: { ...asset, id: instance.id, name: instance.name }, loaded: instance }))
      : [{ asset, model: asset, loaded: undefined }];
  });
}
