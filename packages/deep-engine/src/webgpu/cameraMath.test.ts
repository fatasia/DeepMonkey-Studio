import { describe, expect, it } from "vitest";
import { lookAt, lookAtRelative, multiply, perspective, type Vec3 } from "./cameraMath.js";

const origin: Vec3 = [0, 0, 0];

describe("lookAtRelative（camera-relative view 构建）", () => {
  it("origin 全零时与 lookAt 逐位一致（回归：零行为变化）", () => {
    const cases: readonly [Vec3, Vec3, Vec3][] = [
      [[0, 0, 10], [0, 0, 0], [0, 1, 0]],
      [[12.5, -3.25, 8], [0, 0.5, 0], [0, 1, 0]],
      [[5, 5, 5], [-2, 1, 3], [0.2, 1, -0.1]],
      [[-1e5 + 0.003, 3, 12], [-1e5, 0.25, 0], [0, 1, 0]],
    ];
    for (const [eye, target, up] of cases) {
      const legacy = lookAt(eye, target, up), relative = lookAtRelative(eye, target, up, origin);
      expect(Array.from(relative)).toEqual(Array.from(legacy));
    }
  });

  it("大坐标下基向量与 world-space lookAt 一致，平移列降至原点量级", () => {
    const eye: Vec3 = [1e7 + 12.3, 3, 12], target: Vec3 = [1e7 + 0.3, 0.25, 0], up: Vec3 = [0, 1, 0];
    const world = lookAt(eye, target, up), relative = lookAtRelative(eye, target, up, eye);
    for (let i = 0; i < 12; i++) expect(Math.abs(relative[i]! - world[i]!)).toBeLessThan(1e-6);
    for (const index of [12, 13, 14]) expect(Math.abs(relative[index]!)).toBeLessThan(100);
    // 同一姿态的世界空间平移列被 1e7 主导，float32 ulp=1.0 吞掉亚单位运动。
    expect(Math.abs(world[12]!)).toBeGreaterThan(1e6);
  });

  it("固定 origin 下 1cm 纯平移在相对 view 平移列连续可见（世界空间同列被 1e7 主导）", () => {
    const origin: Vec3 = [1e7, 0, 0];
    const eyeA: Vec3 = [1e7 + 12.3, 3, 12], eyeB: Vec3 = [1e7 + 12.31, 3, 12];
    const targetA: Vec3 = [1e7 + 0.3, 0.25, 0], targetB: Vec3 = [1e7 + 0.31, 0.25, 0];
    const up: Vec3 = [0, 1, 0];
    const relativeA = lookAtRelative(eyeA, targetA, up, origin);
    const relativeB = lookAtRelative(eyeB, targetB, up, origin);
    expect(Math.abs(relativeB[12]! - relativeA[12]!)).toBeGreaterThan(1e-4); // 新路径：亚单位运动连续
  });

  it("与透视投影组合后视轴上的相机相对顶点保持在 clip 有效域", () => {
    const eye: Vec3 = [1e7 + 12.3, 3, 12], target: Vec3 = [1e7 + 0.3, 0.25, 0];
    const projection = perspective(Math.PI / 4, 16 / 9, 0.1, 20000);
    const point = [-12, -2.75, -12] as const; // targetRelative：视轴中心
    const viewProjection = multiply(projection, lookAtRelative(eye, target, [0, 1, 0], eye));
    const x = viewProjection[0]! * point[0] + viewProjection[4]! * point[1] + viewProjection[8]! * point[2] + viewProjection[12]!;
    const w = viewProjection[3]! * point[0] + viewProjection[7]! * point[1] + viewProjection[11]! * point[2] + viewProjection[15]!;
    expect(Math.abs(x / w)).toBeLessThan(1);
  });

  it("非有限 origin 抛出明确错误", () => {
    const eye: Vec3 = [0, 0, 10], target: Vec3 = [0, 0, 0];
    expect(() => lookAtRelative(eye, target, [0, 1, 0], [Number.NaN, 0, 0])).toThrow("Camera world position");
    expect(() => lookAtRelative(eye, target, [0, 1, 0], [0, Number.POSITIVE_INFINITY, 0])).toThrow("Camera world position");
  });

  it("退化视线仍按既有语义抛出（与 lookAt 一致）", () => {
    expect(() => lookAtRelative([1, 1, 1], [1, 1, 1], [0, 1, 0], origin)).toThrow("degenerate");
    expect(() => lookAt([1, 1, 1], [1, 1, 1])).toThrow("degenerate");
  });
});
