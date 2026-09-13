import type { Object3D } from "three";
import type { OptimizerLayer } from "./optimizerLayers";

/** 只改变节点状态，几何、材质和相机不因连续编辑重新创建。 */
export function syncOptimizerLayerPreview(model: Object3D, layers: readonly OptimizerLayer[]): void {
  const byId = new Map(layers.map(layer => [layer.stableId ?? `layer-${layer.id}`, layer]));
  model.traverse(object => {
    const id = object.userData.studioOptimizerLayer?.id;
    const layer = typeof id === "string" ? byId.get(id) : undefined;
    if (!layer) return;
    object.name = layer.name;
    object.visible = !layer.hidden && !layer.deleted;
  });
}
