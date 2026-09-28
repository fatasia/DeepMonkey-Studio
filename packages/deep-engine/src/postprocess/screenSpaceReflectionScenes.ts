/**
 * T03 四组序列的解析视空间场景（镜面 / 粗糙金属 / 屏边 / 移动物）。
 * 相机在原点看 -z（视空间），主深度由逐像素解析射线求交生成——深度缓冲即几何真值，
 * 被测对象是"在真值数据上的步进/命中判定"，不是几何本身。
 * marchGroundTruthRef 是独立实现的参考步进（与 WGSL/CPU 镜像同规格、不同代码），
 * 用于误命中率与分档统计；平面场景另有闭式解 cross-check。
 */

import type { ScreenSpaceReflectionCpuInput, ScreenSpaceReflectionCpuOptions,
} from "./screenSpaceReflectionTypes.js";
import type { SsrMissReason } from "./screenSpaceReflectionFallback.js";

export interface SsrSceneOccluder {
  readonly x0: number; readonly x1: number;
  readonly y0: number; readonly y1: number;
  readonly z0: number; readonly z1: number;
}

/**
 * 斜面板：n·p = offset 的任意平面，法线朝向相机一侧（n·dir < 0 可见）。
 * 轴对齐镜面的反射在数学上只会渐近视锥边界而不穿出；斜面板的反射斜率可超界，
 * 是 off-screen 族的物理来源。
 */
export interface SsrScenePanel {
  readonly normal: readonly [number, number, number];
  readonly offset: number;
  readonly yTop: number;
  readonly zNear: number;
  readonly zFar: number;
}

export interface SsrSceneConfig {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** 全帧统一粗糙度（分档口径清晰化；产品按材质逐像素，此处固定变量数）。 */
  readonly roughness: number;
  /** 墙顶高度（视空间 y）；屏边序列调低使反射射线大量出屏。 */
  readonly wallTop: number;
  readonly occluder: SsrSceneOccluder | undefined;
  readonly panel?: SsrScenePanel | undefined;
}

export interface SsrSceneFrame {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly roughness: number;
  /** 正线性视空间深度；0 = 天空（无几何，回退档）。 */
  readonly depth: Float32Array;
  /** rgba8unorm 字节序：xyz=(n+1)/2×255，a=roughness×255（与 GBuffer 纹理一致）。 */
  readonly normalEncoded: Uint8Array;
  /** 线性 HDR rgb（全部 ≥0.06，使黑洞可检测）。 */
  readonly color: Float32Array;
  readonly cpuInput: ScreenSpaceReflectionCpuInput;
}

export const SSR_SEQUENCE_VERTICAL_FOV = Math.PI / 3;
const FLOOR_Y = -2, FLOOR_Z_NEAR = -1, WALL_Z = -30, SKY_Y = 18;

const bandColor = (index: number): readonly [number, number, number] => {
  const bands: readonly (readonly [number, number, number])[] = [
    [0.62, 0.14, 0.10], [0.10, 0.48, 0.66], [0.58, 0.52, 0.12], [0.12, 0.20, 0.55]];
  return bands[((index % bands.length) + bands.length) % bands.length]!;
};

