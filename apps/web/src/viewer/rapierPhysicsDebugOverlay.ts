import * as THREE from "three";
import type { PhysicsDebugColliderEntry } from "./rapierPhysicsDebugView";

/**
 * T0 刀 3 物理调试可视化：碰撞体调试线框层的渲染物。
 * 支持四类形状：盒（共享单位盒棱线+缩放）/球（共享二十面体笼+缩放）/
 * 凸包与三角网格（按碰撞体句柄缓存派生棱线几何，顶点在碰撞体局部系）。
 * 每个碰撞体一个 LineSegments，宿主每帧用 collectPhysicsDebugEntries()
 * 的条目同步位姿与数量。本模块不触碰渲染器，可在 headless 环境直接单测。
 */

/** 线框材质种类：按刚体类型区分，另设选中高亮（白色聚焦）。 */
export type PhysicsDebugMaterialKind = "dynamic" | "fixed" | "kinematic" | "ground" | "selected";

/** 条目 → 材质种类的解析器；由宿主按 physicsBodyStates 提供刚体类型。 */
export type PhysicsDebugMaterialKindOf = (entry: PhysicsDebugColliderEntry) => PhysicsDebugMaterialKind;

/**
 * 调试语义色（数据可视化约定，非品牌强调色；UI 图例用同值保持两面对齐）：
 * 动态=绿 / 运动学=青 / 静态=灰 / 默认地面=蓝灰 / 选中聚焦=白。
 * 接触点=橙与约束=黄在各自图层模块（contacts/joints）内定义。
 */
export const PHYSICS_DEBUG_COLORS: Record<PhysicsDebugMaterialKind, number> = {
  dynamic: 0x43a047,
  fixed: 0x8d8d8d,
  kinematic: 0x26c6da,
  ground: 0x546e7a,
  selected: 0xffffff,
};

/** 三棱线图层对齐的图例 hex（面板 CSS 同值），供未来非 DOM 消费复用。 */
export const PHYSICS_DEBUG_COLOR_HEX: Record<PhysicsDebugMaterialKind, string> = {
  dynamic: "#43a047",
  fixed: "#8d8d8d",
  kinematic: "#26c6da",
  ground: "#546e7a",
  selected: "#ffffff",
};

export interface PhysicsDebugOverlay {
  /** 场景根挂载物；`helper:` 前缀使其不进入导出与业务遍历（同 simulation-paths 约定）。 */
  readonly object: THREE.Group;
  /** 开关：关闭时整组 visible=false，渲染器零提交。 */
  setVisible(visible: boolean): void;
  /** 用最新碰撞体条目刷新线框：位姿=平移+旋转后的局部偏移，尺寸按形状表达。 */
  sync(entries: readonly PhysicsDebugColliderEntry[], kindOf: PhysicsDebugMaterialKindOf): void;
  /** 释放全部 GPU 资源并从父级摘除；仅引擎销毁时调用。 */
  dispose(): void;
}

/** 球线框的共享笼：半径 0.5 的二十面体（detail 1），scale=radius×2 表达实际半径。 */
const BALL_CAGE_RADIUS = 0.5;
/** 网格类棱线派生的三角形数上限：超过退化为包围盒线框（防巨型 trimesh 卡帧）。 */
const MAX_MESH_EDGE_TRIANGLES = 20_000;

