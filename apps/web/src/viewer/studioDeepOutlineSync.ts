import type * as THREE from "three";
import type { DeepOutlineSnapshot } from "./deepOutlineTags";

/** 独立 packet 后端:只需要"按作者模型集合翻转描边位"这一个能力。 */
export interface OutlineSyncTarget {
  setOutlinedModels(modelIds: ReadonlySet<string>): "updated" | "unchanged" | "unsupported";
}

export interface OutlineSyncHost {
  listModels(): readonly { readonly id: string; readonly object: THREE.Object3D }[];
  getDeepOutlinedObjects?(): DeepOutlineSnapshot;
}

/**
 * 独立 RenderPacket 路径下的描边实时同步:作者侧(勾选"轮廓"/选中对象变化)的描边对象集合
 * 经 `getDeepOutlinedObjects` 读出 → 解析为所属作者模型 ID → 后端仅翻转实例 outline 位
 * (updateInstances,不重传几何、不重建 packet)。无变化(修订号相同)时每帧只做一次整数比较。
 * 选中的是模型内部子节点时,独立包以模型为描边粒度。
 */
export class StudioDeepOutlineSync {
  private revision = 0;
  private disabled = false;

  /** 返回是否有 GPU 实例表被更新(调用方据此清除静置指纹,保证下一帧绘制)。 */
  apply(target: OutlineSyncTarget, host: OutlineSyncHost): boolean {
    if (this.disabled) return false;
    const snapshot = host.getDeepOutlinedObjects?.();
    // 修订 0 = 宿主从未下发描边集合,包内编译值即权威,不覆盖。
    if (!snapshot || snapshot.revision === 0 || snapshot.revision === this.revision) return false;
    const roots = new Map<THREE.Object3D, string>(host.listModels().map(model => [model.object, model.id]));
    const ids = new Set<string>();
    for (const object of snapshot.objects) {
      for (let current: THREE.Object3D | null = object; current; current = current.parent) {
        const id = roots.get(current);
        if (id !== undefined) { ids.add(id); break; }
      }
    }
    const result = target.setOutlinedModels(ids);
    if (result === "unsupported") { this.disabled = true; return false; }
    this.revision = snapshot.revision;
    return result === "updated";
  }
}
