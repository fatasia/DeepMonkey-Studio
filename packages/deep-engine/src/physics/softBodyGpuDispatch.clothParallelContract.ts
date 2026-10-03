/**
 * F6 接线清单① 布料 GPU 并行核 合同层(sourceSizeGate 拆分:自
 * softBodyGpuDispatch.clothParallel.ts 按职责分文件,代码逐行同源,仅改可见性;
 * 语义零变化。消费方仍从 softBodyGpuDispatch.clothParallel.js 导入,本文件不直接对外)。
 *
 * 职责:静态障碍 ABI(sphere/cuboid 64×80B)、并行核单 tick 结果/换核开关/回退原因/
 * 遥测计数口径类型、带 reason 的并行侧失败错误、理论 dispatch 数公式。
 */
import type { ClothGpuDispatchResult } from "./softBodyGpuDispatch.js";

/** F6/T18 静态障碍(GPU):sphere(radius>0)或 cuboid OBB;行主序旋转与
 * softBodyStaticCollision.ts 同构。上限 64(与 CPU 端接触预算一致)。 */
export interface ClothGpuObstacle {
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly rotation: readonly [number, number, number, number, number, number, number, number, number];
  readonly halfExtents: readonly [number, number, number];
}

export const CLOTH_GPU_MAX_OBSTACLES = 64;

export function packClothGpuObstacles(obstacles: readonly ClothGpuObstacle[]): ArrayBuffer {
  if (obstacles.length > CLOTH_GPU_MAX_OBSTACLES) {
    throw new Error(`Cloth parallel GPU obstacles exceed budget ${CLOTH_GPU_MAX_OBSTACLES}, got ${obstacles.length}.`);
  }
  const out = new ArrayBuffer(CLOTH_GPU_MAX_OBSTACLES * 80);
  const floats = new Float32Array(out);
  obstacles.forEach((obstacle, index) => {
    const base = index * 20;
    floats[base] = Math.fround(obstacle.center[0]);
    floats[base + 1] = Math.fround(obstacle.center[1]);
    floats[base + 2] = Math.fround(obstacle.center[2]);
    floats[base + 3] = Math.fround(obstacle.radius); // Obstacle.center.w = radius(WGSL sphere 分支读此槽)
    for (let r = 0; r < 9; r += 1) floats[base + 4 + r] = Math.fround(obstacle.rotation[r]!);
    // WGSL Obstacle 布局:halfExtents 是第 5 个 vec4f(槽 16..19);槽 19 是 sphere/cuboid
    // 判别式(halfExtents.w > 0 = sphere)。旧实现写槽 13..15(落在 row2.w/padding)且
    // 判别式恒 0 → sphere 被当退化 cuboid(零盒 inside 恒 false)→ projectObstacles 静默无效应
    // (C8 定位批 softbody-divergence-20261002 真机逐子步定位)。
    floats[base + 16] = Math.fround(obstacle.halfExtents[0]);
    floats[base + 17] = Math.fround(obstacle.halfExtents[1]);
    floats[base + 18] = Math.fround(obstacle.halfExtents[2]);
    floats[base + 19] = obstacle.radius > 0 ? Math.fround(obstacle.radius) : 0;
  });
  return out;
}

/** 并行核单 tick 结果:布局同串行(12 floats/粒子),附带编排计数供遥测与量化。 */
export interface ClothParallelDispatchResult {
  readonly state: Float32Array;
  /** 本 tick compute dispatch 数 = substeps×(2+colorCount);串行路径恒为 1。 */
  readonly dispatchCount: number;
  readonly colorCount: number;
}

export type ClothKernelChoice = "parallel-first" | "serial";
export type ClothKernelUsed = "cloth-parallel" | "cloth-serial";

/** 回退原因(三态,均有独立遥测计数;显式选串行不是回退,不计入)。 */
export type ClothKernelFallbackReason =
  /** 着色 fail-closed:≥32 色(超 u32 掩码/核合同)或退化约束(a===b)。串行核无着色,可安全接管。 */
  | "coloring-unavailable"
  /** 并行核 shader module 创建/编译失败(设备不支持该 WGSL 形态)。 */
  | "wgsl-compile-error"
  /** 管线创建、提交、readback 映射等设备侧失败(含 device lost 中途暴露)。 */
  | "gpu-error";

export interface ClothKernelSwitchResult extends ClothGpuDispatchResult {
  readonly kernel: ClothKernelUsed;
  readonly dispatchCount: number;
  /** 并行核着色数;串行路径为 0。 */
  readonly colorCount: number;
  /** 非空 = 本次由并行核回退到串行核,值为原因。 */
  readonly fallbackReason: ClothKernelFallbackReason | null;
}

/** 带 reason 的并行侧失败:换核开关据此精确计数,未知异常归入 gpu-error。 */
export class ClothParallelDispatchError extends Error {
  readonly reason: ClothKernelFallbackReason;
  constructor(reason: ClothKernelFallbackReason, message: string) {
    super(message);
    this.name = "ClothParallelDispatchError";
    this.reason = reason;
  }
}

export interface ClothKernelSwitchTelemetry {
  readonly parallelSteps: number;
  /** 走串行核的步数 = 显式选择 + 回退(二者之和)。 */
  readonly serialSteps: number;
  readonly fallbacksByReason: Readonly<Record<ClothKernelFallbackReason, number>>;
  readonly lastFallbackReason: ClothKernelFallbackReason | null;
}

/** 并行 tick 的理论 dispatch 数(量化口径:substeps×(2+色数);串行恒 1)。 */
export function clothParallelDispatchCount(substeps: number, colorCount: number): number {
  return substeps * (2 + colorCount);
}
