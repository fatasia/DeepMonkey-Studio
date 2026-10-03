import type * as THREE from "three";
import type { DeepOutlineSnapshot } from "./deepOutlineTags";

/** 独立 packet 后端:只需要"按作者模型集合翻转描边位"这一个能力(流送包异步生效)。 */
export interface OutlineSyncTarget {
  setOutlinedModels(modelIds: ReadonlySet<string>): Promise<"updated" | "unchanged" | "unsupported">;
}

export interface OutlineSyncHost {
  listModels(): readonly { readonly id: string; readonly object: THREE.Object3D }[];
  getDeepOutlinedObjects?(): DeepOutlineSnapshot;
}

const MAX_FAILURES = 2;

/**
 * 独立 RenderPacket 路径下的描边实时同步:作者侧(勾选"轮廓"/选中对象变化)的描边对象集合
 * 经 `getDeepOutlinedObjects` 读出 → 解析为所属作者模型 ID → 后端仅翻转实例 outline 位
 * (不重传几何、不重建 packet)。无变化(修订号相同)时每帧只做一次整数比较。
 * 选中的是模型内部子节点时,独立包以模型为描边粒度。
 */
export class StudioDeepOutlineSync {
  private revision = 0;
  private disabled = false;
  private failures = 0;

  /**
   * 修订变化时派发一次更新并返回 true(调用方据此清除静置指纹,使本帧即绘制;非流送包的实例位在本调用内同步写入)。
   * 异步生效(流送包)完成后调用 onApplied 触发补绘。
   */
  apply(target: OutlineSyncTarget, host: OutlineSyncHost, onApplied?: () => void): boolean {
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
    const previous = this.revision;
    this.revision = snapshot.revision;
    target.setOutlinedModels(ids).then(result => {
      if (result === "unsupported") this.disabled = true;
      else if (result === "updated") { this.failures = 0; onApplied?.(); }
    }, (reason: unknown) => {
      // 单次失败允许重试(下一帧重新派发),连续失败即停用,不拖垮渲染循环。
      if (++this.failures >= MAX_FAILURES) this.disabled = true; else if (this.revision === snapshot.revision) this.revision = previous;
      console.warn("[deep-outline] instance outline update failed", reason);
    });
    return true;
  }
}
