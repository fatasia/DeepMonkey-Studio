import { describe, expect, it } from "vitest";
import type { SceneLinearPrefabPathState } from "@bim-studio/contracts";
import { DEFAULT_NAVIGATION_SETTINGS } from "../navigationSettings";
import {
  DEFAULT_LINEAR_PREFAB_MAX_SLOPE_ANGLE_DEGREES,
  linearPrefabSegments,
  projectLinearPrefabPathPoints,
  stablePathGateIndex,
} from "./linearPrefabPath";

function path(patch: Partial<SceneLinearPrefabPathState> = {}): SceneLinearPrefabPathState {
  return { points: [{ id: "a", position: { x: 0, y: 0, z: 0 } },
    { id: "b", position: { x: 3, y: 0, z: 4 } }], interpolation: "linear", closed: false,
    snapToGround: true, seed: 17, ...patch };
}

describe("linear prefab structural path", () => {
  it("turns endpoints into exact finite segment transforms", () => {
    expect(linearPrefabSegments(path())).toEqual([{ index: 0,
      start: { x: 0, y: 0, z: 0 }, end: { x: 3, y: 0, z: 4 },
      midpoint: { x: 1.5, y: 0, z: 2 }, lengthM: 5, yawRadians: Math.atan2(4, 3) }]);
  });

  it("tessellates splines deterministically and bounds output", () => {
    const curved = path({ interpolation: "catmull-rom", points: [
      { id: "a", position: { x: 0, y: 0, z: 0 } }, { id: "b", position: { x: 5, y: 0, z: 0 } },
      { id: "c", position: { x: 5, y: 0, z: 5 } }, { id: "d", position: { x: 10, y: 0, z: 5 } },
    ] });
    expect(linearPrefabSegments(curved)).toEqual(linearPrefabSegments(structuredClone(curved)));
    expect(linearPrefabSegments(curved).length).toBeGreaterThan(3);
    expect(linearPrefabSegments(curved).length).toBeLessThanOrEqual(512);
  });

  it("uses a fixed seed for one stable gate segment and rejects unsafe paths", () => {
    expect(stablePathGateIndex(path(), 5)).toBe(2);
    expect(() => linearPrefabSegments(path({ seed: -1 }))).toThrow("uint32");
    expect(() => linearPrefabSegments(path({ points: [
      { id: "same", position: { x: 0, y: 0, z: 0 } }, { id: "same", position: { x: 1, y: 0, z: 0 } },
    ] }))).toThrow("unique");
  });

  it("defaults the slope limit to the navigation maxSlopeAngle default", () => {
    expect(DEFAULT_LINEAR_PREFAB_MAX_SLOPE_ANGLE_DEGREES).toBe(DEFAULT_NAVIGATION_SETTINGS.maxSlopeAngle);
  });

  it("projects authored points onto a known ground plane deterministically for preview and publishing", () => {
    const elevated = path({ points: [
      { id: "a", position: { x: 0, y: 7.5, z: 0 } }, { id: "b", position: { x: 3, y: 7.5, z: 4 } },
    ] });
    const projected = linearPrefabSegments(elevated, { groundY: 0 });
    expect(projected.map(segment => segment.start.y)).toEqual([0]);
    expect(projected[0]!.lengthM).toBe(5); // 投影只归 y，水平几何与 yaw 保持不变
    // 同一输入重复编译逐值一致：作者预览与发布消费同一确定性结果。
    expect(linearPrefabSegments(elevated, { groundY: 0 })).toEqual(projected);
    // 基准面高度跟随调用方语义（导航地面 y=0、平台面 y=3 均可表达）。
    expect(linearPrefabSegments(elevated, { groundY: 3 }).every(segment => segment.midpoint.y === 3)).toBe(true);
  });

  it("keeps authored y when terrain data is absent or snapping is off", () => {
    const elevated = path({ points: [
      { id: "a", position: { x: 0, y: 2, z: 0 } }, { id: "b", position: { x: 3, y: 2, z: 4 } },
    ] });
    // 没有地形/基准面数据：保持作者 y，不虚构地形高度。
    expect(linearPrefabSegments(elevated).every(segment => segment.midpoint.y === 2)).toBe(true);
    expect(projectLinearPrefabPathPoints([{ x: 0, y: 2, z: 0 }], true, undefined))
      .toEqual([{ x: 0, y: 2, z: 0 }]);
    // 贴地关闭：即使有基准面也不动作者 y。
    expect(projectLinearPrefabPathPoints([{ x: 0, y: 2, z: 0 }], false, 0)).toEqual([{ x: 0, y: 2, z: 0 }]);
  });

  it("accepts segments exactly at the slope threshold and rejects steeper ones", () => {
    // 恰好等于阈值（45°，rise/run = 1）必须放行。
    const atLimit = path({ maxSlopeAngleDegrees: 45, points: [
      { id: "a", position: { x: 0, y: 0, z: 0 } }, { id: "b", position: { x: 1, y: 1, z: 0 } },
    ] });
    expect(() => linearPrefabSegments(atLimit)).not.toThrow();
    // 超过阈值立即 fail-closed，错误给出段号、实际坡度与上限。
    const overLimit = path({ maxSlopeAngleDegrees: 45, points: [
      { id: "a", position: { x: 0, y: 0, z: 0 } }, { id: "b", position: { x: 1, y: 1.5, z: 0 } },
    ] });
    expect(() => linearPrefabSegments(overLimit)).toThrow(/第 1→2 点坡度 56\.3° 超过上限 45°/);
    // 缺省阈值与导航口径一致：平缓路径放行，超过 50° 拒绝。
    expect(() => linearPrefabSegments(path({ points: [
      { id: "a", position: { x: 0, y: 0, z: 0 } }, { id: "b", position: { x: 1, y: 1.1, z: 0 } },
    ] }))).not.toThrow();
    expect(() => linearPrefabSegments(path({ points: [
      { id: "a", position: { x: 0, y: 0, z: 0 } }, { id: "b", position: { x: 1, y: 1.3, z: 0 } },
    ] }))).toThrow(/超过上限 50°/);
  });

  it("rejects vertical jumps, invalid limits and steep closing edges of closed paths", () => {
    // 垂直段没有水平投影，视作 90° 坡度拒绝。
    expect(() => linearPrefabSegments(path({ points: [
      { id: "a", position: { x: 0, y: 0, z: 0 } }, { id: "b", position: { x: 0, y: 4, z: 0 } },
    ] }))).toThrow(/坡度 90\.0°/);
    // 越界阈值在管道层同样拒绝（合同校验之前的最后防线）。
    expect(() => linearPrefabSegments(path({ maxSlopeAngleDegrees: 90 }))).toThrow(/0\.\.89/);
    // 闭合路径的收尾段（末点→首点）也受坡度边界约束。
    const closingPoints = [
      { id: "a", position: { x: 0, y: 0, z: 0 } }, { id: "b", position: { x: 10, y: 0, z: 0 } },
      { id: "c", position: { x: 0, y: 9, z: 0 } },
    ];
    // 相同点列的开放路径不校验收尾段，放行；闭合后收尾 c→a 为垂直段，拒绝。
    expect(() => linearPrefabSegments(path({ points: closingPoints }))).not.toThrow();
    expect(() => linearPrefabSegments(path({ closed: true, points: closingPoints }))).toThrow(/第 3→1 点/);
    const closedFlat = path({ closed: true, points: [
      { id: "a", position: { x: 0, y: 0, z: 0 } }, { id: "b", position: { x: 10, y: 0, z: 0 } },
      { id: "c", position: { x: 10, y: 0, z: 1 } },
    ] });
    expect(() => linearPrefabSegments(closedFlat)).not.toThrow();
  });
});