/** 主射线求交：盒 → 斜面板 → 墙(z=WALL_Z, y∈[FLOOR_Y, wallTop]) → 地板(y=FLOOR_Y, z∈[Z_NEAR, WALL_Z]) → 天空。 */
export function primaryRaycast(config: SsrSceneConfig, x: number, y: number,
  tanHalfFov: number, aspect: number): { readonly t: number; readonly nx: number; readonly ny: number; readonly nz: number } {
  const uvX = (x + 0.5) / config.width, uvY = (y + 0.5) / config.height;
  const dirX = (uvX * 2 - 1) * tanHalfFov * aspect, dirY = (1 - uvY * 2) * tanHalfFov, dirZ = -1;
  const occluder = config.occluder;
  if (occluder) {
    const slab = (o: number, d: number, lo: number, hi: number): [number, number] =>
      d === 0 ? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY] : [(lo - o) / d, (hi - o) / d];
    const [xLo, xHi] = slab(0, dirX, occluder.x0, occluder.x1);
    const [yLo, yHi] = slab(0, dirY, occluder.y0, occluder.y1);
    const [zLo, zHi] = slab(0, dirZ, occluder.z0, occluder.z1);
    const tNear = Math.max(xLo, yLo, zLo), tFar = Math.min(xHi, yHi, zHi);
    if (tNear > 0 && tNear <= tFar) {
      const axis = tNear === xLo ? (dirX > 0 ? [-1, 0, 0] as const : [1, 0, 0] as const)
        : tNear === yLo ? (dirY > 0 ? [0, -1, 0] as const : [0, 1, 0] as const)
          : (dirZ > 0 ? [0, 0, -1] as const : [0, 0, 1] as const);
      return { t: tNear, nx: axis[0], ny: axis[1], nz: axis[2] };
    }
  }
  const panel = config.panel;
  if (panel) {
    const [pnx, pny, pnz] = panel.normal;
    const denominator = pnx * dirX + pny * dirY + pnz * dirZ;
    if (denominator < 0) { // 面朝相机一侧。
      const t = panel.offset / denominator;
      const hitY = dirY * t, hitZ = dirZ * t;
      if (t > 0 && hitY >= FLOOR_Y && hitY <= panel.yTop && hitZ <= panel.zNear && hitZ >= panel.zFar) {
        return { t, nx: pnx, ny: pny, nz: pnz };
      }
    }
  }
  if (dirZ < 0) {
    const t = WALL_Z / dirZ, hitY = dirY * t;
    if (hitY >= FLOOR_Y && hitY <= config.wallTop) return { t, nx: 0, ny: 0, nz: 1 };
  }
  if (dirY < 0) {
    const t = FLOOR_Y / dirY, hitZ = dirZ * t;
    if (hitZ <= FLOOR_Z_NEAR && hitZ >= WALL_Z) return { t, nx: 0, ny: 1, nz: 0 };
  }
  return { t: 0, nx: 0, ny: 0, nz: 1 }; // 天空。
}

/** 构建192内任意尺寸的确定性序列帧；法线/粗糙度与产品 GBuffer 同编码。 */
export function buildSsrSceneFrame(config: SsrSceneConfig): SsrSceneFrame {
  const tanHalfFov = Math.tan(SSR_SEQUENCE_VERTICAL_FOV * 0.5);
  const aspect = config.width / config.height;
  const depth = new Float32Array(config.width * config.height);
  const normalEncoded = new Uint8Array(config.width * config.height * 4);
  const color = new Float32Array(config.width * config.height * 3);
  const normals: number[] = new Array(config.width * config.height * 3);
  for (let y = 0; y < config.height; y++) {
    for (let x = 0; x < config.width; x++) {
      const index = y * config.width + x;
      const hit = primaryRaycast(config, x, y, tanHalfFov, aspect);
      depth[index] = hit.t;
      const encodedX = Math.round((hit.nx + 1) * 127.5), encodedY = Math.round((hit.ny + 1) * 127.5);
      const encodedZ = Math.round((hit.nz + 1) * 127.5), encodedA = Math.round(config.roughness * 255);
      normalEncoded.set([encodedX, encodedY, encodedZ, encodedA], index * 4);
      normals[index * 3] = encodedX / 255; normals[index * 3 + 1] = encodedY / 255;
      normals[index * 3 + 2] = encodedZ / 255;
      const rgb = hit.t === 0 ? [0.35, 0.50, 0.70] as const
        : hit.ny === 1 ? bandColor(Math.floor(hit.t / 4))
          : hit.nz === 1 ? bandColor(Math.floor(x / 5)) : bandColor(Math.floor(y / 3));
      color.set([rgb[0], rgb[1], rgb[2]], index * 3);
    }
  }
  return { name: config.name, width: config.width, height: config.height, roughness: config.roughness,
    depth, normalEncoded, color,
    cpuInput: { width: config.width, height: config.height, depth: Array.from(depth),
      normals, color: Array.from(color), roughness: new Array(config.width * config.height).fill(config.roughness) } };
}

export type SsrGroundTruthHit =
  | { readonly hit: true; readonly uvX: number; readonly uvY: number; readonly reason: "hit" }
  | { readonly hit: false; readonly uvX: number; readonly uvY: number; readonly reason: SsrMissReason };

