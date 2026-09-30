// I 级 C18 体积光 god rays 族首刀:合同、预算硬顶、光空间基、解析遮挡、
// 阴影图光栅化与 CPU f64 参考 march。体积雾底座(fog/volumetricFog.ts)的
// 参数空间(medium 四元组、light 约定、steps 区间、maxDistance 语义)与对拍纪律
// (CPU f64 参考 -> CPU 镜像 -> WGSL)在本族全额复用,不另起第二体积系统;
// 数学原子(HG 相位/高度密度/rayHeightAt/数值地板)直接 import fog/volumetricFog.ts
// 导出函数——恒等性由构造保证,而非复制(与 volumetricFogPassCpu.ts 同纪律)。
//
// 首刀口径:
// - 阴影 = 单级正交阴影图,per-texel 中心 ray cast 光栅化(f64),最近邻采样(1 tap);
//   PCF/软阴影/多级 CSM 是后续切片。
// - 参考闭式 = 不经阴影图的解析遮挡(ray-occluder 精确求交),作为阴影图采样的
//   量化误差 ground truth;两层量化(解析 vs 阴影图、f64 vs f32)在
//   volumetricGodRays.test.ts / volumetricGodRaysCpu.test.ts 定界。
// - 光空间基在视图空间表达(与 WGSL 核步进空间一致),消费方接线时逐帧上传。
// - 真机 GPU 数值探针未做(模拟口径),与雾 GPU 数值对拍同为 unmeasured 留项。

import { EPSILON, TRANSMITTANCE_FLOOR, densityAtHeight, henyeyGreensteinPhase,
  rayMarchVolumetricFog } from "../fog/volumetricFog.js";
import type { VolumetricLight, VolumetricMedium, VolumetricVector3 } from "../fog/volumetricFog.js";
import { DEEP_GOD_RAYS_WORKGROUP_SIZE } from "./volumetricGodRaysWgsl.js";

// ---------------------------------------------------------------------------
// 预算硬顶(性能可调的参数侧边界;采样量口径见 godRaysFrameMarchSamples)
// ---------------------------------------------------------------------------

/** 步进数区间:与体积雾 steps 完全同区间(切片一 [32,64] 合同)。 */
export const GOD_RAYS_STEPS_MIN = 32;
export const GOD_RAYS_STEPS_MAX = 64;
/** 天空/最远步进距离硬顶(米)。 */
export const GOD_RAYS_MAX_DISTANCE_CAP = 1000;
/** 强度乘子硬顶(乘在 radiance 侧,物理线性)。 */
export const GOD_RAYS_STRENGTH_CAP = 8;
/** 阴影图边长区间(正方形,2 的幂)。 */
export const GOD_RAYS_SHADOW_MAP_MIN = 64;
export const GOD_RAYS_SHADOW_MAP_MAX = 1024;
/** 阴影正交覆盖半宽硬顶(米,以视图空间原点为中心)。 */
export const GOD_RAYS_SHADOW_RANGE_CAP = 1000;
/** 深度比较偏移硬顶(米)。 */
export const GOD_RAYS_SHADOW_BIAS_MAX = 0.1;
/** 阴影图未命中 texel 的 FAR 哨兵;f32 可精确表示(1e9 = 2^9 × 5^9,尾数 21 位 < 24),与 WGSL/CPU 镜像互钉。 */
export const GOD_RAYS_SHADOW_FAR_SENTINEL = 1e9;
/** 单级正交阴影图采样 tap 数(首刀固定 1,最近邻)。 */
export const GOD_RAYS_SHADOW_TAPS = 1;

