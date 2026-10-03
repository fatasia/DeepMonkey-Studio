import { lookAt, multiply, orthographic } from "../webgpu/cameraMath.js";
import type { ShadowVec3 } from "./types.js";

/**
 * B1 Brief-VSM 三环 clipmap 虚拟阴影 —— CPU 规划器(纯数学,零运行时依赖)。
 *
 * 结构(UE VSM 的 clipmap 形态,非 per-light face):
 * - 三环(近/中/远)同锚点正交光空间,环 r 世界边长 = baseRingExtent × scale^r;
 * - 每环虚拟分辨率 16384²(VIRTUAL_EDGE),页 128²( mip 0 每环 128×128 页,
 *   mip k 页覆盖 2^k×2^k 个 mip0 页,顶 mip 单页覆盖全环 —— 顶页驻留保证零洞回退叶);
 * - 环中心按本环 texel 网格吸附(移动以整 texel 步进,已物化页内容保持世界对齐);
 * - 采样自近向远回退:环内缺页回退上一环,顶 mip 恒驻留 ⇒ 覆盖域内像素无洞。
 *
 * 与 cascadedShadowPlanner 同源约定:WebGPU 0..1 深度、正交光空间、texel 吸附;
 * 深度归一化 = ndc.z(光空间 depthSpan 上 0..1),物化与采样两侧同一合同。
 */

export const VIRTUAL_SHADOW_RING_COUNT = 3;
/** 每环虚拟分辨率(边长,texel)。 */
export const VIRTUAL_SHADOW_VIRTUAL_EDGE = 16_384;
/** 物理页边长(texel);与页池 atlas 的 slot 尺寸一致。 */
export const VIRTUAL_SHADOW_PAGE_EDGE = 128;
/** mip0 每环页网格边长(= VIRTUAL_EDGE / PAGE_EDGE)。 */
export const VIRTUAL_SHADOW_PAGE_GRID = VIRTUAL_SHADOW_VIRTUAL_EDGE / VIRTUAL_SHADOW_PAGE_EDGE;
/** 每环 mip 链长(顶 mip = 单页覆盖全环;mip 0..MAX-1)。 */
export const VIRTUAL_SHADOW_MIP_COUNT = Math.round(Math.log2(VIRTUAL_SHADOW_PAGE_GRID)) + 1;
/** 顶 mip 下标(mip 链最后一层,单页)。 */
export const VIRTUAL_SHADOW_TOP_MIP = VIRTUAL_SHADOW_MIP_COUNT - 1;

const MAX_DISTANCE = 1_000_000;
const DEFAULTS = Object.freeze({
  ringCount: VIRTUAL_SHADOW_RING_COUNT,
  ringExtentScale: 2,
  depthPadding: 10,
  baseRingExtentFactor: 2,
});

export interface VirtualShadowClipmapCamera {
  readonly eye: ShadowVec3;
  readonly target: ShadowVec3;
  readonly up?: ShadowVec3;
  readonly verticalFovRadians: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  /** 主视可见世界尺度(同 RenderView.extent 口径,环边长基线)。 */
  readonly extent: number;
}

export interface VirtualShadowClipmapOptions {
  /** 环数(默认 3,允许 1..4;>3 时调度侧仍只取前三环消费)。 */
  readonly ringCount?: number;
  /** 相邻环边长倍率(默认 2)。 */
  readonly ringExtentScale?: number;
  /** 光空间深度 padding(世界单位,同 CSM depthPadding 语义)。 */
  readonly depthPadding?: number;
  /** 环 0 边长 = extent × 该系数(默认 2,近环覆盖主视两倍世界尺度)。 */
  readonly baseRingExtentFactor?: number;
  /** 阴影最大距离;缺省 = far。 */
  readonly maxShadowDistance?: number;
}

export interface VirtualShadowRing {
  readonly index: number;
  /** 环正交半边长(世界单位);边长 = 2·halfExtent。 */
  readonly halfExtent: number;
  /** 单虚拟 texel 的世界尺寸。 */
  readonly texelWorldSize: number;
  /** 吸附后的环中心(世界)。 */
  readonly center: ShadowVec3;
  /** 光空间深度范围(世界单位;归一化深度 = ndc.z × depthSpan)。 */
  readonly depthSpan: number;
  /** 环光空间 viewProjection(列主序,WebGPU 0..1 深度)。 */
  readonly viewProjection: Float32Array<ArrayBuffer>;
}

export interface VirtualShadowClipmapPlan {
  readonly lightDirection: ShadowVec3;
  readonly rings: readonly VirtualShadowRing[];
  /** 阴影最大距离(世界);超出 = 无阴影(与 CSM beyond-last-split 同语义)。 */
  readonly maxShadowDistance: number;
}

