// F6/T18 软体并行核障碍刀:镜像投影公式 vs f64 黄金(softBodyStaticCollision)对拍。
// 黄金语义:sphere 归一化半径面 / cuboid OBB 最小穿透轴推出,toLocal = Rᵀ·d(行主序转置),
// world = center + R·local;判定轴符号 (x<0?-1:1)(x==0 归 +half)。镜像与 WGSL 同 op 序,
// 差异仅数值精度(f64 vs f32)——本锁把"公式与黄金同构"钉在 CPU 层,真机只剩余 f32 量化。
// 口径纪律:黄金吃与镜像同源的 f32 pack 态(入态先 f32 化再喂双方);否则 f32 舍入噪声
// 会让双方走上不同分支(实测:球心点 f64 恰中 → dist=0 退化分支,f32 噪声 → 归一化分支,
// 0.196 假差异——那是口径错,不是公式错)。
import { describe, expect, it } from "vitest";
import { createSoftBodyStaticCollision } from "./softBodyStaticCollision.js";
import { packSoftBodyGpuParticles, type SoftBodyGpuObstacle } from "./softBodyGpuWgsl.js";
import { projectObstacle } from "./softBodyGpuDispatch.softbodyParallel.js";
import type { DynamicPhysicsBodyRuntime } from "../runtimePackage/dynamicSceneRuntime.js";

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