export interface VolumetricGodRaysOptions {
  readonly verticalFovRadians: number;
  /** 视图射线步进数;与体积雾 steps 同区间 [32, 64]。 */
  readonly steps: number;
  /** 天空像素(深度 0)的步进终点(米);硬顶 1000。 */
  readonly maxDistance: number;
  /** 介质参数:与 fog/volumetricFog.ts VolumetricMedium 同一类型、同一语义。 */
  readonly medium: VolumetricMedium;
  /** 主光:direction 为视图空间光传播方向(与雾核 lightDirection 同约定)。 */
  readonly light: VolumetricLight;
  /** 散射强度乘子,乘在 radiance 侧;硬顶 8。 */
  readonly strength: number;
  /** 单级正交阴影图边长,[64, 1024] 的 2 的幂。 */
  readonly shadowMapSize: number;
  /** 阴影正交覆盖半宽(米,以视图空间原点为中心),(0, 1000]。 */
  readonly shadowRange: number;
  /** 深度比较偏移(米),[0, 0.1]。 */
  readonly shadowBias: number;
}

export function validateVolumetricGodRaysOptions(options: VolumetricGodRaysOptions): void {
  if (!Number.isFinite(options.verticalFovRadians) || options.verticalFovRadians <= 0
    || options.verticalFovRadians >= Math.PI) {
    throw new RangeError("God rays verticalFovRadians must be in (0, pi).");
  }
  if (!Number.isSafeInteger(options.steps) || options.steps < GOD_RAYS_STEPS_MIN || options.steps > GOD_RAYS_STEPS_MAX) {
    throw new RangeError(`God rays steps must be an integer in [${GOD_RAYS_STEPS_MIN}, ${GOD_RAYS_STEPS_MAX}].`);
  }
  if (!Number.isFinite(options.maxDistance) || options.maxDistance <= 0 || options.maxDistance > GOD_RAYS_MAX_DISTANCE_CAP) {
    throw new RangeError(`God rays maxDistance must be finite in (0, ${GOD_RAYS_MAX_DISTANCE_CAP}] meters.`);
  }
  if (!Number.isFinite(options.strength) || options.strength < 0 || options.strength > GOD_RAYS_STRENGTH_CAP) {
    throw new RangeError(`God rays strength must be finite in [0, ${GOD_RAYS_STRENGTH_CAP}].`);
  }
  if (!Number.isSafeInteger(options.shadowMapSize) || options.shadowMapSize < GOD_RAYS_SHADOW_MAP_MIN
    || options.shadowMapSize > GOD_RAYS_SHADOW_MAP_MAX || (options.shadowMapSize & (options.shadowMapSize - 1)) !== 0) {
    throw new RangeError(`God rays shadowMapSize must be a power of two in [${GOD_RAYS_SHADOW_MAP_MIN}, ${GOD_RAYS_SHADOW_MAP_MAX}].`);
  }
  if (!Number.isFinite(options.shadowRange) || options.shadowRange <= 0 || options.shadowRange > GOD_RAYS_SHADOW_RANGE_CAP) {
    throw new RangeError(`God rays shadowRange must be finite in (0, ${GOD_RAYS_SHADOW_RANGE_CAP}] meters.`);
  }
  if (!Number.isFinite(options.shadowBias) || options.shadowBias < 0 || options.shadowBias > GOD_RAYS_SHADOW_BIAS_MAX) {
    throw new RangeError(`God rays shadowBias must be finite in [0, ${GOD_RAYS_SHADOW_BIAS_MAX}] meters.`);
  }
  validateGodRaysMedium(options.medium);
  validateGodRaysLight(options.light);
}

function validateGodRaysMedium(medium: VolumetricMedium): void {
  if (!Number.isFinite(medium.baseExtinction) || medium.baseExtinction < 0 || medium.baseExtinction > 100) {
    throw new RangeError("God rays baseExtinction must be finite in [0, 100] per meter.");
  }
  if (!Number.isFinite(medium.scaleHeight) || medium.scaleHeight <= 0) {
    throw new RangeError("God rays scaleHeight must be positive.");
  }
  if (!Number.isFinite(medium.anisotropy) || medium.anisotropy < -0.99 || medium.anisotropy > 0.99) {
    throw new RangeError("God rays anisotropy must be in [-0.99, 0.99].");
  }
  if (!Number.isFinite(medium.albedo) || medium.albedo < 0 || medium.albedo > 1) {
    throw new RangeError("God rays albedo must be in [0, 1].");
  }
}

