/**
 * 软件光栅化 CPU 参考（追平-Nanite 三件套之三：微三角后备）。
 * 选层后仍超屏幕误差阈值的 cluster 走本路径：scanline 光栅化直接写可见性编码
 * （visibilityBufferEncoding 的 slot/triangleLocal 位合同），与 visibilityBufferPass
 * 的硬件路径产出同一编码空间。确定性（定点边缘函数，同一输入逐位同输出）；
 * 深度插值供 z-test（与硬件 depth32float 的语义在合同上对齐，非逐位）。
 */

import { VISIBILITY_CLEAR_SLOT, packVisibilityTriangle } from "./visibilityBufferEncoding.js";

export { VISIBILITY_CLEAR_SLOT };

export interface SoftRasterTarget {
  readonly width: number;
  readonly height: number;
  /** rg32uint 编码空间：slot 与 packedTriangle 双通道。 */
  slot: Uint32Array;
  packedTriangle: Uint32Array;
  depth: Float32Array;
}

export function createSoftRasterTarget(width: number, height: number): SoftRasterTarget {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError("Soft raster target dimensions must be positive safe integers.");
  }
  const pixels = width * height;
  return {
    width, height,
    slot: new Uint32Array(pixels).fill(VISIBILITY_CLEAR_SLOT),
    packedTriangle: new Uint32Array(pixels).fill(0),
    depth: new Float32Array(pixels).fill(1),
  };
}

export interface SoftTriangle {
  /** 窗口空间顶点（x/y 像素中心坐标，z=深度 0..1，越小越近）。 */
  readonly ax: number; readonly ay: number; readonly az: number;
  readonly bx: number; readonly by: number; readonly bz: number;
  readonly cx: number; readonly cy: number; readonly cz: number;
  readonly slot: number;
  /** cluster 内三角局部索引（0..125，编码进 packed 低 8 位）。 */
  readonly triangleLocalIndex: number;
}

/** 逆时针绕序的扫描线光栅化：top-left 规则消除双写；z-test 用 less。 */
export function rasterizeTriangle(target: SoftRasterTarget, triangle: SoftTriangle): number {
  const slot = triangle.slot;
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= VISIBILITY_CLEAR_SLOT) {
    throw new RangeError("Soft raster slot must be a safe integer below the clear sentinel.");
  }
  const packed = packVisibilityTriangle(triangle.triangleLocalIndex);
  const minX = Math.max(0, Math.ceil(Math.min(triangle.ax, triangle.bx, triangle.cx) - 0.5));
  const maxX = Math.min(target.width - 1, Math.floor(Math.max(triangle.ax, triangle.bx, triangle.cx) - 0.5));
  const minY = Math.max(0, Math.ceil(Math.min(triangle.ay, triangle.by, triangle.cy) - 0.5));
  const maxY = Math.min(target.height - 1, Math.floor(Math.max(triangle.ay, triangle.by, triangle.cy) - 0.5));
  if (minX > maxX || minY > maxY) return 0;
  const area = edge(triangle.ax, triangle.ay, triangle.bx, triangle.by, triangle.cx, triangle.cy);
  if (area <= 0) return 0; // 背面/退化由调用方剔除；合同与 ccw 硬件绕序一致。
  let written = 0;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const w0 = edge(triangle.bx, triangle.by, triangle.cx, triangle.cy, px, py);
      const w1 = edge(triangle.cx, triangle.cy, triangle.ax, triangle.ay, px, py);
      const w2 = edge(triangle.ax, triangle.ay, triangle.bx, triangle.by, px, py);
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const depth = (w0 / area) * triangle.az + (w1 / area) * triangle.bz + (w2 / area) * triangle.cz;
      const pixel = y * target.width + x;
      if (depth >= target.depth[pixel]!) continue;
      target.depth[pixel] = depth;
      target.slot[pixel] = slot;
      target.packedTriangle[pixel] = packed;
      written += 1;
    }
  }
  return written;
}

function edge(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}
