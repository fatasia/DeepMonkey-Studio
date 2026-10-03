import { describe, expect, it } from "vitest";
import {
  WORLD_LIMITS,
  WorldApiContractError,
  validateWorldAction,
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
    gravity: [0, -9.81, 0], ground: true, objects: [], groundHandle: null,
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

  it("observe：通道去重，传感器只接受阶段 3 预留种类", () => {
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
});
