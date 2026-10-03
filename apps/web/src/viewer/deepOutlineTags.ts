import type * as THREE from "three";
import { INSTANCE_OUTLINE_USER_DATA_KEY } from "@bim-studio/deep-engine";

const tagged = new WeakMap<object, Set<THREE.Object3D>>();

/**
 * 把"需要描边"的作者对象同步为 userData 标记,Deep 投影桥据此给其网格实例打 outline 位
 * (选中高亮与模型描边同一条路径;three 路径的 OutlinePass 仍由 selectedObjects 驱动,标记对其无影响)。
 * 以 owner 为键保存上次标记集合,只触碰差异对象。返回标记集合是否变化,调用方据此请求重绘。
 */
export function syncDeepOutlineTags(owner: object, objects: readonly THREE.Object3D[]): boolean {
  const next = new Set(objects), previous = tagged.get(owner);
  let changed = false;
  if (previous) for (const object of previous) {
    if (next.has(object)) continue;
    delete object.userData[INSTANCE_OUTLINE_USER_DATA_KEY];
    changed = true;
  }
  for (const object of next) {
    if (object.userData[INSTANCE_OUTLINE_USER_DATA_KEY] === true) continue;
    object.userData[INSTANCE_OUTLINE_USER_DATA_KEY] = true;
    changed = true;
  }
  if (next.size) tagged.set(owner, next); else tagged.delete(owner);
  return changed;
}
