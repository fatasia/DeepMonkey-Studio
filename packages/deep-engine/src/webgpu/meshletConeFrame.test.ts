import { describe, expect, it } from "vitest";
import { prepareMeshletConeFrame } from "./meshletConeFrame.js";
import { meshletNormalConeVisible } from "./meshletCulling.js";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const scale = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1];
const shear = [1, 0, 0, 0, 0, 1, 0, 0, 4, 0, 1, 0, 0, 0, 0, 1];
const coneAngle = 10 * Math.PI / 180;
function visible(world: number[], camera: number[], axis = [1, 0, 0], radius = 0.01): boolean {
  const frame = prepareMeshletConeFrame(world, camera);
  return !frame.valid || meshletNormalConeVisible([0, 0, 0, radius + frame.radiusError], [...axis, Math.cos(coneAngle)],
    axis.map(value => value * frame.camera[3]!), frame.camera.slice(0, 3));
}
describe("affine meshlet cone camera frame", () => {
  it("retains visible faces when compression expands a 10 degree local cone to over 60 degrees", () => {
    const camera = [-50, 0, Math.sqrt(3) * 50];
    const transformedNormal = [Math.cos(coneAngle), 0, 10 * Math.sin(coneAngle)];
    const front = (transformedNormal[0]! * camera[0]! + transformedNormal[2]! * camera[2]!) / Math.hypot(...transformedNormal) / 100;
    expect(front).toBeGreaterThan(0.5);
    // 原算法轴仍为 X，却沿用 10° 开角，会错误删除这个正面。
    expect(meshletNormalConeVisible([0, 0, 0, 0.01], [1, 0, 0, Math.cos(coneAngle)], [1, 0, 0], camera)).toBe(false);
    expect(visible(scale, camera)).toBe(true);
    expect(visible(scale, [-100, 0, 0])).toBe(false);
    expect(visible(identity, camera)).toBe(false);
  });
  it("preserves sheared visible normals and reflected geometric winding", () => {
    expect(visible(shear, [94, 0, -34.2], [0, 0, 1])).toBe(true);
    const reflected = [...scale]; reflected[0] = -1;
    expect(visible(reflected, [-50, 0, -Math.sqrt(3) * 50])).toBe(true);
    expect(visible(reflected, [-100, 0, 0])).toBe(false);
    const reflection = [...identity]; reflection[0] = -1;
    expect(visible(reflection, [0, 0, 100], [0, 0, 1])).toBe(false);
    expect(visible(reflection, [0, 0, -100], [0, 0, 1])).toBe(true);
  });
  it("keeps local camera invariance under translation and bounds uploaded camera rounding", () => {
    const translated = [...scale]; translated[12] = 1000; translated[13] = -25; translated[14] = 300;
    expect(visible(translated, [950, -25, 300 + Math.sqrt(3) * 50])).toBe(true);
    const frame = prepareMeshletConeFrame(scale, [1 / 3, 0.1, 1 / 7]);
    expect(frame.valid).toBe(true);
    const exact = [Math.fround(1 / 3), Math.fround(0.1), Math.fround(1 / 7) / Math.fround(0.1)];
    expect(Math.hypot(...exact.map((value, index) => value - frame.camera[index]!))).toBeLessThanOrEqual(frame.radiusError);
    expect(visible(scale, [0, 0, 0])).toBe(true);
  });
  it("disables only numerically unusable transforms instead of all nonuniform scales", () => {
    const singular = [...identity]; singular[0] = 0;
    expect(prepareMeshletConeFrame(singular, [0, 0, 5]).valid).toBe(false);
    const collapsed = [...identity]; collapsed[4] = 1; collapsed[5] = 1e-12;
    expect(prepareMeshletConeFrame(collapsed, [0, 0, 5]).valid).toBe(false);
    for (const matrix of [identity, scale, shear]) expect(prepareMeshletConeFrame(matrix, [0, 0, 5]).valid).toBe(true);
  });
  it("does not cull when normal spread plus sphere spread reaches a hemisphere", () => {
    expect(meshletNormalConeVisible([0, 0, 0, Math.sqrt(3) / 2], [0, 0, 1, 0.5], [0, 0, 1], [0, 0, -1])).toBe(true);
  });
});