/** 三环 clipmap 规划:全部输入经校验,输出冻结(每帧调用的纯函数)。 */
export function planVirtualShadowClipmap(camera: VirtualShadowClipmapCamera,
  lightDirection: ShadowVec3, options: VirtualShadowClipmapOptions = {}): VirtualShadowClipmapPlan {
  const validated = validate(camera, lightDirection, options);
  const backward = scale(validated.lightDirection, -1);
  const lightUp: ShadowVec3 = Math.abs(backward[1])! > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(lightUp, backward));
  const correctedUp = cross(backward, right);
  const baseExtent = Math.max(1 / 16, camera.extent * validated.baseRingExtentFactor);
  const rings: VirtualShadowRing[] = [];
  for (let index = 0; index < validated.ringCount; index += 1) {
    // 环半边长保持精确 2:1(不做世界量化):页格吸附靠 snapCenterToPageGrid 的
    // tile(texel·PAGE_GRID)格点完成,格点世界固定性只依赖光基向,不依赖边长量化。
    const halfExtent = Math.max(1 / 16, baseExtent * validated.ringExtentScale ** index / 2);
    const texelWorldSize = 2 * halfExtent / VIRTUAL_SHADOW_VIRTUAL_EDGE;
    // 锚点吸附到页格(t = texel·PAGE_GRID)而非单 texel:页边界落在世界固定格点上,
    // 相机移动不迁移任何已物化页内容(真 clipmap 缓存),只在新页进入覆盖窗时物化新页。
    const center = snapCenterToPageGrid(camera.target, right, correctedUp, backward, texelWorldSize);
    const lightDistance = halfExtent + validated.depthPadding;
    const lightEye = sub(center, scale(validated.lightDirection, lightDistance));
    const viewProjection = multiply(orthographic(halfExtent, 0, 2 * lightDistance),
      lookAt(lightEye, center, lightUp));
    rings.push(Object.freeze({ index, halfExtent, texelWorldSize, center,
      depthSpan: 2 * lightDistance, viewProjection }));
  }
  return Object.freeze({ lightDirection: validated.lightDirection, rings: Object.freeze(rings),
    maxShadowDistance: validated.maxShadowDistance });
}

/** 世界点 → 环光空间 uv + 归一化深度(uv 出 [0,1] 即环足迹外)。列主序 contract:
 *  与 WGSL `matrix * vec4` 同构 —— clip 分量 = 行 r 与 p 的点积 = m[0*4+r]x+m[1*4+r]y+m[2*4+r]z+m[3*4+r]。 */
export function projectToRing(ring: VirtualShadowRing, world: ShadowVec3): {
  readonly u: number; readonly v: number; readonly depth: number;
} {
  const m = ring.viewProjection;
  const x = world[0]!, y = world[1]!, z = world[2]!;
  const clipX = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  const clipY = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  const clipZ = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  const clipW = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (!(clipW > 0)) return { u: -1, v: -1, depth: -1 };
  return { u: clipX / clipW * 0.5 + 0.5, v: clipY / clipW * -0.5 + 0.5, depth: clipZ / clipW };
}

/** uv → (mip, tileX, tileY);足迹外返回 undefined。mip 页网格 = PAGE_GRID >> mip。 */
export function pageOf(ring: VirtualShadowRing, mip: number, u: number, v: number): {
  readonly tileX: number; readonly tileY: number;
} | undefined {
  const grid = VIRTUAL_SHADOW_PAGE_GRID >> mip;
  const tileX = Math.floor(u * grid);
  const tileY = Math.floor(v * grid);
  if (tileX < 0 || tileY < 0 || tileX >= grid || tileY >= grid) return undefined;
  return { tileX, tileY };
}

/** 页的子区域 viewProjection(页物化绘制用:frame.light = 该矩阵,viewport = 整页)。
 *  uv v 轴翻转合同:采样端 v = ndc.y·−0.5+0.5,页 ty 沿 −correctedUp 方向递增 ——
 *  页世界矩形取 v 区间对应的 correctedUp 负向带,与着色端 tile 解码逐 texel 对齐。 */