function validateGodRaysLight(light: VolumetricLight): void {
  const [dx, dy, dz] = light.direction;
  if (dx === undefined || dy === undefined || dz === undefined
    || !Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz) || Math.hypot(dx, dy, dz) <= 1e-6) {
    throw new RangeError("God rays light direction must be a finite nonzero vector.");
  }
  const [rr, rg, rb] = light.radiance;
  if (rr === undefined || rg === undefined || rb === undefined
    || !Number.isFinite(rr) || !Number.isFinite(rg) || !Number.isFinite(rb) || rr < 0 || rg < 0 || rb < 0) {
    throw new RangeError("God rays light radiance must be finite and nonnegative.");
  }
}

/**
 * 每帧 ray-march 步进采样量上界(半分辨率 x steps);阴影图 fetch 每步至多
 * GOD_RAYS_SHADOW_TAPS 次,且 transmittance 提前终止只会更少。
 * 这是模拟口径的确定性成本公式;真机毫秒数是 unmeasured 留项。
 */
export function godRaysFrameMarchSamples(width: number, height: number, steps: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("God rays frame dimensions must be positive safe integers.");
  }
  if (!Number.isSafeInteger(steps) || steps < 1) throw new RangeError("God rays steps must be a positive integer.");
  return Math.ceil(width / 2) * Math.ceil(height / 2) * steps;
}

// ---------------------------------------------------------------------------
// 光空间基(视图空间;构造恒正交归一,失败 fail-closed)
// ---------------------------------------------------------------------------

export interface GodRaysShadowBasis {
  readonly right: VolumetricVector3;
  readonly up: VolumetricVector3;
  /** 光传播方向单位向量(=归一化后的 light.direction)。 */
  readonly forward: VolumetricVector3;
}

