import type { PhysicsColliderOwners } from "./rapierPhysicsCollisionEvents";

type RapierModule = (typeof import("@dimforge/rapier3d-compat"))["default"];
type RapierWorld = InstanceType<RapierModule["World"]>;
type RapierShape = InstanceType<RapierModule["Shape"]>;

/**
 * T0 刀 3 物理调试可视化：单条碰撞体条目（世界位姿 + 形状描述）。
 * 形状判别联合覆盖 Rapier 常用四类：盒/球/凸包/三角网格；
 * 其余形状（heightfield 等）当前编辑器创建路径不产，收集时跳过并计数。
 */

/** 盒：halfExtents 为世界系半边长（编辑器创建路径已乘对象缩放）。 */
export interface PhysicsDebugCuboidShape {
  readonly kind: "cuboid";
  readonly halfExtents: { x: number; y: number; z: number };
}

/** 球：radius 为世界系半径。 */
export interface PhysicsDebugBallShape {
  readonly kind: "ball";
  readonly radius: number;
}

/** 凸包/三角网格：顶点在碰撞体局部系（米）；索引缺失时渲染退化为包围盒线框。 */
export interface PhysicsDebugMeshShape {
  readonly kind: "convex" | "trimesh";
  readonly vertices: Float32Array;
  readonly indices: Uint32Array | null;
}

export type PhysicsDebugColliderShape = PhysicsDebugCuboidShape | PhysicsDebugBallShape | PhysicsDebugMeshShape;

export interface PhysicsDebugColliderEntry {
  /** Rapier 碰撞体句柄；渲染层按它缓存派生几何、宿主按它过滤接触对。 */
  handle: number;
  /** 场景对象 id；地面等无主碰撞体为 null。 */
  modelId: string | null;
  translation: { x: number; y: number; z: number };
  rotationQuaternion: { x: number; y: number; z: number; w: number };
  shape: PhysicsDebugColliderShape;
  /** 碰撞体相对刚体的局部偏移（创建时写入 ColliderDesc 的 center offset）。 */
  centerOffset: { x: number; y: number; z: number };
}

/** 收集统计：可见条目数 + 按形状分布 + 不支持形状跳过数（面板空态/诊断消费）。 */
export interface PhysicsDebugCollectionStats {
  readonly total: number;
  readonly skippedUnsupported: number;
}

/**
 * 收集全部已登记碰撞体的世界位姿与形状数据，供调试线框层消费。
 * 纯读取、不触碰渲染器；句柄失效一律跳过。有刚体时 translation/rotation 取
 * 刚体世界位姿，无刚体的独立碰撞体自身 translation() 即世界系。
 *
 * 实测（真机 WASM 测试钉死）：collider.translation() 返回世界位姿（含刚体位姿），
 * 相对刚体的局部偏移必须取 translationWrtParent()；无 parent 时为 null。
 */
export function collectPhysicsDebugEntries(
  world: RapierWorld,
  rapier: RapierModule,
  owners: PhysicsColliderOwners,
  stats?: { skippedUnsupported: number },
): PhysicsDebugColliderEntry[] {
  const entries: PhysicsDebugColliderEntry[] = [];
  if (stats) stats.skippedUnsupported = 0;
  for (const [handle, modelId] of owners) {
    let collider;
    try {
      collider = world.getCollider(handle);
    } catch {
      continue;
    }
    if (!collider) continue;
    const shape = describeShape(collider.shape, rapier);
    if (!shape) {
      if (stats) stats.skippedUnsupported += 1;
      continue;
    }
    const parent = collider.parent();
    const translation = parent ? parent.translation() : collider.translation();
    const rotation = parent ? parent.rotation() : collider.rotation();
    const offset = collider.translationWrtParent() ?? collider.translation();
    entries.push({
      handle,
      modelId,
      translation: { x: translation.x, y: translation.y, z: translation.z },
      rotationQuaternion: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      shape,
      centerOffset: { x: offset.x, y: offset.y, z: offset.z },
    });
  }
  return entries;
}

/** Rapier shape → 调试形状描述；四类之外返回 null（跳过并计数，不静默丢失条目）。 */
function describeShape(shape: RapierShape, rapier: RapierModule): PhysicsDebugColliderShape | null {
  if (shape instanceof rapier.Cuboid) {
    return {
      kind: "cuboid",
      halfExtents: { x: shape.halfExtents.x, y: shape.halfExtents.y, z: shape.halfExtents.z },
    };
  }
  if (shape instanceof rapier.Ball) return { kind: "ball", radius: shape.radius };
  if (shape instanceof rapier.ConvexPolyhedron) {
    return { kind: "convex", vertices: shape.vertices, indices: shape.indices ?? null };
  }
  if (shape instanceof rapier.TriMesh) {
    return { kind: "trimesh", vertices: shape.vertices, indices: shape.indices };
  }
  return null;
}

/**
 * 兼容导出：既有消费方（旧测试/文档）仍按 Cuboid 语义调用此名。
 * 等价于 collectPhysicsDebugEntries，名字保留历史意图。
 */
export function collectPhysicsCuboidDebugEntries(
  world: RapierWorld,
  rapier: RapierModule,
  owners: PhysicsColliderOwners,
): PhysicsDebugColliderEntry[] {
  return collectPhysicsDebugEntries(world, rapier, owners);
}
