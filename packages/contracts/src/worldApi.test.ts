import { describe, expect, it } from "vitest";
import {
  WORLD_LIMITS,
  WorldApiContractError,
  validateWorldAction,
  validateWorldEventData,
  validateWorldObserveRequest,
  validateWorldResetRequest,
  validateWorldSnapshot,
  validateWorldStepRequest,
  worldTicksFromDt,
} from "./index.js";

const scene = { schemaVersion: 1, id: "scene-1", primitives: [], models: [] };
const hex = "a".repeat(64);

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    snapshotVersion: "1", seed: 7, tick: 12, sceneId: "scene-1", sceneHash: hex, traceHash: hex, rngState: 5,
    gravity: [0, -9.81, 0], ground: true, objects: [], groundHandle: 0,
    physics: { encoding: "base64", data: "AAAA", byteLength: 3, sha256: hex }, snapshotHash: hex, ...overrides,
  };
}

function field(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof WorldApiContractError) return error.field;
    throw error;
  }
  throw new Error("expected WorldApiContractError");
}

describe("World API 合同校验", () => {
  it("dt 必须是 1/60 的整数倍：接受 1/60、0.1，拒绝 0.02、0 与负数", () => {
    expect(worldTicksFromDt(1 / 60)).toBe(1);
    expect(worldTicksFromDt(0.1)).toBe(6);
    expect(worldTicksFromDt(2 / 60)).toBe(2);
    for (const bad of [0.02, 0, -1 / 60, 0.0001, Number.NaN, Infinity]) expect(() => worldTicksFromDt(bad), String(bad)).toThrow(WorldApiContractError);
  });

  it("step 要求 dt 与 ticks 二选一并限制单次上限", () => {
    expect(validateWorldStepRequest({ ticks: 3 })).toEqual({ action: {}, ticks: 3 });
    expect(validateWorldStepRequest({ dt: 0.5 }).ticks).toBe(30);
    expect(field(() => validateWorldStepRequest({}))).toBe("step");
    expect(field(() => validateWorldStepRequest({ dt: 0.1, ticks: 6 }))).toBe("step");
    expect(field(() => validateWorldStepRequest({ ticks: WORLD_LIMITS.maxTicksPerStep + 1 }))).toBe("ticks");
    expect(field(() => validateWorldStepRequest({ dt: 11 }))).toBe("dt");
    expect(field(() => validateWorldStepRequest({ ticks: 1.5 }))).toBe("ticks");
    expect(field(() => validateWorldStepRequest({ ticks: 1, extra: true }))).toBe("step.extra");
  });

  it("reset 校验 seed 为 uint32、scene 形状与抖动上限", () => {
    expect(validateWorldResetRequest({ seed: 0, scene }).seed).toBe(0);
    expect(validateWorldResetRequest({ seed: WORLD_LIMITS.maxSeed, scene, options: { ground: false, initialPositionJitter: 0.1 } }).options)
      .toEqual({ ground: false, initialPositionJitter: 0.1 });
    for (const seed of [-1, 1.5, WORLD_LIMITS.maxSeed + 1, "1"]) expect(field(() => validateWorldResetRequest({ seed, scene }))).toBe("seed");
    expect(field(() => validateWorldResetRequest({ seed: 1, scene: { ...scene, schemaVersion: 2 } }))).toBe("scene.schemaVersion");
    expect(field(() => validateWorldResetRequest({ seed: 1, scene: { ...scene, primitives: {} } }))).toBe("scene.primitives");
    expect(field(() => validateWorldResetRequest({ seed: 1, scene, options: { initialPositionJitter: 5 } }))).toBe("options.initialPositionJitter");
  });

  it("action 限制命令/物理动作形状并给出精确字段路径", () => {
    const action = validateWorldAction({
      commands: [{ id: "c1", type: "object.set-transform", target: { kind: "object", sceneId: "s", objectId: "o" } }],
      physics: [{ type: "apply-impulse", objectId: "o", impulse: [0, 1, 0] }, { type: "set-body", objectId: "o", body: { type: "dynamic", mass: 2 } }],
      events: [{ name: "go", data: { a: 1 } }],
    });
    expect(action.physics).toHaveLength(2);
    expect(field(() => validateWorldAction({ commands: [{ type: "x" }] }))).toBe("action.commands[0].id");
    expect(field(() => validateWorldAction({ physics: [{ type: "teleport" }] }))).toBe("action.physics[0].type");
    expect(field(() => validateWorldAction({ physics: [{ type: "apply-impulse", objectId: "o", impulse: [0, Number.NaN, 0] }] }))).toBe("action.physics[0].impulse[1]");
    expect(field(() => validateWorldAction({ physics: [{ type: "set-body", objectId: "o", body: { type: "dynamic", mass: 0 } }] }))).toBe("action.physics[0].body.mass");
    expect(field(() => validateWorldAction({ commands: new Array(WORLD_LIMITS.maxCommandsPerAction + 1).fill({ id: "a", type: "b" }) }))).toBe("action.commands");
    expect(field(() => validateWorldAction({ unknown: 1 }))).toBe("action.unknown");
  });

  it("observe：通道去重，传感器只接受已登记的占位种类", () => {
    expect(validateWorldObserveRequest(undefined)).toEqual({});
    expect(validateWorldObserveRequest({ channels: ["poses", "poses"] }).channels).toEqual(["poses"]);
    expect(validateWorldObserveRequest({ sensors: [{ id: "d0", kind: "depth" }] }).sensors).toHaveLength(1);
    expect(field(() => validateWorldObserveRequest({ channels: ["rgb"] }))).toBe("channels[0]");
    expect(field(() => validateWorldObserveRequest({ sensors: [{ id: "x", kind: "thermal" }] }))).toBe("sensors[0].kind");
  });

  it("snapshot 形状校验：版本、哈希格式与字节上限", () => {
    expect(validateWorldSnapshot(snapshot()).tick).toBe(12);
    expect(field(() => validateWorldSnapshot(snapshot({ snapshotVersion: "2" })))).toBe("snapshot.snapshotVersion");
    expect(field(() => validateWorldSnapshot(snapshot({ sceneHash: "xyz" })))).toBe("snapshot.sceneHash");
    expect(field(() => validateWorldSnapshot(snapshot({ tick: -1 })))).toBe("snapshot.tick");
    expect(field(() => validateWorldSnapshot(snapshot({ physics: { encoding: "base64", data: "A", byteLength: WORLD_LIMITS.maxSnapshotBytes + 1, sha256: hex } })))).toBe("snapshot.physics.byteLength");
    expect(field(() => validateWorldSnapshot(snapshot({ physics: { encoding: "hex", data: "A", byteLength: 1, sha256: hex } })))).toBe("snapshot.physics");
  });

  it("审查回归：冲量/速度/质量幅值上限与事件 data 的深度、节点、字节、__proto__ 限制", () => {
    expect(field(() => validateWorldAction({ physics: [{ type: "apply-impulse", objectId: "o", impulse: [1e308, 0, 0] }] }))).toBe("action.physics[0].impulse[0]");
    expect(field(() => validateWorldAction({ physics: [{ type: "set-linear-velocity", objectId: "o", velocity: [0, WORLD_LIMITS.maxAbsVelocity + 1, 0] }] }))).toBe("action.physics[0].velocity[1]");
    expect(field(() => validateWorldAction({ physics: [{ type: "set-body", objectId: "o", body: { type: "dynamic", mass: WORLD_LIMITS.maxMass * 2 } }] }))).toBe("action.physics[0].body.mass");
    const deep = JSON.parse(`${"[".repeat(200_000)}${"]".repeat(200_000)}`);
    expect(() => validateWorldEventData(deep, "data")).toThrow(/嵌套深度/);
    expect(() => validateWorldEventData(JSON.parse('{"__proto__":{"x":1}}'), "data")).toThrow(/__proto__/);
    expect(() => validateWorldEventData("x".repeat(WORLD_LIMITS.maxEventDataBytes + 1), "data")).toThrow(/字节/);
    expect(validateWorldEventData({ a: [1, "b", null, true] }, "data")).toEqual({ a: [1, "b", null, true] });
    expect(field(() => validateWorldAction({ commands: [JSON.parse('{"id":"c","type":"data.apply","values":{"__proto__":{}}}')] }))).toBe("action.commands[0]");
  });

  it("审查回归：快照对象表逐项校验（重复 id/句柄、越界缩放、碰撞体尺寸、地面句柄一致性）", () => {
    const object = (overrides: Record<string, unknown> = {}) => ({
      id: "a", kind: "box", source: "primitive", name: "a", visible: true,
      body: { type: "dynamic", mass: 1, friction: 0.5, restitution: 0 },
      transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      collider: { shape: "cuboid", halfExtents: [1, 1, 1] }, handle: 5e-324, ...overrides,
    });
    expect(validateWorldSnapshot(snapshot({ objects: [object()] })).objects).toHaveLength(1);
    expect(field(() => validateWorldSnapshot(snapshot({ objects: [object(), object({ handle: 1e-323 })] })))).toBe("snapshot.objects[1].id");
    expect(field(() => validateWorldSnapshot(snapshot({ objects: [object(), object({ id: "b" })] })))).toBe("snapshot.objects[1].handle");
    expect(field(() => validateWorldSnapshot(snapshot({ objects: [object({ transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1e9, 1, 1] } })] })))).toBe("snapshot.objects[0].transform.scale[0]");
    expect(field(() => validateWorldSnapshot(snapshot({ objects: [object({ collider: { shape: "ball", radius: 1e6 } })] })))).toBe("snapshot.objects[0].collider.radius");
    expect(field(() => validateWorldSnapshot(snapshot({ objects: [object({ handle: null })] })))).toBe("snapshot.objects[0].handle");
    expect(field(() => validateWorldSnapshot(snapshot({ objects: [object({ name: "x".repeat(WORLD_LIMITS.maxNameLength + 1) })] })))).toBe("snapshot.objects[0].name");
    expect(field(() => validateWorldSnapshot(snapshot({ groundHandle: null })))).toBe("snapshot.groundHandle");
    expect(field(() => validateWorldSnapshot(snapshot({ gravity: [0, -1e308, 0] })))).toBe("snapshot.gravity[1]");
  });
});