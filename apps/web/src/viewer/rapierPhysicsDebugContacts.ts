import * as THREE from "three";
import type { PhysicsColliderOwners } from "./rapierPhysicsCollisionEvents";

type RapierWorld = InstanceType<(typeof import("@dimforge/rapier3d-compat"))["default"]["World"]>;

/**
 * T0 刀 3 物理调试可视化：接触点高亮图层。
 * 数据用 Rapier 即时接触查询（world.contactPairsWith + world.contactPair）——
 * 纯 narrow-phase 读、零事件依赖、物理暂停时也能读到最后一步的接触状态。
 * 渲染为橙色点（接触点）+ 橙色短法线段，材质 depthTest=false 叠加在场景上。
 */

/** 接触点收集上限：防超大场景接触爆炸拖垮每帧同步（超出部分丢弃并计数）。 */
export const MAX_CONTACT_POINTS = 512;
/** 每对碰撞体最多采样的求解接触点数。 */
const MAX_POINTS_PER_PAIR = 8;
/** 法线指示线长度（米）。 */
const NORMAL_LENGTH = 0.09;

/** 接触点颜色（任务语义：接触=橙）；与面板图例同值。 */
export const PHYSICS_DEBUG_CONTACT_COLOR = 0xff9800;

export interface PhysicsContactDebugLayer {
  readonly object: THREE.Group;
  setVisible(visible: boolean): void;
  /** 用世界系接触点数组（xyz 连续）刷新；法线数组同序（每点一根短线）。 */
  sync(points: readonly number[] | Float32Array, normals: readonly number[] | Float32Array | undefined): void;
  dispose(): void;
}

export function createPhysicsContactDebugLayer(): PhysicsContactDebugLayer {
  const object = new THREE.Group();
  object.name = "helper:physics-contact-debug";
  object.visible = false;
  const material = new THREE.PointsMaterial({
    color: PHYSICS_DEBUG_CONTACT_COLOR, size: 6, sizeAttenuation: false, transparent: true, opacity: 0.95,
    depthTest: false, depthWrite: false,
  });
  const normalMaterial = new THREE.LineBasicMaterial({
    color: PHYSICS_DEBUG_CONTACT_COLOR, transparent: true, opacity: 0.6, depthTest: false, depthWrite: false,
  });
  const pointGeometry = new THREE.BufferGeometry();
  const normalGeometry = new THREE.BufferGeometry();
  const pointAttribute = new THREE.BufferAttribute(new Float32Array(MAX_CONTACT_POINTS * 3), 3);
  const normalAttribute = new THREE.BufferAttribute(new Float32Array(MAX_CONTACT_POINTS * 2 * 3), 3);
  pointAttribute.setUsage(THREE.DynamicDrawUsage);
  normalAttribute.setUsage(THREE.DynamicDrawUsage);
  pointGeometry.setAttribute("position", pointAttribute);
  normalGeometry.setAttribute("position", normalAttribute);
  const pointsObject = new THREE.Points(pointGeometry, material);
  pointsObject.name = "helper:physics-contact-debug:points";
  pointsObject.renderOrder = 10_002;
  pointsObject.raycast = () => {};
  pointsObject.frustumCulled = false;
  const normalLines = new THREE.LineSegments(normalGeometry, normalMaterial);
  normalLines.name = "helper:physics-contact-debug:normals";
  normalLines.renderOrder = 10_002;
  normalLines.raycast = () => {};
  normalLines.frustumCulled = false;
  object.add(pointsObject);
  object.add(normalLines);

  return {
    object,
    setVisible(visible) {
      object.visible = visible;
    },
    sync(points, normals) {
      const count = Math.min(points.length / 3, MAX_CONTACT_POINTS);
      const pointArray = pointAttribute.array as Float32Array;
      for (let index = 0; index < count * 3; index += 1) pointArray[index] = points[index]!;
      pointGeometry.setDrawRange(0, count);
      pointAttribute.needsUpdate = true;
      pointGeometry.computeBoundingSphere();
      const normalCount = normals ? Math.min(normals.length / 6, count) : 0;
      const normalArray = normalAttribute.array as Float32Array;
      if (normals) {
        for (let index = 0; index < normalCount * 6; index += 1) normalArray[index] = normals[index]!;
      }
      normalGeometry.setDrawRange(0, normalCount * 2);
      normalAttribute.needsUpdate = true;
      normalGeometry.computeBoundingSphere();
    },
    dispose() {
      pointGeometry.dispose();
      normalGeometry.dispose();
      material.dispose();
      normalMaterial.dispose();
      object.removeFromParent();
    },
  };
}

export interface PhysicsContactCollection {
  /** 世界系接触点（xyz 连续）。 */
  readonly points: number[];
  /** 世界系法线段端点（每接触点 2 个顶点、xyz 连续）。 */
  readonly normals: number[];
  /** 实际采样的接触点数（不含超限丢弃）。 */
  readonly sampled: number;
  /** 超上限丢弃的接触点数（诊断用）。 */
  readonly dropped: number;
}

/**
 * 收集当前物理世界的全部接触点（世界系）与法线。
 * 纯即时查询：对每个已登记碰撞体枚举其接触对，配对按句柄排序去重，
 * 物理暂停时读到最后一次求解的接触状态（narrow-phase 常驻）。
 * @param visibleOwners 参与筛选的归属集合；null=默认地面（作为接触上下文恒可见）。
 *   传入 undefined 表示不过滤（全部碰撞体）。
 */
export function collectPhysicsContactPoints(
  world: RapierWorld,
  owners: PhysicsColliderOwners,
  visibleOwners?: ReadonlySet<string | null>,
): PhysicsContactCollection {
  const points: number[] = [];
  const normals: number[] = [];
  let sampled = 0;
  let dropped = 0;
  const visitedPairs = new Set<string>();
  for (const [handle] of owners) {
    let collider;
    try {
      collider = world.getCollider(handle);
    } catch {
      continue;
    }
    if (!collider) continue;
    world.contactPairsWith(collider, (other) => {
      const otherHandle = other.handle;
      const pairKey = handle < otherHandle ? `${handle}:${otherHandle}` : `${otherHandle}:${handle}`;
      if (visitedPairs.has(pairKey)) return;
      visitedPairs.add(pairKey);
      // 筛选：两端至少一端在可见集合（地面 null 恒为上下文，不作为筛选目标判定）。
      if (visibleOwners) {
        const ownerA = owners.get(handle) ?? null;
        const ownerB = owners.get(otherHandle) ?? null;
        const aVisible = ownerA !== null && visibleOwners.has(ownerA);
        const bVisible = ownerB !== null && visibleOwners.has(ownerB);
        if (!aVisible && !bVisible) return;
      }
      try {
        world.contactPair(collider, other, (manifold) => {
          const normal = manifold.normal();
          const count = Math.min(manifold.numSolverContacts(), MAX_POINTS_PER_PAIR);
          for (let index = 0; index < count; index += 1) {
            if (sampled >= MAX_CONTACT_POINTS) {
              dropped += count - index;
              return;
            }
            const point = manifold.solverContactPoint(index);
            points.push(point.x, point.y, point.z);
            normals.push(point.x, point.y, point.z, point.x + normal.x * NORMAL_LENGTH, point.y + normal.y * NORMAL_LENGTH, point.z + normal.z * NORMAL_LENGTH);
            sampled += 1;
          }
        });
      } catch {
        // 句柄在遍历中途失效（同帧删体）：跳过该对，不打断其余收集。
      }
    });
  }
  return { points, normals, sampled, dropped };
}
