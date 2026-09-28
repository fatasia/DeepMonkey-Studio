/**
 * T05 验收切片：引擎剔除链的 CPU 孪生合成（视锥核 + Hi-Z 遮挡核）。
 * 语义单源仍是 WGSL（GPU_FRUSTUM_CULL_WGSL / HI_Z_OCCLUSION_WGSL）；本文件只把官方孪生
 * （cpuFrustumCull、projectHiZOcclusionAabb、hiZOcclusionVisible）与 worldSphere 的
 * f64 镜像组合成「引擎保留集」，供 instanceVisibilityReference 对拍零漏剔。
 * 分支合同复刻 PacketCullingResources.encode：<64 实例整批直绘不剔除；遮挡激活
 * （opaque + previousHiZ）且 ≥128 实例走 Hi-Z 核（含自身屏幕矩形剔除），否则视锥核。
 */

import { cpuFrustumCull, type CullingInstance } from "./gpuFrustumPacking.js";
import { viewProjectionFrustum } from "./pbrFrusta.js";
import { hiZOcclusionVisible, projectHiZOcclusionAabb } from "./hiZOcclusionProjection.js";

export interface TwinBoundsEntry {
  readonly transform: ArrayLike<number>;
  readonly bounds: readonly [number, number, number, number];
}

export interface TwinView {
  /** 16 列主序，Float32Array（生产 ABI 是 f32；对拍输入与引擎同源）。 */
  readonly viewProjection: Float32Array;
  readonly cameraPosition: readonly [number, number, number];
  readonly viewport: readonly [number, number];
  readonly reversedZ: boolean;
}

export interface DepthPyramid {
  readonly levels: ReadonlyArray<{ readonly width: number; readonly height: number; readonly data: Float32Array }>;
  readonly mipLevelCount: number;
}

/**
 * WGSL worldSphere 的 f64 镜像：仿射变换球的支撑半径
 * r·‖A‖ 满足 σ² 界（Gershgorin 与 inf·1 范数取小），加上 f32 点积误差余量。
 * 实例行为 f32 时调用方先用 Float32Array 量化（与引擎上传同源）再进入本镜像。
 */
export function worldSphereOf(transform: ArrayLike<number>, bounds: readonly [number, number, number, number]):
  readonly [number, number, number, number] {
  const [x, y, z, radius] = bounds;
  const row = (index: number) => [transform[index]!, transform[index + 4]!, transform[index + 8]!, transform[index + 12]!] as const;
  const r0 = row(0), r1 = row(1), r2 = row(2);
  const center = [r0[0]! * x + r0[1]! * y + r0[2]! * z + r0[3]!,
    r1[0]! * x + r1[1]! * y + r1[2]! * z + r1[3]!, r2[0]! * x + r2[1]! * y + r2[2]! * z + r2[3]!] as const;
  const largest = [Math.max(Math.abs(r0[0]!), Math.abs(r1[0]!), Math.abs(r2[0]!)),
    Math.max(Math.abs(r0[1]!), Math.abs(r1[1]!), Math.abs(r2[1]!)),
    Math.max(Math.abs(r0[2]!), Math.abs(r1[2]!), Math.abs(r2[2]!))];
  const magnitude = Math.max(...largest);
  let stretch = 0;
  if (magnitude > 0) {
    // 先归一再组合，避免大坐标下 AᵀA 溢出（与 WGSL 同序）。
    const a = [r0[0]! / magnitude, r0[1]! / magnitude, r0[2]! / magnitude] as const;
    const b = [r1[0]! / magnitude, r1[1]! / magnitude, r1[2]! / magnitude] as const;
    const c = [r2[0]! / magnitude, r2[1]! / magnitude, r2[2]! / magnitude] as const;
    const columnX = [a[0], b[0], c[0]] as const, columnY = [a[1], b[1], c[1]] as const, columnZ = [a[2], b[2], c[2]] as const;
    const absDot = (u: readonly number[], v: readonly number[]) =>
      Math.abs(u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!);
    const xy = absDot(columnX, columnY), xz = absDot(columnX, columnZ), yz = absDot(columnY, columnZ);
    const self = (u: readonly number[]) => u[0]! * u[0]! + u[1]! * u[1]! + u[2]! * u[2]!;
    const gramBound = Math.max(self(columnX) + xy + xz, self(columnY) + xy + yz, self(columnZ) + xz + yz);
    const absRow = (u: readonly number[]) => [Math.abs(u[0]!), Math.abs(u[1]!), Math.abs(u[2]!)] as const;
    const a0 = absRow(a), b0 = absRow(b), c0 = absRow(c);
    const normInf = Math.max(a0[0]! + a0[1]! + a0[2]!, b0[0]! + b0[1]! + b0[2]!, c0[0]! + c0[1]! + c0[2]!);
    const normOne = Math.max(a0[0]! + b0[0]! + c0[0]!, a0[1]! + b0[1]! + c0[1]!, a0[2]! + b0[2]! + c0[2]!);
    stretch = magnitude * Math.sqrt(Math.max(Math.min(normInf * normOne, gramBound), 0)) * 1.000002;
  }
  const centerError = Math.hypot(
    Math.abs(r0[0]!) * Math.abs(x) + Math.abs(r0[1]!) * Math.abs(y) + Math.abs(r0[2]!) * Math.abs(z),
    Math.abs(r1[0]!) * Math.abs(x) + Math.abs(r1[1]!) * Math.abs(y) + Math.abs(r1[2]!) * Math.abs(z),
    Math.abs(r2[0]!) * Math.abs(x) + Math.abs(r2[1]!) * Math.abs(y) + Math.abs(r2[2]!) * Math.abs(z)) * 0.000002;
  return [center[0], center[1], center[2], radius * stretch + centerError];
}