/** 与 softBodyStaticCollision.ts 黄金工厂同式的 quaternion→行主序旋转换算(测试侧构造 GPU 输入)。 */
function rotationFromQuaternion(quaternion: readonly [number, number, number, number]): readonly [number, number, number, number, number, number, number, number, number] {
  const length = Math.hypot(...quaternion);
  const [x, y, z, w] = quaternion.map(value => value / length) as [number, number, number, number];
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

function fixedBody(id: string, translation: readonly number[], quaternion: readonly [number, number, number, number],
  primitive: { shape: "sphere"; radius: number } | { shape: "cuboid"; halfExtents: readonly [number, number, number] }): DynamicPhysicsBodyRuntime {
  return {
    id, type: "fixed", mass: 0, friction: 0, restitution: 0,
    initialPose: { translation: [...translation] as [number, number, number], rotation: [...quaternion] as [number, number, number, number] },
    collider: { kind: "primitive", instanceIds: [], primitive },
  } as unknown as DynamicPhysicsBodyRuntime;
}

/** 世界点 = center + R·local(黄金 local = Rᵀ·d 的逆映射;用于构造局部标定点)。 */
function toWorld(center: readonly [number, number, number], rotation: readonly number[], local: readonly [number, number, number]): [number, number, number] {
  return [
    center[0] + rotation[0]! * local[0] + rotation[1]! * local[1] + rotation[2]! * local[2],
    center[1] + rotation[3]! * local[0] + rotation[4]! * local[1] + rotation[5]! * local[2],
    center[2] + rotation[6]! * local[0] + rotation[7]! * local[1] + rotation[8]! * local[2],
  ];
}

/**
 * 单障碍投影对拍:pack(f32 入态,双方同源)→ 镜像投影(f64 运算)vs 黄金投影(f64),
 * 逐点欧氏距离。quaternion 喂黄金工厂(内转矩阵),rotation 矩阵喂镜像——矩阵由同一
 * quaternion 经同式换算得到(工厂公式一致性由本对拍本身背书)。
 */
function goldenVsMirror(obstacle: SoftBodyGpuObstacle,
  quaternion: readonly [number, number, number, number],
  points: ReadonlyArray<readonly [number, number, number]>): { maxErr: number } {
  const primitive = obstacle.radius > 0
    ? { shape: "sphere" as const, radius: obstacle.radius }
    : { shape: "cuboid" as const, halfExtents: obstacle.halfExtents };
  const golden = createSoftBodyStaticCollision(
    [fixedBody("obstacle", obstacle.center, quaternion, primitive)], ["obstacle"])!;
  const state = packSoftBodyGpuParticles(points.map(point => ({
    position: [point[0], point[1], point[2]], velocity: [0, 0, 0], inverseMass: 1,
  })));
  const mirrored = Float32Array.from(state);
  projectObstacle(mirrored, obstacle);
  const goldenPx = new Float64Array(points.length);
  const goldenPy = new Float64Array(points.length);
  const goldenPz = new Float64Array(points.length);
  const inverseMass = new Float64Array(points.length).fill(1);
  // 入态同源:黄金吃 f32 pack 态(widen 回 f64),不吃原始 f64 点。
  for (let index = 0; index < points.length; index += 1) {
    goldenPx[index] = state[index * 12]!;
    goldenPy[index] = state[index * 12 + 1]!;
    goldenPz[index] = state[index * 12 + 2]!;
  }
  golden.project(goldenPx, goldenPy, goldenPz, inverseMass);
  let maxErr = 0;
  for (let index = 0; index < points.length; index += 1) {
    maxErr = Math.max(maxErr, Math.hypot(
      mirrored[index * 12]! - goldenPx[index]!,
      mirrored[index * 12 + 1]! - goldenPy[index]!,
      mirrored[index * 12 + 2]! - goldenPz[index]!));
  }
  return { maxErr };
}

// 非对称旋转:axis=(1,1,1)/√3,angle=0.7(黄金工厂与测试换算同式,同输入同矩阵)。
const ROTATED_QUATERNION = [
  Math.sin(0.35) / Math.sqrt(3), Math.sin(0.35) / Math.sqrt(3), Math.sin(0.35) / Math.sqrt(3), Math.cos(0.35),
] as const;
const ROTATED = rotationFromQuaternion(ROTATED_QUATERNION);

describe("镜像障碍投影 vs f64 黄金(softBodyStaticCollision 同构)", () => {
  it("sphere:内部标定 14 点(中心/近表面/深内部/斜向)与黄金误差 ≤ 1e-5", () => {
    const center: readonly [number, number, number] = [0.55, -0.2, 0.5];
    const radius = 0.8;
    const points: Array<readonly [number, number, number]> = [[...center]];
    for (const axis of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      for (const fraction of [0.25, 0.6, 0.95]) {
        points.push([center[0] + axis[0]! * radius * fraction, center[1] + axis[1]! * radius * fraction, center[2] + axis[2]! * radius * fraction]);
      }
    }
    points.push([center[0] + 0.3, center[1] + 0.3, center[2] + 0.3]); // 斜向内部
    const { maxErr } = goldenVsMirror({ center, radius, rotation: IDENTITY, halfExtents: [0, 0, 0] }, [0, 0, 0, 1], points);
    expect(maxErr).toBeLessThanOrEqual(1e-5);
    console.log(`[quant] sphere 公式对拍(14 点): maxErr = ${maxErr.toExponential(3)}`);
  });

  it("sphere f32 可表中心:恰在中心的自由粒子走 dist=0 退化分支,与黄金同向(旋转后 x 轴)", () => {
    // center 全整数(f32 精确),粒子恰在中心 → 双方 dist===0 → 黄金 local=(r,0,0)→world=R·local。
    const center: readonly [number, number, number] = [2, 0, 1];
    const radius = 0.5;
    const { maxErr } = goldenVsMirror({ center, radius, rotation: ROTATED, halfExtents: [0, 0, 0] }, ROTATED_QUATERNION, [[...center]]);
    expect(maxErr).toBeLessThanOrEqual(1e-5);
  });

  it("旋转 cuboid:内部标定 15 点(中心/三轴浅深/斜向)与黄金误差 ≤ 1e-5(黄金 quaternion→R 同式)", () => {
    const center: readonly [number, number, number] = [2, 0.5, -1];
    const halfExtents: readonly [number, number, number] = [0.4, 0.25, 0.15];
    const points: Array<readonly [number, number, number]> = [[...center]];
    for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
      for (const fraction of [0.5, 0.9]) {
        points.push(toWorld(center, ROTATED, [axis[0]! * halfExtents[0] * fraction, axis[1]! * halfExtents[1] * fraction, axis[2]! * halfExtents[2] * fraction]));
      }
    }
    for (const sign of [1, -1] as const) {
      points.push(toWorld(center, ROTATED, [sign * halfExtents[0] * 0.7, sign * halfExtents[1] * 0.5, sign * halfExtents[2] * 0.3]));
      points.push(toWorld(center, ROTATED, [sign * halfExtents[0] * 0.2, sign * -halfExtents[1] * 0.8, sign * halfExtents[2] * 0.6]));
    }
    points.push(toWorld(center, ROTATED, [0.05, -0.05, 0.05])); // 中心近旁(最小轴判定敏感)
    const { maxErr } = goldenVsMirror({ center, radius: 0, rotation: ROTATED, halfExtents }, ROTATED_QUATERNION, points);
    expect(maxErr).toBeLessThanOrEqual(1e-5);
    console.log(`[quant] 旋转 cuboid 公式对拍(15 点): maxErr = ${maxErr.toExponential(3)}`);
  });

  it("锚点跳过:inverseMass=0 粒子在障碍内部保持原位(镜像与黄金同语义)", () => {
    const obstacle: SoftBodyGpuObstacle = { center: [0, 0, 0], radius: 1, rotation: IDENTITY, halfExtents: [0, 0, 0] };
    const state = packSoftBodyGpuParticles([
      { position: [0, 0, 0], velocity: [0, 0, 0], inverseMass: 0 }, // 锚点,深在障碍内
      { position: [0, 0, 0], velocity: [0, 0, 0], inverseMass: 1 }, // 同位置自由粒子 → 被推出
    ]);
    projectObstacle(state, obstacle);
    expect([state[0], state[1], state[2]]).toEqual([0, 0, 0]); // 锚点原位
    expect(Math.hypot(state[12]!, state[13]!, state[14]!)).toBeCloseTo(1, 5); // 自由粒子贴面
  });
});