function normalize3(vector: VolumetricVector3): VolumetricVector3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length <= 1e-6) {
    throw new RangeError("God rays light direction must be a finite nonzero vector (length > 1e-6).");
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

/**
 * 视图空间光空间正交基。forward = normalize(lightDirection);辅助 up 选取判据
 * |forward.y| > 0.999 与 WGSL iesSampling 家族同一字面量(0.999)。
 * 正交性由测试逐值锁死(right/up/forward 两两点积 0,模长 1)。
 */
export function buildGodRaysShadowBasis(lightDirection: VolumetricVector3): GodRaysShadowBasis {
  const forward = normalize3(lightDirection);
  const helperUp: VolumetricVector3 = Math.abs(forward[1]) > 0.999 ? [1, 0, 0] : [0, 1, 0];
  const cross = (a: VolumetricVector3, b: VolumetricVector3): VolumetricVector3 => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const right = normalize3(cross(helperUp, forward));
  const up = cross(forward, right);
  return { right, up, forward };
}

/** 视图空间点到光空间坐标 [u, v, w](w 沿光传播方向增长,深度图存 w)。 */
export function godRaysLightSpacePoint(basis: GodRaysShadowBasis, point: VolumetricVector3): readonly [number, number, number] {
  return [point[0] * basis.right[0] + point[1] * basis.right[1] + point[2] * basis.right[2],
    point[0] * basis.up[0] + point[1] * basis.up[1] + point[2] * basis.up[2],
    point[0] * basis.forward[0] + point[1] * basis.forward[1] + point[2] * basis.forward[2]];
}

// ---------------------------------------------------------------------------
// 解析遮挡体(视图空间)与 f64 闭式求交 —— 参考闭式的 ground truth
// ---------------------------------------------------------------------------

export type GodRaysOccluder =
  | { readonly kind: "sphere"; readonly center: VolumetricVector3; readonly radius: number }
  | { readonly kind: "box"; readonly min: VolumetricVector3; readonly max: VolumetricVector3 };

/**
 * 射线 origin + t*direction 与遮挡体的最近正向交点距离(t = 沿单位方向的光程);
 * 无交或最近命中在 t <= tMin 返回 null;起点已在遮挡体内部(或近表面在 tMin 之内)
 * 返回钳制命中 tMin(非 null——光栅化 tMin=0 即存 0,参考判定只看非 null)。
 * direction 必须是有限单位向量(见函数体 fail-closed),否则抛 RangeError。
 */
export function intersectGodRaysOccluder(occluder: GodRaysOccluder, origin: VolumetricVector3,
  direction: VolumetricVector3, tMin: number): number | null {
  // 球分支以 a=1 化简(二次项系数 = |d|²),盒分支的 slab t 同以"沿射线光程"为语义:
  // direction 非单位时球分支会静默产出被 |d|² 缩放的错误距离(盒分支却仍正确)——
  // 同一 API 两分支语义分叉,在此统一 fail-closed 拦下(2026-09-30 收口 C18 缺陷修复;
  // 两个内部调用方 analyticGodRaysShadow / rasterizeGodRaysShadowMap 均传单位基向量)。
  const directionLength = Math.hypot(direction[0], direction[1], direction[2]);
  if (!Number.isFinite(directionLength) || Math.abs(directionLength - 1) > 1e-6) {
    throw new RangeError("God rays occluder ray direction must be a finite unit vector (|d| = 1 ± 1e-6).");
  }
  if (occluder.kind === "sphere") {
    if (!Number.isFinite(occluder.radius) || occluder.radius <= 0) {
      throw new RangeError("God rays sphere occluder radius must be finite and positive.");
    }
    const ox = origin[0] - occluder.center[0], oy = origin[1] - occluder.center[1], oz = origin[2] - occluder.center[2];
    const b = ox * direction[0] + oy * direction[1] + oz * direction[2];
    const c = ox * ox + oy * oy + oz * oz - occluder.radius * occluder.radius;
    const discriminant = b * b - c; // direction 已归一化,a = 1
    if (discriminant < 0) return null;
    const root = Math.sqrt(discriminant);
    const t0 = -b - root, t1 = -b + root;
    if (t0 > tMin) return t0;
    // 近命中在 tMin 之内(含起点在球内):深度钳到 tMin(光栅化 tMin=0 即"已在遮挡体内";参考判定只看非 null)。
    if (t1 > tMin) return tMin;
    return null;
  }
  const min = occluder.min, max = occluder.max;
  for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) {
    if (!Number.isFinite(min[axis]) || !Number.isFinite(max[axis]) || min[axis] >= max[axis]) {
      throw new RangeError("God rays box occluder must have finite min < max per axis.");
    }
  }
  let tEnter = -Infinity, tExit = Infinity;
  for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) {
    const d = direction[axis];
    if (Math.abs(d) < EPSILON) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
      continue;
    }
    const inv = 1 / d;
    let t0 = (min[axis] - origin[axis]) * inv;
    let t1 = (max[axis] - origin[axis]) * inv;
    if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
    tEnter = Math.max(tEnter, t0);
    tExit = Math.min(tExit, t1);
    if (tEnter > tExit) return null;
  }
  if (tEnter > tMin) return tEnter;
  if (tExit > tMin) return tEnter > -Infinity ? Math.max(tEnter, tMin) : tMin; // 起点在盒内
  return null;
}

/**
 * 解析阴影判定(参考闭式):视图空间点 p 朝光源(-forward)回投,存在交点
 * t > shadowBias 即为遮挡。shadowBias 与阴影图深度比较偏移同值,保证两端
 * 在遮挡体后方同一深度处切换(分歧只剩阴影图的 texel 量化,见量化测试)。
 */
