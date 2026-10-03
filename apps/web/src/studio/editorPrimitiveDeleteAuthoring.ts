import type { SceneSnapshot } from "@bim-studio/contracts";
import type { SceneEditTransaction } from "../hooks/useSceneHistoryState";

/** Adapts the existing controller/history/restore consumers; owns no author state. */
export interface EditorPrimitiveDeleteAuthoring {
  begin(label: string): SceneEditTransaction;
  remove(objectId: string): void;
  restore(snapshot: SceneSnapshot): Promise<void>;
}

export function primitiveDeletionReferenceError(snapshot: SceneSnapshot, objectId: string): string | undefined {
  if (snapshot.selectionSets?.some(set => set.objectIds.includes(objectId))) return "选择集/编组引用尚未接入删除，请先移除该引用。";
  if (snapshot.rootLayerOrder?.some(ref => ref.kind === "object" && ref.id === objectId)) return "目录顺序引用尚未接入删除，请先移除该引用。";
  if (snapshot.assetBindings?.some(binding => binding.sceneObjectId === objectId)) return "设备资产引用尚未接入删除，请先移除该引用。";
  if (snapshot.animation?.models.some(frame => frame.modelId === objectId) || snapshot.animation?.stateMachine?.states.some(state => state.modelId === objectId)) return "动画作者引用尚未接入删除，请先移除该引用。";
  if (snapshot.simulationEntities?.some(entity => {
    if ("targetModelId" in entity) return entity.targetModelId === objectId;
    if (entity.kind === "flowLink") return entity.fromModelId === objectId || entity.toModelId === objectId;
    return entity.a.modelId === objectId || entity.b.modelId === objectId;
  })) return "仿真实体引用尚未接入删除，请先移除该引用。";
  return undefined;
}
