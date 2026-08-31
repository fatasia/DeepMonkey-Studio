import type { SceneAssetBindingState } from "@bim-studio/contracts";
import type { ConfirmedSmartAssetMapping } from "../components/smartAssetBindingWorkbenchModel";
import type { ComponentRecord } from "../viewer/analysis";

export interface MergeSceneAssetBindingsResult {
  bindings: SceneAssetBindingState[];
  confirmedCount: number;
  skippedCount: number;
}

/**
 * 将人工确认的候选合并为场景资产映射。同一对象或同一设备保持一对一，
 * 找不到场景对象的过期候选会被跳过，避免写入无法追溯的孤儿记录。
 */
export function mergeConfirmedSceneAssetBindings(
  current: readonly SceneAssetBindingState[],
  mappings: readonly ConfirmedSmartAssetMapping[],
  components: readonly ComponentRecord[],
  confirmedAt = new Date().toISOString(),
): MergeSceneAssetBindingsResult {
  const componentById = new Map(components.map((component) => [component.stableId, component]));
  const confirmed: SceneAssetBindingState[] = [];

  for (const mapping of mappings) {
    const component = componentById.get(mapping.sceneObjectId);
    if (!component) continue;
    confirmed.push({
      id: bindingId(component.stableId, mapping.deviceId),
      sceneObjectId: component.stableId,
      objectName: component.name,
      modelId: component.modelId,
      ...(component.id !== component.modelId ? { layerId: component.id } : {}),
      deviceId: mapping.deviceId,
      confidence: mapping.confidence,
      confirmedAt,
    });
  }

  const replacedObjects = new Set(confirmed.map((binding) => binding.sceneObjectId));
  const replacedDevices = new Set(confirmed.map((binding) => binding.deviceId));
  const retained = current.filter(
    (binding) => !replacedObjects.has(binding.sceneObjectId) && !replacedDevices.has(binding.deviceId),
  );
  return {
    bindings: [...retained, ...confirmed],
    confirmedCount: confirmed.length,
    skippedCount: mappings.length - confirmed.length,
  };
}

function bindingId(sceneObjectId: string, deviceId: string): string {
  return `asset-binding:${encodeURIComponent(sceneObjectId)}:${encodeURIComponent(deviceId)}`;
}
