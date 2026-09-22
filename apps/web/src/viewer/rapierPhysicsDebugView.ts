import type { PhysicsColliderOwners } from "./rapierPhysicsCollisionEvents";

type RapierModule = (typeof import("@dimforge/rapier3d-compat"))["default"];
type RapierWorld = InstanceType<RapierModule["World"]>;

/** B3 缺口 5：调试线框层的单条碰撞体条目（世界位姿 + 局部盒描述）。 */
export interface PhysicsDebugColliderEntry {
  /** 场景对象 id；地面等无主碰撞体为 null。 */
  modelId: string | null;
  translation: { x: number; y: number; z: number };
  rotationQuaternion: { x: number; y: number; z: number; w: number };
  halfExtents: { x: number; y: number; z: number };
  /** 碰撞体相对刚体的局部偏移（创建时写入 ColliderDesc 的 center offset）。 */
  centerOffset: { x: number; y: number; z: number };
}

/**
 * 收集全部已登记 Cuboid 碰撞体的世界包围盒数据，供调试线框层消费。
 * 纯读取、不触碰渲染器；句柄失效/非盒形（理论上当前创建路径只产 Cuboid）
 * 一律跳过。有刚体时 translation/rotation 取刚体世界位姿，无刚体的独立
 * 碰撞体自身 translation() 即世界系，两者语义一致。
 */
export function collectPhysicsCuboidDebugEntries(
  world: RapierWorld,
  rapier: RapierModule,
  owners: PhysicsColliderOwners,
): PhysicsDebugColliderEntry[] {
  const entries: PhysicsDebugColliderEntry[] = [];
  for (const [handle, modelId] of owners) {
    let collider;
    try {
      collider = world.getCollider(handle);
    } catch {
      continue;
    }
    if (!collider) continue;
    const shape = collider.shape;
    if (!(shape instanceof rapier.Cuboid)) continue;
      const parent = collider.parent();
      const translation = parent ? parent.translation() : collider.translation();
      const rotation = parent ? parent.rotation() : collider.rotation();
      // 实测（真机 WASM 测试钉死）：translation() 返回世界位姿（含刚体位姿），
      // 相对刚体的局部偏移必须取 translationWrtParent()；无 parent 时为 null。
      const offset = collider.translationWrtParent() ?? collider.translation();
    entries.push({
      modelId,
      translation: { x: translation.x, y: translation.y, z: translation.z },
      rotationQuaternion: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      halfExtents: { x: shape.halfExtents.x, y: shape.halfExtents.y, z: shape.halfExtents.z },
      centerOffset: { x: offset.x, y: offset.y, z: offset.z },
    });
  }
  return entries;
}