/**
 * 从参考深度构建 Hi-Z 金字塔：reversedZ 用 min（存最远），否则 max。
 * 窗口合同镜像生产 hiZReduceVariable：texel t 覆盖源 [⌊t·src/dst⌋, ⌈(t+1)·src/dst⌉)，
 * 非 2 幂尺寸不丢尾行/尾列（朴素 2× 缩减会漏掉尾带并造成错误漏剔——本轮实测抓到）。
 */
export function buildDepthPyramid(depth: Float32Array, width: number, height: number, reversedZ: boolean): DepthPyramid {
  const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const levels: { width: number; height: number; data: Float32Array }[] = [{ width, height, data: depth }];
  for (let level = 1; level < mipLevelCount; level++) {
    const previous = levels[level - 1]!;
    const reduced = { width: Math.max(1, Math.floor(previous.width / 2)),
      height: Math.max(1, Math.floor(previous.height / 2)),
      data: new Float32Array(Math.max(1, Math.floor(previous.width / 2)) * Math.max(1, Math.floor(previous.height / 2))) };
    const window = (index: number, source: number, target: number): [number, number] =>
      [Math.min(Math.floor(index * source / target), source - 1),
        Math.min(Math.ceil((index + 1) * source / target), source)];
    for (let row = 0; row < reduced.height; row++) for (let column = 0; column < reduced.width; column++) {
      const [y0, y1] = window(row, previous.height, reduced.height);
      const [x0, x1] = window(column, previous.width, reduced.width);
      let value = reversedZ ? Infinity : -Infinity;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const sample = previous.data[y * previous.width + x]!;
        value = reversedZ ? Math.min(value, sample) : Math.max(value, sample);
      }
      reduced.data[row * reduced.width + column] = value;
    }
    levels.push(reduced);
  }
  return { levels, mipLevelCount };
}

export interface TwinOcclusionOptions {
  readonly depthBias?: number;
  readonly nearClipEpsilon?: number;
}

/**
 * HI_Z_OCCLUSION_WGSL testOcclusion 的孪生判定：true = 保留。
 * fail-open（相机在球内/裁剪边界/采样越界）一律保留，与 kernel 相同。
 */
export function engineTwinHiZKept(sphere: readonly [number, number, number, number], view: TwinView,
  pyramid: DepthPyramid, options: TwinOcclusionOptions = {}): boolean {
  const projection = projectHiZOcclusionAabb([sphere[0], sphere[1], sphere[2]], sphere[3], view.viewProjection,
    view.cameraPosition, view.viewport, pyramid.mipLevelCount, view.reversedZ, options.nearClipEpsilon ?? 1e-5);
  if (!projection.testable) return projection.culled !== true;
  const level = pyramid.levels[projection.mip!]!;
  const sample = (u: number, v: number): number => {
    const texel = [Math.min(Math.floor(u * level.width), level.width - 1),
      Math.min(Math.floor(v * level.height), level.height - 1)] as const;
    return level.data[texel[1] * level.width + texel[0]]!;
  };
  const uv = projection.uvRect!;
  return hiZOcclusionVisible(projection.objectNearDepth!, [sample(uv[0], uv[1]), sample(uv[2], uv[1]),
    sample(uv[0], uv[3]), sample(uv[2], uv[3])], view.reversedZ, options.depthBias ?? 0.0005);
}

export interface TwinBatchOptions extends TwinOcclusionOptions {
  /** 复刻 PacketCullingResources.encode：opaque + previousHiZ 时遮挡参与。 */
  readonly occlusionActive?: boolean;
  readonly gpuCullingMinInstances?: number;
  readonly hiZOcclusionMinInstances?: number;
}

/** 整批引擎保留集（0/1），分支与 PacketCullingResources.encode 一致。 */
export function engineTwinBatchKept(entries: readonly TwinBoundsEntry[], view: TwinView, pyramid: DepthPyramid,
  options: TwinBatchOptions = {}): Uint8Array {
  const gpuMin = options.gpuCullingMinInstances ?? 64;
  const hiZMin = options.hiZOcclusionMinInstances ?? 128;
  const kept = new Uint8Array(entries.length);
  if (entries.length < gpuMin) { kept.fill(1); return kept; }
  const occlusion = options.occlusionActive === true && entries.length >= hiZMin;
  if (!occlusion) {
    const cullingInstances: CullingInstance[] = entries.map(entry => ({
      modelMatrix: Array.from(entry.transform), bounds: entry.bounds }));
    for (const index of cpuFrustumCull(cullingInstances, viewProjectionFrustum(view.viewProjection))) kept[index] = 1;
    return kept;
  }
  for (const [index, entry] of entries.entries()) {
    kept[index] = engineTwinHiZKept(worldSphereOf(entry.transform, entry.bounds), view, pyramid, options) ? 1 : 0;
  }
  return kept;
}
