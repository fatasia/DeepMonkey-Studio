import { describe, expect, it } from "vitest";
import { lookAt, lookAtRelative, multiply, perspective, type Vec3 } from "./cameraMath.js";
import { packTransform, packTransformRelativeTo } from "../instanceTransform.js";

/** 模拟 WGSL f32 语义的 mat4 * vec4：每次乘/加都按 float32 舍入（列主序）。 */
function transformPointF32(m: Float32Array, x: number, y: number, z: number): [number, number, number, number] {
  const row = (r: number) => Math.fround(Math.fround(Math.fround(Math.fround(m[r]! * x)
    + Math.fround(m[4 + r]! * y)) + Math.fround(m[8 + r]! * z)) + Math.fround(m[12 + r]!));
  return [row(0), row(1), row(2), row(3)];
}

type Mat = number[];
/** Float64 参考管线：与 cameraMath 相同公式，全程 double，无 float32 舍入。 */
function lookAt64(eye: readonly number[], target: readonly number[], up: readonly number[] = [0, 1, 0]): Mat {
  const sub = (a: readonly number[], b: readonly number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: readonly number[], b: readonly number[]) =>
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (v: readonly number[]) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
  const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}
function perspective64(fov: number, aspect: number, near: number, far: number): Mat {
  const f = 1 / Math.tan(fov / 2);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, far * near / (near - far), 0];
}
function multiply64(a: Mat, b: Mat): Mat {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++)
    for (let k = 0; k < 4; k++) out[column * 4 + row]! += a[k * 4 + row]! * b[column * 4 + k]!;
  return out;
}
function transformPoint64(m: Mat, x: number, y: number, z: number): Mat {
  const row = (r: number) => m[r]! * x + m[4 + r]! * y + m[8 + r]! * z + m[12 + r]!;
  return [row(0), row(1), row(2), row(3)];
}

/** 从 packTransform 产物的 float32 值重建列主序模型矩阵（GPU 实际拿到的就是这些值）。 */
function modelMatrixFromPacked(packed: Float32Array): Float32Array {
  return new Float32Array([packed[0]!, packed[1]!, packed[2]!, 0, packed[4]!, packed[5]!, packed[6]!, 0,
    packed[8]!, packed[9]!, packed[10]!, 0, packed[3]!, packed[7]!, packed[11]!, 1]);
}

interface Scenario {
  readonly worldX: number;
  readonly clipOldA: number; readonly clipOldB: number;
  readonly clipNewA: number; readonly clipNewB: number;
  readonly clip64A: number; readonly clip64B: number;
  readonly worldOldX: number; readonly worldNewX: number; readonly worldTrueX: number;
}

/**
 * 一个大世界 X 坐标 + 相机 1cm 纯平移的双姿态实验。
 * 旧路径 = 世界坐标矩阵直接 fround 打包 + 世界空间 view（现状管线）；
 * 新路径 = 每帧以相机世界位置（Float64）为原点，CPU 侧先减再 fround（camera-relative）。
 * 坐标刻意取非 float32 ulp 对齐值（+0.003/+0.03/+0.3），暴露静态表示误差。
 */
function runScenario(worldX: number): Scenario {
  const local = [0.5, 0.25, -0.75] as const;
  // TS 侧实例变换输入是 Float64（number[]）；fround 只允许发生在 pack 层。
  const instance: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, worldX, 0, 0, 1];
  const eyeA: Vec3 = [worldX + 12, 3, 12], eyeB: Vec3 = [worldX + 12.01, 3, 12];
  const targetA: Vec3 = [worldX, 0.25, 0], targetB: Vec3 = [worldX + 0.01, 0.25, 0];
  const up: Vec3 = [0, 1, 0];
  const projection = perspective(Math.PI / 4, 16 / 9, 0.1, 20000);
  const projection64 = perspective64(Math.PI / 4, 16 / 9, 0.1, 20000);

  const packedOld = new Float32Array(24);
  packTransform(instance, packedOld);
  const modelOld = modelMatrixFromPacked(packedOld);
  const viewProjectionOldA = multiply(projection, lookAt(eyeA, targetA, up));
  const viewProjectionOldB = multiply(projection, lookAt(eyeB, targetB, up));

  const packedNewA = new Float32Array(24), packedNewB = new Float32Array(24);
  packTransformRelativeTo(instance, eyeA, packedNewA);
  packTransformRelativeTo(instance, eyeB, packedNewB);
  const modelNewA = modelMatrixFromPacked(packedNewA), modelNewB = modelMatrixFromPacked(packedNewB);
  const viewProjectionNewA = multiply(projection, lookAtRelative(eyeA, targetA, up, eyeA));
  const viewProjectionNewB = multiply(projection, lookAtRelative(eyeB, targetB, up, eyeB));

  const viewProjection64A = multiply64(projection64, lookAt64(eyeA, targetA, up));
  const viewProjection64B = multiply64(projection64, lookAt64(eyeB, targetB, up));

  const worldOld = transformPointF32(modelOld, local[0], local[1], local[2]);
  const worldNewA = transformPointF32(modelNewA, local[0], local[1], local[2]);
  const worldNewB = transformPointF32(modelNewB, local[0], local[1], local[2]);
  const world64 = transformPoint64([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, worldX, 0, 0, 1],
    local[0], local[1], local[2]);
  const clipOldA = transformPointF32(viewProjectionOldA, worldOld[0], worldOld[1], worldOld[2]);
  const clipOldB = transformPointF32(viewProjectionOldB, worldOld[0], worldOld[1], worldOld[2]);
  const clipNewA = transformPointF32(viewProjectionNewA, worldNewA[0], worldNewA[1], worldNewA[2]);
  const clipNewB = transformPointF32(viewProjectionNewB, worldNewB[0], worldNewB[1], worldNewB[2]);
  const clip64A = transformPoint64(viewProjection64A, world64[0], world64[1], world64[2]);
  const clip64B = transformPoint64(viewProjection64B, world64[0], world64[1], world64[2]);
  return { worldX, clipOldA: clipOldA[0]!, clipOldB: clipOldB[0]!, clipNewA: clipNewA[0]!,
    clipNewB: clipNewB[0]!, clip64A: clip64A[0]!, clip64B: clip64B[0]!,
    worldOldX: worldOld[0]!, worldNewX: worldNewA[0]!, worldTrueX: world64[0]! };
}

