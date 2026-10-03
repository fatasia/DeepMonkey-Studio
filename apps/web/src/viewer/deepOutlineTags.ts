import type * as THREE from "three";
import { INSTANCE_OUTLINE_USER_DATA_KEY } from "@bim-studio/deep-engine";

interface TagState { objects: Set<THREE.Object3D>; revision: number }
const states = new WeakMap<object, TagState>();

export interface DeepOutlineSnapshot {
  /** 每次标记集合变化递增;0 表示宿主从未下发过描边集合(对包内编译值不持意见)。 */
  readonly revision: number;
  readonly objects: ReadonlySet<THREE.Object3D>;
}

/**
 * 把"需要描边"的作者对象同步为 userData 标记,Deep 投影桥据此给其网格实例打 outline 位
 * (活投影路径);独立 packet 路径经 `deepOutlineSnapshot` 读取同一集合并走 updateInstances。
 * three 路径的 OutlinePass 仍由 selectedObjects 驱动,标记对其无影响。
 * 以 owner 为键保存上次集合,只触碰差异对象。返回集合是否变化,调用方据此请求重绘。
 */
export function syncDeepOutlineTags(owner: object, objects: readonly THREE.Object3D[]): boolean {
  const state = states.get(owner) ?? { objects: new Set<THREE.Object3D>(), revision: 0 };
  const next = new Set(objects);
  let changed = false;
  for (const object of state.objects) {
    if (next.has(object)) continue;
    delete object.userData[INSTANCE_OUTLINE_USER_DATA_KEY];
    changed = true;
  }
  for (const object of next) {
    if (object.userData[INSTANCE_OUTLINE_USER_DATA_KEY] === true && state.objects.has(object)) continue;
    object.userData[INSTANCE_OUTLINE_USER_DATA_KEY] = true;
    if (!state.objects.has(object)) changed = true;
  }
  state.objects = next;
  if (changed) state.revision++;
  states.set(owner, state);
  return changed;
}

export function deepOutlineSnapshot(owner: object): DeepOutlineSnapshot {
  const state = states.get(owner);
  return state ?? { revision: 0, objects: new Set() };
}
