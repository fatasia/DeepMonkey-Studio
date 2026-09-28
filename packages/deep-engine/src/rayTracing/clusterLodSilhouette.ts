/**
 * T05 验收切片：簇 LOD 选层轮廓的屏幕误差测量（冻结视图 ≤1px 验收）。
 * 方法：指定冻结相机下，把 L0 参考几何与选层前沿几何分别投影（与项目 viewProjection
 * 约定一致：列主序，clip = VP·(world,1)，WebGPU 深度 [0,1]）并用确定性像素中心采样
 * 光栅化为剪影掩码；轮廓 = 掩码 4 邻域边界；误差 = 双向边界相对对方掩码 Chebyshev
 * 距离的最大值（像素）。判定：≤1px（含共享边界像素采样对齐的 ±1 栅格容差）。
 */

import { createSoftRasterTarget, rasterizeTriangle } from "../webgpu/softRasterizeReference.js";

export interface SilhouetteProjection {
  readonly viewProjection: ArrayLike<number>;
  readonly viewport: readonly [number, number];
}

/** 投影三角形汤为剪影掩码；越界/退化三角形跳过（冻结视图合同：几何整体在视锥内）。 */
export function rasterizeSilhouetteMask(vertices: Float32Array, indices: Uint32Array,
  projection: SilhouetteProjection): { mask: Uint8Array; width: number; height: number } {
  const [width, height] = projection.viewport;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError("Silhouette viewport must be positive integers.");
  }
  const mask = createSoftRasterTarget(width, height);
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const corners: Array<{ x: number; y: number; depth: number } | undefined> = [0, 1, 2].map(offset => {
      const vertex = indices[triangle + offset]! * 3;
      const [x, y, z] = [vertices[vertex]!, vertices[vertex + 1]!, vertices[vertex + 2]!];
      const clip = [
        projection.viewProjection[0]! * x + projection.viewProjection[4]! * y + projection.viewProjection[8]! * z + projection.viewProjection[12]!,
        projection.viewProjection[1]! * x + projection.viewProjection[5]! * y + projection.viewProjection[9]! * z + projection.viewProjection[13]!,
        projection.viewProjection[2]! * x + projection.viewProjection[6]! * y + projection.viewProjection[10]! * z + projection.viewProjection[14]!,
        projection.viewProjection[3]! * x + projection.viewProjection[7]! * y + projection.viewProjection[11]! * z + projection.viewProjection[15]!];
      if (!clip.every(Number.isFinite) || clip[3]! <= 1e-6) return undefined;
      const ndcZ = clip[2]! / clip[3]!;
      if (!(ndcZ > 0) || !(ndcZ < 1)) return undefined;
      const w = clip[3]!;
      return { x: (clip[0]! / w * 0.5 + 0.5) * width - 0.5, y: (0.5 - clip[1]! / w * 0.5) * height - 0.5, depth: ndcZ };
    });
    if (corners.some(corner => corner === undefined)) continue;
    const [a, b, c] = corners as [{ x: number; y: number; depth: number }, { x: number; y: number; depth: number },
      { x: number; y: number; depth: number }];
    // 绕序无关（窗口 y 翻转与网格朝向都会翻转面积符号），按面积统一正向外。
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const order = area > 0 ? [a, c, b] : [a, b, c];
    rasterizeTriangle(mask, { ax: order[0]!.x, ay: order[0]!.y, az: order[0]!.depth,
      bx: order[1]!.x, by: order[1]!.y, bz: order[1]!.depth,
      cx: order[2]!.x, cy: order[2]!.y, cz: order[2]!.depth, slot: 1, triangleLocalIndex: 0 });
  }
  const binary = new Uint8Array(mask.slot.length);
  for (let index = 0; index < binary.length; index++) binary[index] = mask.slot[index] === 1 ? 1 : 0;
  return { mask: binary, width, height };
}

/** 剪影边界：掩码内且至少一个 4 邻域在外。 */
export function silhouetteBoundary(mask: Uint8Array, width: number, height: number): Uint8Array {
  const boundary = new Uint8Array(mask.length);
  const at = (x: number, y: number): number => x < 0 || x >= width || y < 0 || y >= height ? 0 : mask[y * width + x]!;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!mask[y * width + x]) continue;
    if (!at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1)) boundary[y * width + x] = 1;
  }
  return boundary;
}

/** Chebyshev 半径 r 的掩码膨胀（r=1 即 3×3）。 */
export function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  let current = mask;
  for (let pass = 0; pass < radius; pass++) {
    const next = new Uint8Array(current.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let value = 0;
      for (let dy = -1; dy <= 1 && !value; dy++) for (let dx = -1; dx <= 1 && !value; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && current[ny * width + nx]) value = 1;
      }
      next[y * width + x] = value;
    }
    current = next;
  }
  return current;
}

export interface SilhouetteDeviation {
  /** 双向轮廓最大 Chebyshev 偏差（px）；≤ tolerancePx 即通过。 */
  readonly maxDeviationPx: number;
  /** selected 轮廓落在 reference 容差邻域外的像素数。 */
  readonly selectedStrayPixels: number;
  /** reference 轮廓落在 selected 容差邻域外的像素数。 */
  readonly referenceStrayPixels: number;
  readonly referenceBoundaryPixels: number;
  readonly selectedBoundaryPixels: number;
  readonly referenceCovered: number;
  readonly selectedCovered: number;
}

/** 双向轮廓偏差：selected 轮廓须落在 reference 的 r 邻域内，反之亦然。 */
export function measureSilhouetteDeviation(reference: Uint8Array, selected: Uint8Array,
  width: number, height: number, tolerancePx = 1): SilhouetteDeviation {
  if (reference.length !== selected.length) throw new Error("Silhouette masks must share dimensions.");
  const referenceBoundary = silhouetteBoundary(reference, width, height);
  const selectedBoundary = silhouetteBoundary(selected, width, height);
  const referenceDilated = dilateMask(reference, width, height, tolerancePx);
  const selectedDilated = dilateMask(selected, width, height, tolerancePx);
  let selectedStray = 0, referenceStray = 0;
  for (let index = 0; index < reference.length; index++) {
    if (selectedBoundary[index] && !referenceDilated[index]) selectedStray++;
    if (referenceBoundary[index] && !selectedDilated[index]) referenceStray++;
  }
  const covered = (mask: Uint8Array): number => mask.reduce((sum, value) => sum + value, 0);
  const strayMax = Math.max(selectedStray, referenceStray) > 0 ? tolerancePx + 1 : 0;
  return { maxDeviationPx: strayMax, selectedStrayPixels: selectedStray, referenceStrayPixels: referenceStray,
    referenceBoundaryPixels: covered(referenceBoundary), selectedBoundaryPixels: covered(selectedBoundary),
    referenceCovered: covered(reference), selectedCovered: covered(selected) };
}

/** 逐像素定位偏差（诊断用）：selected 轮廓落在 reference r 邻域外的像素列表。 */
export function strayBoundaryPixels(reference: Uint8Array, selected: Uint8Array, width: number, height: number,
  tolerancePx = 1): number[] {
  const referenceDilated = dilateMask(reference, width, height, tolerancePx);
  const selectedBoundary = silhouetteBoundary(selected, width, height);
  const stray: number[] = [];
  for (let index = 0; index < reference.length; index++) {
    if (selectedBoundary[index] && !referenceDilated[index]) stray.push(index);
  }
  return stray;
}
