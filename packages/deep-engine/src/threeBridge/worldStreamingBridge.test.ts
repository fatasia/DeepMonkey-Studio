import { describe, expect, it } from "vitest";
import { acceptWorldStreamingPlan, decideWorldStreamingReplan, diffWorldChunkDesired,
  translateWorldChunkDemand, worldStreamingDesiredKeys } from "./worldStreamingBridge.js";
import { planWorldChunkDemand, worldChunkKey } from "../rayTracing/worldChunkBridge.js";
import { WORLD_CELL_SIZE } from "../rayTracing/worldPartition.js";

const camera = { cameraX: 900, cameraZ: -700, forwardX: 1, forwardZ: 0, speed: 10 };
// 相机单元 (1,-2)；radius 1 → cx∈[0,2] × cz∈[-3,-1] 共 9 单元，每单元 4 个 LOD 键。
const radius1 = planWorldChunkDemand(camera, 1);
const translated = translateWorldChunkDemand(radius1);

describe("world streaming bridge — demand translation", () => {
  it("translates planned demands 1:1 preserving order and keys", () => {
    expect(translated).toHaveLength(radius1.length);
    translated.forEach((demand, index) => {
      const source = radius1[index]!;
      expect(demand.key).toBe(source.key);
      expect(demand.cell).toEqual(source.cell);
      expect(demand.urgency).toBe(source.urgency);
      expect(demand.center).toEqual(source.center);
    });
    expect(new Set(translated.map(demand => demand.key)).size).toBe(translated.length);
    expect(Object.isFrozen(translated[0])).toBe(true);
  });

  it("maps camera cell to visible and the rest to prefetch by default", () => {
    expect(translated.filter(demand => demand.mode === "visible"))
      .toEqual(translated.filter(demand => demand.cell.cx === 1 && demand.cell.cz === -2));
    expect(translated.filter(demand => demand.mode === "prefetch").length).toBe(translated.length - 4);
  });

  it("honours the visibleUrgency threshold", () => {
    // radius 1 → 9 单元秩次 0,1/8,...,1；阈值 0.2 放行秩 0 与秩 1（0.125）两单元。
    const widened = translateWorldChunkDemand(radius1, { visibleUrgency: 0.2 });
    expect(widened.filter(demand => demand.mode === "visible")).toHaveLength(8);
    expect(widened.filter(demand => demand.mode === "visible").every(demand => demand.urgency <= 0.2)).toBe(true);
  });

  it("is deterministic across repeated calls", () => {
    expect(translateWorldChunkDemand(radius1, { visibleUrgency: 0.5 }))
      .toEqual(translateWorldChunkDemand(radius1, { visibleUrgency: 0.5 }));
  });

  it("rejects duplicate, foreign and malformed keys fail-closed", () => {
    expect(() => translateWorldChunkDemand([...radius1, ...radius1])).toThrow(TypeError);
    expect(() => translateWorldChunkDemand([{ ...radius1[0]!, key: "author-scene|vg-0" }])).toThrow(TypeError);
    expect(() => translateWorldChunkDemand([{ ...radius1[0]!, urgency: 1.5 }])).toThrow(TypeError);
    expect(() => translateWorldChunkDemand(radius1, { visibleUrgency: -0.1 })).toThrow(RangeError);
  });
});

describe("world streaming bridge — desired-set diff", () => {
  const previousKeys = worldStreamingDesiredKeys(translated);

  it("computes added/removed/unchanged for a one-cell camera move", () => {
    const moved = translateWorldChunkDemand(planWorldChunkDemand({ ...camera, cameraX: 900 + WORLD_CELL_SIZE }, 1));
    const diff = diffWorldChunkDesired(previousKeys, moved);
    // cx=0 列滚出半径（3 单元 × 4 LOD；key 字典序按字符串逐位比较，负 cz 时 -1 在前），
    // cx=3 列滚入；中间 6 单元 24 键保持。
    expect(diff.removed).toEqual([
      worldChunkKey({ cx: 0, cz: -1 }, 0), worldChunkKey({ cx: 0, cz: -1 }, 1),
      worldChunkKey({ cx: 0, cz: -1 }, 2), worldChunkKey({ cx: 0, cz: -1 }, 3),
      worldChunkKey({ cx: 0, cz: -2 }, 0), worldChunkKey({ cx: 0, cz: -2 }, 1),
      worldChunkKey({ cx: 0, cz: -2 }, 2), worldChunkKey({ cx: 0, cz: -2 }, 3),
      worldChunkKey({ cx: 0, cz: -3 }, 0), worldChunkKey({ cx: 0, cz: -3 }, 1),
      worldChunkKey({ cx: 0, cz: -3 }, 2), worldChunkKey({ cx: 0, cz: -3 }, 3),
    ]);
    expect(diff.added.map(demand => demand.cell.cx)).toEqual(new Array(12).fill(3));
    expect([...diff.added.map(demand => demand.urgency)]
      .sort((a, b) => a - b)).toEqual(diff.added.map(demand => demand.urgency));
    expect(diff.unchangedCount).toBe(24);
    expect(diffWorldChunkDesired(previousKeys, translated)).toEqual({ added: [], removed: [], unchangedCount: 36 });
  });

  it("treats radius roll-out as eviction candidates without explicit unregister", () => {
    const moved = translateWorldChunkDemand(planWorldChunkDemand({ ...camera, cameraX: 900 + WORLD_CELL_SIZE * 2 }, 1));
    const diff = diffWorldChunkDesired(previousKeys, moved);
    // cx∈{0,1} 两列共 6 单元 24 键逐出候选；键空间与 author 键零交集由翻译层保证。
    expect(diff.removed).toHaveLength(24);
    expect(diff.added).toHaveLength(24);
    expect(diff.removed.every(key => key.startsWith("world|"))).toBe(true);
    expect(diff.unchangedCount).toBe(12);
  });

  it("handles empty sets and is deterministic", () => {
    expect(diffWorldChunkDesired(new Set(), translated)).toEqual({ added: translated, removed: [], unchangedCount: 0 });
    const drained = diffWorldChunkDesired(previousKeys, []);
    expect(drained.added).toEqual([]);
    expect(drained.removed).toHaveLength(previousKeys.size);
    expect(drained.unchangedCount).toBe(0);
    expect(diffWorldChunkDesired(previousKeys, [...translated].reverse()))
      .toEqual(diffWorldChunkDesired(previousKeys, translated));
  });

  it("rejects non-set previous state and duplicate next keys", () => {
    expect(() => diffWorldChunkDesired([...previousKeys] as unknown as ReadonlySet<string>, translated)).toThrow(TypeError);
    expect(() => diffWorldChunkDesired(new Set(), [...translated, ...translated])).toThrow(TypeError);
  });
});