/**
 * 独立参考步进（GT）：与 trace 同规格（步长/厚度/细化/出屏即止），但在真值深度缓冲上
 * 用独立代码实现，用于误命中率与 miss 分档；平面场景可用解析解交叉核对。
 */
export function marchGroundTruthRef(frame: SsrSceneFrame, options: ScreenSpaceReflectionCpuOptions,
  x: number, y: number): SsrGroundTruthHit {
  const tanHalfFov = Math.tan(options.verticalFovRadians * 0.5);
  const aspect = frame.width / frame.height;
  const centerDepth = frame.depth[y * frame.width + x] ?? 0;
  if (!(centerDepth > 0)) return { hit: false, uvX: 0, uvY: 0, reason: "no-origin" };
  const uvX0 = (x + 0.5) / frame.width, uvY0 = (y + 0.5) / frame.height;
  const ndcX = uvX0 * 2 - 1, ndcY = 1 - uvY0 * 2;
  const px = ndcX * centerDepth * tanHalfFov * aspect, py = ndcY * centerDepth * tanHalfFov, pz = -centerDepth;
  const base = (y * frame.width + x) * 4;
  const nx = ((frame.normalEncoded[base] ?? 0) / 255) * 2 - 1;
  const ny = ((frame.normalEncoded[base + 1] ?? 0) / 255) * 2 - 1;
  const nz = ((frame.normalEncoded[base + 2] ?? 0) / 255) * 2 - 1;
  const incident = [px / centerDepth, py / centerDepth, pz / centerDepth];
  const length = Math.hypot(incident[0]!, incident[1]!, incident[2]!);
  incident[0] = incident[0]! / length; incident[1] = incident[1]! / length; incident[2] = incident[2]! / length;
  const dot = nx * incident[0]! + ny * incident[1]! + nz * incident[2]!;
  const rx = incident[0]! - 2 * dot * nx, ry = incident[1]! - 2 * dot * ny, rz = incident[2]! - 2 * dot * nz;
  if (rz >= 0) return { hit: false, uvX: 0, uvY: 0, reason: "reflected-behind" };
  const project = (qx: number, qy: number, qz: number): readonly [number, number, number] => {
    const depth = -qz;
    return [(qx / (depth * tanHalfFov * aspect) + 1) / 2, (1 - qy / (depth * tanHalfFov)) / 2, depth];
  };
  const sample = (uvX: number, uvY: number): number => {
    const sx = Math.min(Math.max(Math.floor(uvX * frame.width), 0), frame.width - 1);
    const sy = Math.min(Math.max(Math.floor(uvY * frame.height), 0), frame.height - 1);
    return frame.depth[sy * frame.width + sx] ?? 0;
  };
  const stepLength = options.maxDistance / options.steps;
  for (let step = 1; step <= options.steps; step++) {
    const distance = step * stepLength;
    const qx = px + rx * distance, qy = py + ry * distance, qz = pz + rz * distance;
    const projected = project(qx, qy, qz);
    if (projected[2] <= 0) return { hit: false, uvX: 0, uvY: 0, reason: "ray-depth-guard" };
    if (projected[0] < 0 || projected[0] > 1 || projected[1] < 0 || projected[1] > 1) {
      return { hit: false, uvX: 0, uvY: 0, reason: "off-screen" };
    }
    const surfaceDepth = sample(projected[0], projected[1]);
    if (surfaceDepth > 0 && surfaceDepth < projected[2] && projected[2] - surfaceDepth < options.thickness) {
      let low = distance - stepLength, high = distance;
      for (let refine = 0; refine < options.refines; refine++) {
        const middle = (low + high) / 2;
        const [mu, mv, mDepth] = project(px + rx * middle, py + ry * middle, pz + rz * middle);
        const refined = sample(mu, mv);
        if (refined > 0 && refined < mDepth) high = middle; else low = middle;
      }
      const final = (low + high) / 2;
      const [fu, fv] = project(px + rx * final, py + ry * final, pz + rz * final);
      if (sample(fu, fv) <= 0) continue; // 终点落空洞，拒绝该候选并继续（同深度空洞修复语义）。
      return { hit: true, uvX: fu, uvY: fv, reason: "hit" };
    }
  }
  return { hit: false, uvX: 0, uvY: 0, reason: "step-exhausted" };
}