export function pageViewProjection(ring: VirtualShadowRing, mip: number, tileX: number, tileY: number,
  lightDirection: ShadowVec3): Float32Array<ArrayBuffer> {
  const grid = VIRTUAL_SHADOW_PAGE_GRID >> mip;
  const side = ring.halfExtent * 2;
  const backward = scale(lightDirection, -1);
  const lightUp: ShadowVec3 = Math.abs(backward[1])! > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(lightUp, backward));
  const correctedUp = cross(backward, right);
  const worldCenter = add(ring.center,
    add(scale(right, ((tileX + 0.5) / grid - 0.5) * side),
      scale(correctedUp, -((tileY + 0.5) / grid - 0.5) * side)));
  const halfSub = ring.halfExtent / grid;
  const eye = sub(worldCenter, scale(lightDirection, ring.depthSpan / 2));
  return multiply(orthographic(halfSub, 0, ring.depthSpan), lookAt(eye, worldCenter, lightUp));
}

/** 页世界包围半径(粗粒度,动态失效判定用)。 */
export function pageWorldRadius(ring: VirtualShadowRing, mip: number): number {
  return ring.halfExtent * 2 / (VIRTUAL_SHADOW_PAGE_GRID >> mip) * Math.SQRT2;
}

function validate(camera: VirtualShadowClipmapCamera, lightDirection: ShadowVec3,
  options: VirtualShadowClipmapOptions) {
  if (!camera || typeof camera !== "object" || Array.isArray(camera)) throw new TypeError("Shadow camera must be an object.");
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Shadow options must be an object.");
  finiteVec(camera.eye, "camera eye"); finiteVec(camera.target, "camera target");
  finiteVec(camera.up ?? [0, 1, 0], "camera up");
  finite(camera.verticalFovRadians, 1e-4, Math.PI - 1e-4, "vertical field of view");
  finite(camera.aspect, 1e-4, 1000, "camera aspect");
  const near = finite(camera.near, 1e-4, MAX_DISTANCE, "camera near");
  const far = finite(camera.far, near + 1e-4, MAX_DISTANCE, "camera far");
  const extent = finite(camera.extent, 1e-4, MAX_DISTANCE, "view extent");
  const ringCount = integer(options.ringCount ?? DEFAULTS.ringCount, 1, 4, "ring count");
  const ringExtentScale = finite(options.ringExtentScale ?? DEFAULTS.ringExtentScale, 1.5, 8, "ring extent scale");
  const depthPadding = finite(options.depthPadding ?? DEFAULTS.depthPadding, 0, MAX_DISTANCE, "depth padding");
  const baseRingExtentFactor = finite(options.baseRingExtentFactor ?? DEFAULTS.baseRingExtentFactor, 0.125, 64, "base ring extent factor");
  const maxShadowDistance = options.maxShadowDistance === undefined ? far
    : Math.min(far, finite(options.maxShadowDistance, near + 1e-4, MAX_DISTANCE, "maximum shadow distance"));
  void extent;
  return { ringCount, ringExtentScale, depthPadding, baseRingExtentFactor, maxShadowDistance,
    lightDirection: normalize(finiteVec(lightDirection, "light direction")) } as const;
}

/**
 * 中心吸附到页格(t = texel·PAGE_GRID):页边界 = 中心 ± k·t 恒落世界固定格点,
 * 页 (tx,ty) 在锚点移动前后覆盖同一世界矩形(页内容世界对齐,跨帧缓存有效)。
 */
function snapCenterToPageGrid(center: ShadowVec3, right: ShadowVec3, up: ShadowVec3, backward: ShadowVec3,
  texel: number): ShadowVec3 {
  const tile = texel * VIRTUAL_SHADOW_PAGE_GRID;
  const x = Math.round(dot(center, right) / tile) * tile;
  const y = Math.round(dot(center, up) / tile) * tile;
  const z = dot(center, backward);
  return add(add(scale(right, x), scale(up, y)), scale(backward, z));
}

function finiteVec(value: ShadowVec3, label: string): ShadowVec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((component) => Number.isFinite(component) && Math.abs(component) <= MAX_DISTANCE)) {
    throw new RangeError(`Invalid ${label}.`);
  }
  return [value[0]!, value[1]!, value[2]!];
}
function finite(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`Invalid ${label}.`);
  return value;
}
function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`Invalid ${label}.`);
  return value;
}
function normalize(value: ShadowVec3): ShadowVec3 {
  const length = Math.hypot(...value);
  if (length < 1e-8) throw new RangeError("Direction is degenerate.");
  return scale(value, 1 / length);
}
function add(a: ShadowVec3, b: ShadowVec3): ShadowVec3 { return [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!]; }
function sub(a: ShadowVec3, b: ShadowVec3): ShadowVec3 { return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]; }
function scale(value: ShadowVec3, factor: number): ShadowVec3 { return [value[0]! * factor, value[1]! * factor, value[2]! * factor]; }
function dot(a: ShadowVec3, b: ShadowVec3): number { return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!; }
function cross(a: ShadowVec3, b: ShadowVec3): ShadowVec3 {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}