describe("world streaming bridge — pacing throttle", () => {
  it("plans on first frame", () => {
    expect(decideWorldStreamingReplan(undefined, camera, 0)).toEqual({ replan: true, reason: "first-plan" });
  });

  it("skips replans below the displacement threshold inside a cell", () => {
    const state = acceptWorldStreamingPlan(camera, 0);
    expect(decideWorldStreamingReplan(state, { ...camera, cameraX: camera.cameraX + 1, cameraZ: camera.cameraZ + 2 }, 5))
      .toEqual({ replan: false, reason: "within-threshold" });
  });

  it("throttles displacement-triggered replans to the cooldown budget", () => {
    const state = acceptWorldStreamingPlan(camera, 0);
    // +64m 恰达默认阈值且仍留在相机单元 (1,-2)（单元 1 覆盖 x∈[512,1024)）。
    const moved = { ...camera, cameraX: camera.cameraX + WORLD_CELL_SIZE / 8 };
    expect(decideWorldStreamingReplan(state, moved, 14)).toEqual({ replan: false, reason: "throttled-cooldown" });
    expect(decideWorldStreamingReplan(state, moved, 15)).toEqual({ replan: true, reason: "displacement-threshold" });
    const custom = decideWorldStreamingReplan(state, moved, 3, { replanCooldownFrames: 2 });
    expect(custom).toEqual({ replan: true, reason: "displacement-threshold" });
  });

  it("always replans on cell change regardless of cooldown", () => {
    const state = acceptWorldStreamingPlan(camera, 10);
    expect(decideWorldStreamingReplan(state, { ...camera, cameraX: camera.cameraX + WORLD_CELL_SIZE }, 11))
      .toEqual({ replan: true, reason: "cell-changed" });
  });

  it("works in negative quadrants and freezes accepted state", () => {
    const west = { cameraX: -700.5, cameraZ: -700.5, forwardX: 0, forwardZ: 0, speed: 0 };
    const state = acceptWorldStreamingPlan(west, 3);
    expect(state.cell).toEqual({ cx: -2, cz: -2 });
    expect(Object.isFrozen(state)).toBe(true);
    expect(decideWorldStreamingReplan(state, west, 4)).toEqual({ replan: false, reason: "within-threshold" });
    expect(decideWorldStreamingReplan(state, { ...west, cameraX: west.cameraX + WORLD_CELL_SIZE }, 4))
      .toEqual({ replan: true, reason: "cell-changed" });
  });

  it("fails closed on frame regression and invalid options or input", () => {
    const state = acceptWorldStreamingPlan(camera, 10);
    expect(() => decideWorldStreamingReplan(state, camera, 9)).toThrow(RangeError);
    expect(() => decideWorldStreamingReplan(state, camera, 11, { minDisplacement: 0 })).toThrow(RangeError);
    expect(() => decideWorldStreamingReplan(state, camera, 11, { replanCooldownFrames: 0 })).toThrow(RangeError);
    expect(() => decideWorldStreamingReplan(state, { ...camera, cameraX: Number.NaN }, 11)).toThrow(RangeError);
    expect(() => acceptWorldStreamingPlan(camera, -1)).toThrow(RangeError);
    expect(() => decideWorldStreamingReplan({ ...acceptWorldStreamingPlan(camera, 10), lastReplanFrame: -2 },
      camera, 11)).toThrow(TypeError);
  });
});

describe("world streaming bridge — desired key set", () => {
  it("mirrors the translated demand keys", () => {
    const keys = worldStreamingDesiredKeys(translated);
    expect(keys.size).toBe(translated.length);
    expect([...keys].every(key => key.startsWith("world|"))).toBe(true);
    expect(keys.has(worldChunkKey({ cx: 1, cz: -2 }, 0))).toBe(true);
  });
});
