// 投影纹理灯池解析单测(多投影器切片 2026-10-06):逐灯 resolve/单灯剔除披露/超员拒绝。
import { describe, expect, it } from "vitest";
import { resolveProjectedTexturePool } from "./pbrProjectedTexturePool.js";
import type { ProjectedTextureLight } from "../postprocess/projectedTextureTypes.js";

const identityView = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function light(overrides: Partial<ProjectedTextureLight> = {}): ProjectedTextureLight {
  return { position: [0, 2, -10], target: [0, 2, -20], verticalFovRadians: Math.PI / 2,
    intensity: 1, color: [1, 1, 1], range: 30, edgeSoften: 0,
    gobo: {} as ProjectedTextureLight["gobo"], ...overrides };
}

describe("projected texture light pool resolution(灯池 ≤4)", () => {
  it("逐灯 resolve:槽序保持,全部有效时无 fallbackReason", () => {
    const pool = resolveProjectedTexturePool([light(), light({ position: [3, 2, -10] })], identityView);
    expect(pool.frames).toHaveLength(2);
    expect(pool.fallbackReason).toBeUndefined();
    expect(pool.frames[1]!.positionView[0]).toBeCloseTo(3, 5);
  });

  it("单灯校验失败仅剔除该灯并如实披露,其余灯照常贡献", () => {
    const pool = resolveProjectedTexturePool([light(), light({ verticalFovRadians: 4 })], identityView);
    expect(pool.frames).toHaveLength(1);
    expect(pool.fallbackReason).toContain("1 invalid projector(s) dropped from pool");
  });

  it("超员(>4)整池 fail-closed 上抛;空池给 empty 披露", () => {
    const four = [light(), light(), light(), light()];
    expect(() => resolveProjectedTexturePool([...four, light()], identityView)).toThrow(RangeError);
    const empty = resolveProjectedTexturePool([], identityView);
    expect(empty.frames).toHaveLength(0);
    expect(empty.fallbackReason).toBe("empty projector pool");
  });
});