export function analyticGodRaysShadow(basis: GodRaysShadowBasis, occluders: readonly GodRaysOccluder[],
  point: VolumetricVector3, shadowBias: number): number {
  const towardLight: VolumetricVector3 = [-basis.forward[0], -basis.forward[1], -basis.forward[2]];
  for (const occluder of occluders) {
    if (intersectGodRaysOccluder(occluder, point, towardLight, shadowBias) !== null) return 0;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// 阴影图光栅化:per-texel 中心 ray cast(f64 求值,f32 容器输出)
// ---------------------------------------------------------------------------

export interface GodRaysShadowMap {
  readonly size: number;
  /** 行主序 size*size,值 = 沿 forward 的深度;未命中 texel 为 FAR 哨兵。 */
  readonly depth: Float32Array;
}

/**
 * 把解析遮挡体光栅化进单级正交阴影图:每个 texel 中心沿光空间 (u,v) 反投影出
 * 一条 forward 射线,取最近命中的**绝对 w**(沿 forward 的光空间深度;光栅化起点
 * 落在遮挡体内部时取起点 w)。f64 求值一次成型,输出 Float32Array 是消费端口径
 * (量化与 WGSL texture_2d<f32> 同容器);与 WGSL 最近邻采样的确定性配对由测试锁定。
 *
 * 2026-09-30 收口 C18 缺陷修复:光栅化起点此后移到 w = -shadowRange,存储命中点
 * 的绝对 w(= -shadowRange + t)。原实现从 w=0 平面起投,位于视图空间原点后方
 * (w < 0,如太阳在相机背后时)的遮挡体沿 +forward 不可达,整片 texel 落 FAR
 * 哨兵 → 阴影图判 lit,而解析参考(analyticGodRaysShadow 从采样点向光回投)判
 * 遮挡 —— 两条路径产生非量化性的无界分歧,违背"解析闭式 = 阴影图量化误差
 * ground truth"的族内契约。修复后 w 轴覆盖 [-shadowRange, +∞),与 u/v 的
 * [-shadowRange, +shadowRange] 合成同预算的正交覆盖盒;遮挡体完全位于
 * w < -shadowRange(相机后方超过一个覆盖半宽)仍不入图,与 u/v 域外 fail-open
 * 同级,由 shadowRange 预算硬顶定界。消费端(WGSL shadowVisibility /
 * shadowVisibilityGodRaysCpu)按 stored >= basisW - shadowBias 比较,存绝对 w
 * 与采样 basisW 同坐标系,比较语义不变。
 */
export function rasterizeGodRaysShadowMap(basis: GodRaysShadowBasis, occluders: readonly GodRaysOccluder[],
  options: Pick<VolumetricGodRaysOptions, "shadowMapSize" | "shadowRange">): GodRaysShadowMap {
  const size = options.shadowMapSize;
  if (!Number.isSafeInteger(size) || size < GOD_RAYS_SHADOW_MAP_MIN || size > GOD_RAYS_SHADOW_MAP_MAX
    || (size & (size - 1)) !== 0) {
    throw new RangeError(`God rays shadow map size must be a power of two in [${GOD_RAYS_SHADOW_MAP_MIN}, ${GOD_RAYS_SHADOW_MAP_MAX}].`);
  }
  if (!Number.isFinite(options.shadowRange) || options.shadowRange <= 0 || options.shadowRange > GOD_RAYS_SHADOW_RANGE_CAP) {
    throw new RangeError(`God rays shadowRange must be finite in (0, ${GOD_RAYS_SHADOW_RANGE_CAP}] meters.`);
  }
  const depth = new Float32Array(size * size).fill(GOD_RAYS_SHADOW_FAR_SENTINEL);
  for (let texelY = 0; texelY < size; texelY += 1) {
    for (let texelX = 0; texelX < size; texelX += 1) {
      const u = (((texelX + 0.5) / size) * 2 - 1) * options.shadowRange;
      const v = (((texelY + 0.5) / size) * 2 - 1) * options.shadowRange;
      // 光栅化起点在 w = -shadowRange(正交覆盖盒近端面):origin = right·u + up·v - forward·range。
      const origin: VolumetricVector3 = [
        basis.right[0] * u + basis.up[0] * v - basis.forward[0] * options.shadowRange,
        basis.right[1] * u + basis.up[1] * v - basis.forward[1] * options.shadowRange,
        basis.right[2] * u + basis.up[2] * v - basis.forward[2] * options.shadowRange];
      let nearest = GOD_RAYS_SHADOW_FAR_SENTINEL;
      for (const occluder of occluders) {
        const hit = intersectGodRaysOccluder(occluder, origin, basis.forward, 0);
        if (hit !== null) {
          const hitW = hit - options.shadowRange; // 绝对 w = 起点 w(-range)+ 沿 forward 光程 t
          if (hitW < nearest) nearest = hitW;
        }
      }
      depth[texelY * size + texelX] = nearest;
    }
  }
  return { size, depth };
}

// ---------------------------------------------------------------------------
// CPU f64 参考 march(解析遮挡;单像素,与 volumetricFog.rayMarchVolumetricFog 同构)
// ---------------------------------------------------------------------------

export interface VolumetricGodRaysMarchInput {
  /** 视图空间射线方向(相机在原点);核内归一化。 */
  rayDirection: VolumetricVector3;
  /** 步进终点(米)。 */
  marchDistance: number;
  readonly stepCount: number;
}

/**
 * god rays 参考闭式:与 fog/volumetricFog.ts rayMarchVolumetricFog 完全同构的
 * 中点采样 Beer-Lambert 积分,唯一差异是每步中点的阴影由解析遮挡给出
 * (雾基线的 shadow ≡ 1 钩子在本族由 analyticGodRaysShadow 填充)。
 * strength 乘在 radiance 侧(与 WGSL/CPU 镜像同序)。
 */
export function rayMarchVolumetricGodRaysReference(medium: VolumetricMedium, light: VolumetricLight,
  strength: number, basis: GodRaysShadowBasis, occluders: readonly GodRaysOccluder[],
  shadowBias: number, input: VolumetricGodRaysMarchInput): { inscatter: VolumetricVector3; transmittance: number } {
  const viewDirection = normalize3(input.rayDirection);
  const lightDirection = normalize3(light.direction);
  const cosTheta = viewDirection[0] * lightDirection[0] + viewDirection[1] * lightDirection[1]
    + viewDirection[2] * lightDirection[2];
  const phase = henyeyGreensteinPhase(cosTheta, medium.anisotropy);
  const stepLength = input.marchDistance / Math.max(1, input.stepCount);
  const inscatter: [number, number, number] = [0, 0, 0];
  let transmittance = 1;
  for (let step = 0; step < input.stepCount; step += 1) {
    const t = (step + 0.5) * stepLength;
    const height = viewDirection[1] * t;
    const opticalDepth = densityAtHeight(height, medium) * stepLength;
    if (opticalDepth < EPSILON) continue;
    const extinction = Math.exp(-opticalDepth);
    const shadow = analyticGodRaysShadow(basis, occluders,
      [viewDirection[0] * t, viewDirection[1] * t, viewDirection[2] * t], shadowBias);
    const scattering = medium.albedo * opticalDepth * phase * shadow;
    inscatter[0] += (light.radiance[0] * strength) * (scattering * transmittance);
    inscatter[1] += (light.radiance[1] * strength) * (scattering * transmittance);
    inscatter[2] += (light.radiance[2] * strength) * (scattering * transmittance);
    transmittance *= extinction;
    if (transmittance < TRANSMITTANCE_FLOOR) break;
  }
  return { inscatter, transmittance };
}

/**
 * 参数空间兼容性锚点:同一射线跑参考闭式(无遮挡体,strength=1)与体积雾基线
 * rayMarchVolumetricFog(shadow ≡ 1),返回两份结果供测试逐值对拍。
 * 兼容性是数值断言而非类型断言——由 volumetricGodRays.test.ts 锁定。
 */
export function godRaysFogParityProbe(medium: VolumetricMedium, light: VolumetricLight,
  marchDistance: number, stepCount: number, rayDirection: VolumetricVector3): {
  godRays: { inscatter: VolumetricVector3; transmittance: number };
  fog: { inscatter: VolumetricVector3; transmittance: number };
} {
  const basis = buildGodRaysShadowBasis(light.direction);
  const godRays = rayMarchVolumetricGodRaysReference(medium, light, 1, basis, [], 0,
    { rayDirection, marchDistance, stepCount });
  const fog = rayMarchVolumetricFog(medium, light, {
    rayOrigin: [0, 0, 0], rayDirection, near: 0, far: marchDistance, stepCount,
    shadowAttenuation: () => 1 });
  return { godRays, fog };
}

/** workgroup 契约再导出(与生成镜像常量互钉;禁止在消费方 hardcode)。 */
export const GOD_RAYS_WORKGROUP_SIZE = DEEP_GOD_RAYS_WORKGROUP_SIZE;