export function createPhysicsDebugOverlay(): PhysicsDebugOverlay {
  const object = new THREE.Group();
  object.name = "helper:physics-collider-debug";
  object.visible = false;
  // 共享几何：单位盒（±0.5）与单位球笼；实际尺寸经 scale 表达。
  const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const ballEdges = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(BALL_CAGE_RADIUS, 1));
  const materials = new Map<PhysicsDebugMaterialKind, THREE.LineBasicMaterial>(
    (Object.entries(PHYSICS_DEBUG_COLORS) as Array<[PhysicsDebugMaterialKind, number]>).map(([kind, color]) => [
      kind,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
    ]),
  );
  const pool: THREE.LineSegments[] = [];
  // 网格类形状的派生棱线缓存：碰撞体句柄 → 几何。句柄离开最新同步即释放（增删是低频操作）。
  const meshGeometryCache = new Map<number, THREE.EdgesGeometry | THREE.BufferGeometry>();
  // 位姿换算的复用临时量，避免每帧分配。
  const quaternion = new THREE.Quaternion();
  const offset = new THREE.Vector3();

  function meshGeometryFor(entry: PhysicsDebugColliderEntry): THREE.BufferGeometry {
    const cached = meshGeometryCache.get(entry.handle);
    if (cached) return cached;
    const shape = entry.shape;
    if (shape.kind !== "convex" && shape.kind !== "trimesh") return boxEdges;
    let geometry: THREE.BufferGeometry;
    const triangleCount = shape.indices ? shape.indices.length / 3 : 0;
    if (!shape.indices || triangleCount === 0 || triangleCount > MAX_MESH_EDGE_TRIANGLES) {
      // 无索引（自动凸包未展开）或超大网格：包围盒线框兜底，位置正确、形状近似可见。
      const bounds = boundsOf(shape.vertices);
      geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(bounds.x, bounds.y, bounds.z));
      geometry.translate(bounds.cx, bounds.cy, bounds.cz);
    } else {
      const indexed = new THREE.BufferGeometry();
      indexed.setAttribute("position", new THREE.BufferAttribute(shape.vertices, 3));
      indexed.setIndex(new THREE.BufferAttribute(shape.indices, 1));
      geometry = new THREE.EdgesGeometry(indexed, 1);
      indexed.dispose();
    }
    meshGeometryCache.set(entry.handle, geometry);
    return geometry;
  }

  function acquire(index: number, kind: PhysicsDebugMaterialKind, entry: PhysicsDebugColliderEntry): THREE.LineSegments {
    let line = pool[index];
    if (!line) {
      line = new THREE.LineSegments(boxEdges, materials.get(kind)!);
      line.name = `helper:physics-collider:${index}`;
      // 与导航碰撞调试同档：无深度测试叠加在场景之上，保证被遮挡碰撞体仍可见。
      line.renderOrder = 10_000;
      line.raycast = () => {}; // 调试线框不参与拾取
      object.add(line);
      pool[index] = line;
    }
    line.material = materials.get(kind)!;
    line.geometry = entry.shape.kind === "cuboid" ? boxEdges
      : entry.shape.kind === "ball" ? ballEdges
        : meshGeometryFor(entry);
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
        const line = acquire(index, kindOf(entry), entry);
        // 世界中心 = 刚体世界位姿 + 旋转后的局部偏移；朝向即刚体旋转。
        quaternion.set(
          entry.rotationQuaternion.x,
          entry.rotationQuaternion.y,
          entry.rotationQuaternion.z,
          entry.rotationQuaternion.w,
        );
        offset.set(entry.centerOffset.x, entry.centerOffset.y, entry.centerOffset.z).applyQuaternion(quaternion);
        line.position.set(entry.translation.x + offset.x, entry.translation.y + offset.y, entry.translation.z + offset.z);
        line.quaternion.copy(quaternion);
        const shape = entry.shape;
        if (shape.kind === "cuboid") line.scale.set(shape.halfExtents.x * 2, shape.halfExtents.y * 2, shape.halfExtents.z * 2);
        else if (shape.kind === "ball") line.scale.setScalar(shape.radius / BALL_CAGE_RADIUS);
        else line.scale.set(1, 1, 1); // 网格类顶点已含实际尺寸（碰撞体局部系，米）
      }
      // 数量收缩：多余线框只隐藏不销毁，池按历史峰值复用（碰撞体增删是高频操作）。
      for (let index = entries.length; index < pool.length; index += 1) pool[index]!.visible = false;
      // 几何缓存对账：本轮未出现的句柄（碰撞体被移除）释放派生几何，防悬挂泄漏。
      if (meshGeometryCache.size > 0) {
        const liveHandles = new Set(entries.map((entry) => entry.handle));
        for (const [handle, geometry] of meshGeometryCache) {
          if (!liveHandles.has(handle)) {
            geometry.dispose();
            meshGeometryCache.delete(handle);
          }
        }
      }
    },
    dispose() {
      for (const line of pool.splice(0)) object.remove(line);
      boxEdges.dispose();
      ballEdges.dispose();
      for (const geometry of meshGeometryCache.values()) geometry.dispose();
      meshGeometryCache.clear();
      for (const material of materials.values()) material.dispose();
      materials.clear();
      object.removeFromParent();
    },
  };
}

/** 顶点集的包围盒尺寸与中心（兜底包围盒线框用）。 */
function boundsOf(vertices: Float32Array): { x: number; y: number; z: number; cx: number; cy: number; cz: number } {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < vertices.length; index += 3) {
    minX = Math.min(minX, vertices[index]!); maxX = Math.max(maxX, vertices[index]!);
    minY = Math.min(minY, vertices[index + 1]!); maxY = Math.max(maxY, vertices[index + 1]!);
    minZ = Math.min(minZ, vertices[index + 2]!); maxZ = Math.max(maxZ, vertices[index + 2]!);
  }
  if (!Number.isFinite(minX)) return { x: 0.01, y: 0.01, z: 0.01, cx: 0, cy: 0, cz: 0 };
  return {
    x: Math.max(maxX - minX, 0.01), y: Math.max(maxY - minY, 0.01), z: Math.max(maxZ - minZ, 0.01),
    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, cz: (minZ + maxZ) / 2,
  };
}
