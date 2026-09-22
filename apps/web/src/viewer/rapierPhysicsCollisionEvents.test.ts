import { describe, expect, it } from "vitest";
import { resolvePhysicsCollisionDispatches, type PhysicsColliderOwners } from "./rapierPhysicsCollisionEvents";

/** 句柄表：7 = 地面（null）、11/22 = 场景对象、99 = 不可解析残留。 */
const owners: PhysicsColliderOwners = new Map<number, string | null>([
  [7, null],
  [11, "model-a"],
  [22, "model-b"],
]);

describe("resolvePhysicsCollisionDispatches", () => {
  it("场景对象与地面碰撞时只给对象派发，对端为 null", () => {
    expect(resolvePhysicsCollisionDispatches(11, 7, true, owners)).toEqual([
      { modelId: "model-a", other: null, started: true },
    ]);
    expect(resolvePhysicsCollisionDispatches(7, 11, false, owners)).toEqual([
      { modelId: "model-a", other: null, started: false },
    ]);
  });

  it("两个场景对象碰撞时各派发一次且互为对端", () => {
    expect(resolvePhysicsCollisionDispatches(11, 22, true, owners)).toEqual([
      { modelId: "model-a", other: "model-b", started: true },
      { modelId: "model-b", other: "model-a", started: true },
    ]);
  });

  it("双方都不可解析时忽略，不给脚本派发无主事件", () => {
    expect(resolvePhysicsCollisionDispatches(99, 100, true, owners)).toEqual([]);
    expect(resolvePhysicsCollisionDispatches(99, 7, false, owners)).toEqual([]);
  });

  it("对端句柄已失效时保留接收方并回退 other 为 null", () => {
    expect(resolvePhysicsCollisionDispatches(11, 99, true, owners)).toEqual([
      { modelId: "model-a", other: null, started: true },
    ]);
  });

  it("同对句柄的重复事件忠实转发不去重", () => {
    const first = resolvePhysicsCollisionDispatches(11, 22, true, owners);
    const second = resolvePhysicsCollisionDispatches(11, 22, true, owners);
    expect(second).toEqual(first);
    expect(resolvePhysicsCollisionDispatches(11, 22, false, owners)).toEqual([
      { modelId: "model-a", other: "model-b", started: false },
      { modelId: "model-b", other: "model-a", started: false },
    ]);
  });
});
