/**
 * T05 验收切片共享夹具：带洞遮挡墙场景（重叠墙块 + 远景背板，避免背景 clear 值泄入
 * Hi-Z mip 区）。仅供参考集/边界矩阵测试导入；不是测试文件。
 */

import { lookAtView, multiplyMatrix, perspectiveProjection,
  type ReferenceGeometry, type ReferenceInstance } from "./instanceVisibilityReference.js";
import type { TwinView } from "./instanceVisibilityTwin.js";

export const VIEWPORT = [320, 180] as const, NEAR = 1, FAR = 120, FOV = Math.PI / 4;

export function quadGeometry(): ReferenceGeometry {
  const vertices = new Float32Array([-1, -1, 0, 0, 0, 1, 1, -1, 0, 0, 0, 1, -1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1]);
  return { vertices, indices: new Uint32Array([0, 1, 2, 2, 1, 3]) };
}

export function viewProjection(eye: readonly [number, number, number], target: readonly [number, number, number],
  reversedZ = false): Float32Array {
  const f = 1 / Math.tan(FOV / 2), aspect = VIEWPORT[0]! / VIEWPORT[1]!;
  const projection = reversedZ
    ? new Float64Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, NEAR / (FAR - NEAR), -1, 0, 0, NEAR * FAR / (FAR - NEAR), 0])
    : perspectiveProjection(FOV, aspect, NEAR, FAR);
  return Float32Array.from(multiplyMatrix(projection, lookAtView(eye, target, [0, 1, 0])));
}

export function transform(x: number, y: number, z: number, scale = 1, mirrorX = false): Float32Array {
  return Float32Array.from([mirrorX ? -scale : scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1]);
}

export interface SceneOptions {
  readonly mirrorX?: boolean;
  readonly translate?: readonly [number, number, number];
  readonly frontBlend?: boolean;
}

/** 墙洞场景：96 墙块（10×10 缺中心 2×2，相邻重叠无缝，覆盖全视口）+ 16 目标（4 个可穿洞）
 * + 60 填充 + 1 背板 = 173 实例。墙覆盖出视口边缘，包围球角采样无法「绕过」墙体看见背板
 * （除洞区），使 Hi-Z 遮挡在场景上真实可行使；最外圈填充的包围球越出墙缘 → 保守保留样本。 */
export function scene(options: SceneOptions = {}): { instances: ReferenceInstance[]; targetIds: number[] } {
  const [tx, ty, tz] = options.translate ?? [0, 0, 0];
  const instances: ReferenceInstance[] = [];
  const targetIds: number[] = [];
  const push = (x: number, y: number, z: number, scale: number, opaque = true): number => {
    instances.push({ transform: transform(x + tx, y + ty, z + tz, scale, options.mirrorX === true), opaque });
    return instances.length - 1;
  };
  // 墙块 3.4 宽、间距 3.2：0.2 重叠保证 Hi-Z mip 区域无背景缝；中心 2×2 缺口 ≈ 6.2 宽洞。
  for (let row = 0; row < 10; row++) for (let column = 0; column < 10; column++) {
    if ((column === 4 || column === 5) && (row === 4 || row === 5)) continue;
    push((column - 4.5) * 3.2, (row - 4.5) * 3.2, 0, 1.7);
  }
  for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
    targetIds.push(push((column - 1.5) * 3.2, (row - 1.5) * 3.2, -8, 0.6));
  }
  for (let index = 0; index < 60; index++) {
    push(((index % 10) - 4.5) * 6, (Math.floor(index / 10) - 2.5) * 6, -24, 2);
  }
  push(0, 0, -40, 40); // 远景背板：填充缝隙与洞区的深度，避免 clear 值 1 泄入金字塔。
  if (options.frontBlend === true) push(0, 0, 12, 3.5, false);
  return { instances, targetIds };
}

export function twinViewOf(viewProjection: Float32Array, eye: readonly [number, number, number] = [0, 0, 30],
  reversedZ = false): TwinView {
  return { viewProjection, cameraPosition: eye.map(Math.fround) as [number, number, number],
    viewport: VIEWPORT, reversedZ };
}
