import * as THREE from "three";
import type { PhysicsDebugColliderEntry } from "./rapierPhysicsDebugView";

/**
 * B3 缺口 5 消费端：物理碰撞体调试线框层的渲染物。
 * 每个碰撞体一个 LineSegments（共享单位盒棱线几何），宿主每帧用
 * collectPhysicsDebugColliders() 的条目同步位姿与数量。
 * 本模块不触碰渲染器，可在 headless 环境直接单测。
 */

/** 线框材质种类：按刚体类型/地面区分颜色，调试时一眼分辨碰撞体归属。 */
export type PhysicsDebugMaterialKind = "dynamic" | "fixed" | "kinematic" | "ground";

/** 条目 → 材质种类的解析器；由宿主按 physicsBodyStates 提供刚体类型。 */
export type PhysicsDebugMaterialKindOf = (entry: PhysicsDebugColliderEntry) => PhysicsDebugMaterialKind;

export interface PhysicsDebugOverlay {
  /** 场景根挂载物；`helper:` 前缀使其不进入导出与业务遍历（同 simulation-paths 约定）。 */
  readonly object: THREE.Group;
  /** 开关：关闭时整组 visible=false，渲染器零提交。 */
  setVisible(visible: boolean): void;
  /** 用最新碰撞体条目刷新线框：位姿=平移+旋转后的局部偏移，尺寸=2×半边长。 */
  sync(entries: readonly PhysicsDebugColliderEntry[], kindOf: PhysicsDebugMaterialKindOf): void;
  /** 释放全部 GPU 资源并从父级摘除；仅引擎销毁时调用。 */
  dispose(): void;
}

const MATERIAL_COLORS: Record<PhysicsDebugMaterialKind, number> = {
  dynamic: 0xff7043, // 橙红：动态刚体（物理播放中会运动）
  fixed: 0x4dd0e1, // 青：静态刚体
  kinematic: 0xba68c8, // 紫：运动学刚体（角色控制器载体）
  ground: 0x78909c, // 蓝灰：无主碰撞体（默认地面）
};

export function createPhysicsDebugOverlay(): PhysicsDebugOverlay {
  const object = new THREE.Group();
  object.name = "helper:physics-collider-debug";
  object.visible = false;
  // 单位盒（±0.5）棱线几何由全部线框共享；实际尺寸经 scale = 2×halfExtents 表达。
  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const materials = new Map<PhysicsDebugMaterialKind, THREE.LineBasicMaterial>(
    (Object.entries(MATERIAL_COLORS) as Array<[PhysicsDebugMaterialKind, number]>).map(([kind, color]) => [
      kind,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }),
    ]),
  );
  const pool: THREE.LineSegments[] = [];
  // 位姿换算的复用临时量，避免每帧分配。
  const quaternion = new THREE.Quaternion();
  const offset = new THREE.Vector3();

  function acquire(index: number, kind: PhysicsDebugMaterialKind): THREE.LineSegments {
    let line = pool[index];
    if (!line) {
      line = new THREE.LineSegments(edges, materials.get(kind)!);
      line.name = `helper:physics-collider:${index}`;
      // 与导航碰撞调试同档：无深度测试叠加在场景之上，保证被遮挡碰撞体仍可见。
      line.renderOrder = 10_000;
      line.raycast = () => {}; // 调试线框不参与拾取
      object.add(line);
      pool[index] = line;
    }
    line.material = materials.get(kind)!;
    line.visible = true;
    return line;
  }

  return {
    object,
    setVisible(visible) {
      object.visible = visible;
    },
    sync(entries, kindOf) {
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]!;
        const line = acquire(index, kindOf(entry));
        // 世界中心 = 刚体世界位姿 + 旋转后的局部偏移；碰撞体创建路径无自转，朝向即刚体旋转。
        quaternion.set(
          entry.rotationQuaternion.x,
          entry.rotationQuaternion.y,
          entry.rotationQuaternion.z,
          entry.rotationQuaternion.w,
        );
        offset.set(entry.centerOffset.x, entry.centerOffset.y, entry.centerOffset.z).applyQuaternion(quaternion);
        line.position.set(entry.translation.x + offset.x, entry.translation.y + offset.y, entry.translation.z + offset.z);
        line.quaternion.copy(quaternion);
        line.scale.set(entry.halfExtents.x * 2, entry.halfExtents.y * 2, entry.halfExtents.z * 2);
      }
      // 数量收缩：多余线框只隐藏不销毁，池按历史峰值复用（碰撞体增删是高频操作）。
      for (let index = entries.length; index < pool.length; index += 1) pool[index]!.visible = false;
    },
    dispose() {
      for (const line of pool.splice(0)) object.remove(line);
      edges.dispose();
      for (const material of materials.values()) material.dispose();
      materials.clear();
      object.removeFromParent();
    },
  };
}