const scenarioReport = (s: Scenario) => ({
  worldX: s.worldX,
  vertexWorldXErrorOld: Math.abs(s.worldOldX - s.worldTrueX),
  vertexWorldXErrorNew: Math.abs(s.worldNewX - (s.worldTrueX - (s.worldX + 12))),
  clipAbsoluteErrorOld: Math.abs(s.clipOldA - s.clip64A),
  clipAbsoluteErrorNew: Math.abs(s.clipNewA - s.clip64A),
  clipDelta1cmAnalytic: s.clip64B - s.clip64A,
  clipDelta1cmOld: s.clipOldB - s.clipOldA,
  clipDelta1cmNew: s.clipNewB - s.clipNewA,
});

describe("camera-relative 大坐标 GPU 顶点抖动量化（float32 表示误差对照）", () => {
  // 非 ulp 对齐坐标：1e5+0.003 / 1e6+0.03 / 1e7+0.3 —— 静态表示误差随量级增长。
  const scenarios = [1e5 + 0.003, 1e6 + 0.03, 1e7 + 0.3].map(runScenario);

  it("实验数据基线：打印修复前后对照表", () => {
    for (const s of scenarios) console.log("[C4 对照]", JSON.stringify(scenarioReport(s)));
    expect(scenarios).toHaveLength(3);
  });

  it("修复前：顶点世界坐标 float32 表示误差随坐标量级单调增大（1e7 处达 0.5 场景单位以上）", () => {
    const errors = scenarios.map(s => Math.abs(s.worldOldX - s.worldTrueX));
    expect(errors[0]!).toBeGreaterThan(0); // 1e5+0.003：实例摆放误差已被吞掉一部分
    expect(errors[1]!).toBeGreaterThan(errors[0]! * 4); // 1e6+0.03
    expect(errors[2]!).toBeGreaterThanOrEqual(0.5); // 1e7+0.3：ulp=1.0，静态误差 0.8
    expect(errors[2]!).toBeGreaterThan(errors[1]!);
  });

  it("修复后：顶点相对坐标 float32 表示误差恒在 1e-5 场景单位内（三个量级全部）", () => {
    for (const s of scenarios) {
      const relative = s.worldTrueX - (s.worldX + 12);
      expect(Math.abs(s.worldNewX - relative)).toBeLessThan(1e-5);
    }
  });

  it("修复前：1e7 处 1cm 相机平移下顶点 clip 完全冻结或失真 ≥8 倍（灾难性消除）", () => {
    const s = scenarios[2]!;
    const analytic = Math.abs(s.clip64B - s.clip64A);
    expect(analytic).toBeGreaterThan(0);
    const measured = Math.abs(s.clipOldB - s.clipOldA);
    expect(measured === 0 || measured > 8 * analytic).toBe(true);
  });

  it("修复后：1cm 相机平移的 clip 增量在三个量级都贴合 Float64 参考（<2% 相对误差）", () => {
    for (const s of scenarios) {
      const analytic = s.clip64B - s.clip64A;
      expect(Math.abs(analytic)).toBeGreaterThan(0);
      expect(Math.abs((s.clipNewB - s.clipNewA) - analytic)).toBeLessThan(Math.abs(analytic) * 0.02);
    }
  });

  it("修复后：clip 绝对精度较旧路径提升 ≥100 倍（1e5）、≥1000 倍（1e6）、≥10000 倍（1e7）", () => {
    const thresholds = [100, 1000, 10000];
    scenarios.forEach((s, index) => {
      const old = Math.abs(s.clipOldA - s.clip64A), modern = Math.abs(s.clipNewA - s.clip64A);
      expect(old).toBeGreaterThan(modern * thresholds[index]!);
    });
  });

  it("退化对照：同一场景两个相距 0.3 的实例，旧路径平移列折叠为同一 float32，新路径可分辨", () => {
    const base = 1e7 + 0.6, origin: Vec3 = [base + 12, 3, 12];
    const near: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, base, 0, 0, 1];
    const apart: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, base + 0.3, 0, 0, 1];
    const packedNear = new Float32Array(24), packedApart = new Float32Array(24);
    packTransform(near, packedNear);
    packTransform(apart, packedApart);
    expect(packedNear[3]).toBe(packedApart[3]); // 旧路径：两个世界位置折叠为同一 float32
    const relativeNear = new Float32Array(24), relativeApart = new Float32Array(24);
    packTransformRelativeTo(near, origin, relativeNear);
    packTransformRelativeTo(apart, origin, relativeApart);
    expect(relativeNear[3]).not.toBe(relativeApart[3]); // 新路径：-12.6 与 -12.3 保持可分辨
    expect(relativeApart[3]! - relativeNear[3]!).toBeCloseTo(0.3, 5);
  });
});
