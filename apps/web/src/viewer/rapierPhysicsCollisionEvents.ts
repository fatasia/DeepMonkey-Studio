/**
 * B3-c 物理可观测性：碰撞事件解析纯逻辑。
 *
 * Rapier 的 `drainCollisionEvents` 只给 (colliderHandle, colliderHandle, started)
 * 原始句柄；这里负责把句柄解析回场景对象 id 并生成按对象派发的事件列表。
 * 保持纯函数是为了能脱离 Rapier WASM 单测（真实派发在 viewerEngineSimulation 接线）。
 */

/**
 * 碰撞体句柄 → 归属。`string` = 场景对象 id；`null` = 内置静态地面（只作对端，
 * 自己不接收事件）；缺失（undefined）= 不可解析的碰撞体（如刚被移除的 body 残留事件）。
 */
export type PhysicsColliderOwners = Map<number, string | null>;

export interface PhysicsCollisionDispatch {
  /** 接收本次碰撞事件的对象 id；与交互脚本 target.modelId 对齐。 */
  modelId: string;
  /** 对端场景对象 id；对端是地面或句柄已失效时为 null，不伪造对端身份。 */
  other: string | null;
  /** true = 碰撞开始（collisionStart），false = 碰撞结束（collisionEnd）。 */
  started: boolean;
}

/**
 * 把一对原始碰撞事件解析为按场景对象派发的条目。
 * - 地面只作对端来源，永远不作为事件接收方（脚本无法订阅地面）。
 * - 双方都不可解析（匿名碰撞体之间的接触）→ 忽略，避免派发无主事件。
 * - 单侧是场景对象 → 只给该侧派发一次；双侧都是场景对象 → 各派发一次、互为 other。
 * - 同一对句柄的重复事件（接触断开又建立）忠实转发，不去重——去重属于脚本作者语义。
 */
export function resolvePhysicsCollisionDispatches(
  handle1: number,
  handle2: number,
  started: boolean,
  owners: PhysicsColliderOwners,
): PhysicsCollisionDispatch[] {
  const owner1 = owners.get(handle1);
  const owner2 = owners.get(handle2);
  if (owner1 === undefined && owner2 === undefined) return [];
  const dispatches: PhysicsCollisionDispatch[] = [];
  if (typeof owner1 === "string") {
    dispatches.push({ modelId: owner1, other: owner2 ?? null, started });
  }
  if (typeof owner2 === "string") {
    dispatches.push({ modelId: owner2, other: owner1 ?? null, started });
  }
  return dispatches;
}
