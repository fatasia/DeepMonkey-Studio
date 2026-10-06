import type { LightVector3 } from "./types.js";
import type { AreaLight } from "./areaLights.js";
import { MAX_AREA_LIGHTS } from "./areaLights.js";
import type { ClusteredLights, PointLight, SpotLight } from "./types.js";

/**
 * B2 MegaLights M1 万灯直接光:统一灯光池(点/聚/矩形面积三型 union,64B/灯)
 * + 直射通路选择 + RIS 采样的 CPU 权威参考。
 *
 * 唯一 GPU 真源在 wgsl/megaLightsRis.wgsl(RIS 采样核,checksum 门);本文件只做
 * 「灯进 GPU」的等价变换、合同闸与 CPU 参考评测(沿 areaLights/clusterPacking 家族模式)。
 *
 * 64B/灯 显式 ABI(16 f32,与 WGSL DEEP_MEGA_LIGHT_ABI 逐字互钉,漂移由
 * megaLightsRisWgslChecksum.test.ts 抓红):
 *   [0] position.xyz              | kind(0=point,1=spot,2=area-rect;f32 精确整数)
 *   [1] radiance.xyz(color×intensity) | range(0=无窗口)
 *   [2] direction.xyz(单位向量)  | iesSpotIndex+1(0=无 IES;行号对齐既有
 *       iesShading storage 的 spot 参数行,E02 复用不重复打包)
 *   [3] params:point(decay−2,0,0,0) / spot(innerCos,outerCos,coneScale,decay−2)
 *              / area(halfWidth,halfHeight,twoSided 位,0)
 *
 * 物理口径与既有直射路径严格同族(clusterLightingPbrWgsl 的 deepClusterBrdf /
 * deepClusterRangeAttenuation / deepSpotAttenuation;CPU 参考在本文件同式复算):
 *  - 点/聚光:range 硬窗 + 1/d^decay 衰减 + 聚光 smoothstep 锥(+IES);
 *  - 面积光在 RIS 通路按「中心点近似」参与重要度与胜者着色(辐射 = radiance×
 *    halfExtent 面积因子,立体角近似);**精确 LTC 着色仍走既有面积光路径**,
 *    LTC×RIS 合成是 M2 范围(任务书 ue-class-b2-task-briefs-20261004.md)。
 */

/** ABI 版本:打包布局变化时递增(runtime 侧 pipeline key 一并递增)。 */
export const MEGA_LIGHT_ABI_VERSION = 1;
/** 每灯 64B = 4 vec4 = 16 f32(显式 ABI,见模块头语义表)。 */
export const MEGA_LIGHT_STRIDE_BYTES = 64;
export const MEGA_LIGHT_STRIDE_VEC4 = 4;
export const MEGA_LIGHT_WORDS = 16;

/** kind 编码(f32 精确整数;与 WGSL DEEP_MEGA_LIGHT_KIND_* 逐字互钉)。 */
export const MEGA_LIGHT_KIND_POINT = 0;
export const MEGA_LIGHT_KIND_SPOT = 1;
export const MEGA_LIGHT_KIND_AREA_RECT = 2;

/** 万灯池合同上限;runtime 按需 2 的幂扩容(storage 上限由设备 clamp,fail-closed)。 */
export const MAX_MEGA_LIGHTS = 65_535;

/** RIS 采样预算(任务书定值):像素级 K=32 候选 → resample M=1。 */
export const MEGALIGHTS_RIS_CANDIDATES = 32;
export const MEGALIGHTS_RIS_M = 1;
/** 空间复用波前半径:5×5 邻域(半径 2)。 */
export const MEGALIGHTS_SPATIAL_REUSE_RADIUS = 2;

/** 既有簇光快路径的灯数决策点:≤64 盏本地点走逐灯着色(逐位既有路径,零回归),
 * 超出(或显式开关)走 MegaLights RIS 通路(每像素常数次采样,成本与灯数解耦)。 */
export const MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET = 64;

/** 统一 MegaLight 记录(点/聚/面积三型 union;字段语义与既有三族合同同域)。 */
export interface MegaLight {
  readonly kind: "point" | "spot" | "area";
  readonly positionView: LightVector3;
  /** 硬截断半径;0 = 无窗口。 */
  readonly range: number;
  readonly color: LightVector3;
  readonly intensity: number;
  /** 点/聚光衰减指数([0,4],缺省 2);面积光不消费(打包恒 2)。 */
  readonly decay: number;
  /** 聚光朝向 / 面积光发射面法线(打包时归一化);点光缺省(+Z 占位)。 */
  readonly directionView?: LightVector3;
  /** 聚光锥(合同:-1 ≤ outerConeCos < innerConeCos ≤ 1,与 clusterPacking 同校验)。 */
  readonly innerConeCos?: number;
  readonly outerConeCos?: number;
  /** 面积光半宽/半高(正有限)。 */
  readonly halfExtent?: readonly [number, number];
  /** 面积光宽度轴(与 directionView 不平行即可,打包时正交归一)。 */
  readonly upView?: LightVector3;
  /** 面积光双面发光;缺省单面。 */
  readonly twoSided?: boolean;
  /** 复用既有 iesShading storage 的 spot 参数行号([0,spotCount);缺省=无 IES)。
   * 行号由 megaLightsFromClustered 按 spot 序对齐,手工构建时由调用方保证闭合。 */
  readonly iesSpotIndex?: number;
}

export interface PackedMegaLights {
  /** [count × 16 f32];无灯时为最小占位(1 灯槽全零,kind=point 全零=零贡献)。 */
  readonly data: Float32Array;
  readonly count: number;
  readonly pointCount: number;
  readonly spotCount: number;
  readonly areaCount: number;
  /** 打包中最高引用的 ies 行号 +1(0=无 IES 引用);runtime 据此校验 ies 载荷闭合。 */
  readonly iesReferenceCount: number;
}

function finite3(value: readonly number[] | undefined, name: string): void {
  if (value === undefined || value.length !== 3 || !value.every(Number.isFinite)) {
    throw new Error(`${name} must contain three finite values.`);
  }
}

function finiteNonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative.`);
}

function kindValue(light: MegaLight): number {
  return light.kind === "point" ? MEGA_LIGHT_KIND_POINT : light.kind === "spot" ? MEGA_LIGHT_KIND_SPOT : MEGA_LIGHT_KIND_AREA_RECT;
}

/** 逐灯合同校验(fail-closed;语义与 clusterPacking/areaLights 同族)。 */
export function validateMegaLight(light: MegaLight, name: string): void {
  if (!(["point", "spot", "area"] as const).includes(light.kind)) throw new Error(`${name}.kind is unknown.`);
  finite3(light.positionView, `${name}.positionView`);
  finite3(light.color, `${name}.color`);
  if (light.color.some(component => component < 0)) throw new Error(`${name}.color must be nonnegative.`);
  finiteNonnegative(light.range, `${name}.range`);
  finiteNonnegative(light.intensity, `${name}.intensity`);
  if (!Number.isFinite(light.decay) || light.decay < 0 || light.decay > 4) throw new Error(`${name}.decay must be inside [0,4].`);
  if (light.kind !== "point") {
    finite3(light.directionView, `${name}.directionView`);
    if (Math.hypot(...light.directionView!) < 1e-8) throw new Error(`${name}.directionView must be nonzero.`);
  }
  if (light.kind === "spot") {
    const { innerConeCos = 1, outerConeCos = -1 } = light;
    if (!Number.isFinite(innerConeCos) || !Number.isFinite(outerConeCos)
      || outerConeCos < -1 || innerConeCos > 1 || outerConeCos > innerConeCos) {
      throw new Error(`${name} cone cosines must satisfy -1 <= outerConeCos <= innerConeCos <= 1.`);
    }
  }
  if (light.kind === "area") {
    const halfWidth = light.halfExtent?.[0], halfHeight = light.halfExtent?.[1];
    if (!Number.isFinite(halfWidth) || halfWidth! <= 0) throw new Error(`${name}.halfExtent[0] must be finite and positive.`);
    if (!Number.isFinite(halfHeight) || halfHeight! <= 0) throw new Error(`${name}.halfExtent[1] must be finite and positive.`);
    finite3(light.upView, `${name}.upView`);
    if (Math.hypot(...light.upView!) < 1e-8) throw new Error(`${name}.upView must be nonzero.`);
  }
  if (light.iesSpotIndex !== undefined) {
    if (!Number.isSafeInteger(light.iesSpotIndex) || light.iesSpotIndex < 0 || light.iesSpotIndex >= MAX_MEGA_LIGHTS) {
      throw new Error(`${name}.iesSpotIndex must be a safe spot-row index.`);
    }
  }
}

/** float32 可精确表达的非负小整数(kind/ies 行号);越界即拒,防 f32 往返漂移。 */
function exactFloat(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** 24) throw new Error(`${name} must be an f32-exact small integer.`);
  return Math.fround(value);
}

function normalize3(value: LightVector3): LightVector3 {
  const length = Math.hypot(...value);
  return [value[0] / length, value[1] / length, value[2] / length];
}

/** 面积光「中心点近似」的辐射缩放:半宽×半高×4 = 全面积(立体角近场语义)。 */
export function megaAreaLightExtentFactor(light: MegaLight): number {
  return (light.halfExtent?.[0] ?? 0) * (light.halfExtent?.[1] ?? 0) * 4;
}

/**
 * 打包进 64B/灯 灯池(尾部灯槽清零 = kind=point 全零零贡献,字节稳定可 diff)。
 * 布局见模块头语义表;方向/上轴在此归一(与 areaLights orthonormalBasis 同纪律,
 * up 正交化留给消费端——RIS 通路只读 direction,精确 LTC 路径仍读既有面积光 buffer)。
 */
export function packMegaLights(lights: readonly MegaLight[]): PackedMegaLights {
  if (lights.length > MAX_MEGA_LIGHTS) throw new Error(`Mega light count exceeds ${MAX_MEGA_LIGHTS}.`);
  const data = new Float32Array(Math.max(lights.length, 1) * MEGA_LIGHT_WORDS);
  let pointCount = 0, spotCount = 0, areaCount = 0, iesReferenceCount = 0;
  lights.forEach((light, index) => {
    validateMegaLight(light, `megas[${index}]`);
    if (light.kind === "point") pointCount++; else if (light.kind === "spot") spotCount++; else areaCount++;
    const radiance = [light.color[0] * light.intensity, light.color[1] * light.intensity, light.color[2] * light.intensity];
    const direction = light.kind === "point" ? ([0, 0, 1] as LightVector3) : normalize3(light.directionView!);
    const iesWord = light.iesSpotIndex === undefined ? 0 : exactFloat(light.iesSpotIndex + 1, `megas[${index}].iesSpotIndex+1`);
    iesReferenceCount = Math.max(iesReferenceCount, light.iesSpotIndex === undefined ? 0 : light.iesSpotIndex + 1);
    const base = index * MEGA_LIGHT_WORDS;
    data.set([...light.positionView, exactFloat(kindValue(light), `megas[${index}].kind`),
      ...radiance, light.range,
      ...direction, iesWord], base);
    if (light.kind === "point") {
      data.set([light.decay - 2, 0, 0, 0], base + 12);
    } else if (light.kind === "spot") {
      const coneScale = light.innerConeCos === light.outerConeCos ? 0 : 1 / (light.innerConeCos! - light.outerConeCos!);
      data.set([light.innerConeCos!, light.outerConeCos!, coneScale, light.decay - 2], base + 12);
    } else {
      data.set([light.halfExtent![0], light.halfExtent![1], light.twoSided ? 1 : 0, 0], base + 12);
    }
  });
  if (data.some(Number.isNaN)) throw new Error("mega lights packing produced NaN (finite-value contract regressed).");
  return Object.freeze({ data, count: lights.length, pointCount, spotCount, areaCount, iesReferenceCount });
}

// ---- 既有场景合同适配(消费方零迁移:ClusteredLights → MegaLight 池) ----

export function megaLightFromPoint(light: PointLight): MegaLight {
  return { kind: "point", positionView: light.positionView, range: light.range, color: light.color,
    intensity: light.intensity, decay: light.decay ?? 2 };
}

export function megaLightFromSpot(light: SpotLight, iesSpotIndex?: number): MegaLight {
  return { kind: "spot", positionView: light.positionView, range: light.range, color: light.color,
    intensity: light.intensity, decay: light.decay ?? 2, directionView: light.directionView,
    innerConeCos: light.innerConeCos, outerConeCos: light.outerConeCos,
    ...(iesSpotIndex === undefined ? {} : { iesSpotIndex }) };
}

export function megaLightFromArea(light: AreaLight): MegaLight {
  return { kind: "area", positionView: light.positionView, range: light.range, color: light.color,
    intensity: light.intensity, decay: 2, directionView: light.directionView, upView: light.upView,
    halfExtent: [...light.halfExtent] as [number, number],
    ...(light.twoSided === undefined ? {} : { twoSided: light.twoSided }) };
}

/**
 * ClusteredLights → 万灯池:点/聚/面积全量入池(spot 序 = packClusteredLights 序,
 * iesSpotIndex 与 packIesShading 的参数行一一对齐——E02 复用同一行号空间)。
 * 面积光同时仍可走既有 LTC 路径(双通路不互斥,由 resolveDirectLightingPath 决策)。
 */
export function megaLightsFromClustered(lights: ClusteredLights): readonly MegaLight[] {
  const result: MegaLight[] = [];
  for (const point of lights.points ?? []) result.push(megaLightFromPoint(point));
  (lights.spots ?? []).forEach((spot, index) => result.push(megaLightFromSpot(spot, spot.ies === undefined ? undefined : index)));
  for (const area of lights.areas ?? []) result.push(megaLightFromArea(area));
  if (result.length > MAX_MEGA_LIGHTS) throw new Error(`Mega light count exceeds ${MAX_MEGA_LIGHTS}.`);
  return result;
}

// ---- 直射通路选择(纯函数,能力映射由调用方按 rendererCapabilityManifest 处理) ----

export type DirectLightingPath = "cluster-forward-plus" | "megalights-ris";

export interface DirectLightingPathDecision {
  readonly path: DirectLightingPath;
  /** 决策依据(遥测/诊断直读;词汇封闭,测试钉死)。 */
  readonly reason: "within-cluster-budget" | "light-count-exceeds-cluster-budget" | "megalights-forced";
  readonly localLightCount: number;
  readonly areaCount: number;
}

export interface DirectLightingPathInput {
  readonly points: number;
  readonly spots: number;
  readonly areas?: number;
  /** 显式开关:true 强制 MegaLights(≤64 盏也可,用于 ⑤ 退化对拍);缺省自动。 */
  readonly forceMegaLights?: boolean;
  /** 簇光预算(缺省 64;预留调参口,合同上限 MAX_MEGA_LIGHTS)。 */
  readonly clusterBudget?: number;
}

/**
 * 直射通路选择:≤预算走既有簇光快路径(逐灯着色,既有字节路径零改动),
 * 超预算或显式开关走 MegaLights RIS(任务书 M1 要点 4)。
 * 面积光不参与决策(两通路都常驻面积光路径;RIS 池内面积光为中心点近似)。
 */
export function resolveDirectLightingPath(input: DirectLightingPathInput): DirectLightingPathDecision {
  const { points, spots } = input;
  if (!Number.isSafeInteger(points) || points < 0 || !Number.isSafeInteger(spots) || spots < 0) {
    throw new Error("direct lighting path needs nonnegative light counts.");
  }
  const areaCount = input.areas ?? 0;
  if (!Number.isSafeInteger(areaCount) || areaCount < 0) throw new Error("area count must be a nonnegative integer.");
  const clusterBudget = input.clusterBudget ?? MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET;
  if (!Number.isSafeInteger(clusterBudget) || clusterBudget < 1 || clusterBudget > MAX_MEGA_LIGHTS) {
    throw new Error("cluster budget must be inside [1, MAX_MEGA_LIGHTS].");
  }
  const localLightCount = points + spots;
  if (input.forceMegaLights === true) {
    return { path: "megalights-ris", reason: "megalights-forced", localLightCount, areaCount };
  }
  if (localLightCount > clusterBudget) {
    return { path: "megalights-ris", reason: "light-count-exceeds-cluster-budget", localLightCount, areaCount };
  }
  return { path: "cluster-forward-plus", reason: "within-cluster-budget", localLightCount, areaCount };
}

// ---- CPU 权威参考(与 WGSL 采样/着色核同式;验收 ②④⑤ 的真值端) ----

export interface MegaLightSurface {
  readonly positionView: LightVector3;
  readonly normalView: LightVector3;
  /** 单位视向量(指向相机)。 */
  readonly view: LightVector3;
  readonly baseColor: LightVector3;
  readonly metallic: number;
  readonly roughness: number;
}

const PI = Math.PI;

function dot3(a: LightVector3, b: LightVector3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function safeNormalize(value: LightVector3, fallback: LightVector3): LightVector3 {
  const length = Math.hypot(...value);
  return length > 1e-8 ? [value[0] / length, value[1] / length, value[2] / length] : fallback;
}

/** range 衰减(与 clusterLightingPbrWgsl.deepClusterRangeAttenuation 同式)。 */
export function megaLightRangeAttenuationCpu(distanceSquared: number, range: number, decay: number): number {
  const falloff = 1 / Math.max(Math.pow(Math.max(Math.sqrt(distanceSquared), 1e-8), decay), 0.01);
  if (range === 0) return falloff;
  if (distanceSquared >= range * range) return 0;
  const ratioSquared = distanceSquared / Math.max(range * range, 1e-4);
  const window = Math.max(1 - ratioSquared * ratioSquared, 0);
  if (decay === 2) return window * window / Math.max(distanceSquared, 0.01);
  return window * window * falloff;
}

/** 聚光锥(与 lightAbiWgsl.deepSpotAttenuation 同式:smoothstep)。 */
export function megaLightSpotConeCpu(coneCos: number, outerCos: number, coneScale: number): number {
  if (coneScale === 0) return coneCos >= outerCos ? 1 : 0;
  const coneWeight = Math.min(Math.max((coneCos - outerCos) * coneScale, 0), 1);
  return coneWeight * coneWeight * (3 - 2 * coneWeight);
}

/** 单灯 BRDF 贡献(与 clusterLightingPbrWgsl.deepClusterBrdf 同式:Lambert + GGX 相关 Smith)。 */
export function megaLightBrdfCpu(light: MegaLight, surface: MegaLightSurface, radianceScale: number): LightVector3 {
  const toLight: LightVector3 = [light.positionView[0] - surface.positionView[0],
    light.positionView[1] - surface.positionView[1], light.positionView[2] - surface.positionView[2]];
  const distanceSquared = dot3(toLight, toLight);
  const attenuation = megaLightRangeAttenuationCpu(distanceSquared, light.range, light.decay);
  if (attenuation <= 0) return [0, 0, 0];
  const surfaceToLight = safeNormalize(toLight, surface.normalView);
  const nDotL = Math.min(Math.max(dot3(surface.normalView, surfaceToLight), 0), 1);
  if (nDotL <= 0) return [0, 0, 0];
  const normal = safeNormalize(surface.normalView, [0, 0, 1]);
  const view = safeNormalize(surface.view, normal);
  const halfVector = safeNormalize([view[0] + surfaceToLight[0], view[1] + surfaceToLight[1], view[2] + surfaceToLight[2]], normal);
  const nDotV = Math.min(Math.max(dot3(normal, view), 1e-4), 1);
  const nDotH = Math.min(Math.max(dot3(normal, halfVector), 0), 1);
  const vDotH = Math.min(Math.max(dot3(view, halfVector), 0), 1);
  const roughness = Math.min(Math.max(surface.roughness, 0.045), 1);
  const metallic = Math.min(Math.max(surface.metallic, 0), 1);
  const baseColor = [Math.max(surface.baseColor[0]!, 0), Math.max(surface.baseColor[1]!, 0), Math.max(surface.baseColor[2]!, 0)];
  const f0 = [0.04 * (1 - metallic) + baseColor[0]! * metallic,
    0.04 * (1 - metallic) + baseColor[1]! * metallic, 0.04 * (1 - metallic) + baseColor[2]! * metallic];
  const fresnelFactor = 2 ** ((-5.55473 * vDotH - 6.98316) * vDotH);
  const fresnel = f0.map(component => component * (1 - fresnelFactor) + fresnelFactor);
  const alpha = roughness * roughness, alpha2 = alpha * alpha;
  const denominator = nDotH * nDotH * (alpha2 - 1) + 1;
  const distribution = alpha2 / Math.max(PI * denominator * denominator, 1e-6);
  const gv = nDotL * Math.sqrt(alpha2 + (1 - alpha2) * nDotV * nDotV);
  const gl = nDotV * Math.sqrt(alpha2 + (1 - alpha2) * nDotL * nDotL);
  const visibility = 0.5 / Math.max(gv + gl, 1e-6);
  const diffuse: LightVector3 = [baseColor[0]! * (1 - metallic) * PI_FACTOR,
    baseColor[1]! * (1 - metallic) * PI_FACTOR, baseColor[2]! * (1 - metallic) * PI_FACTOR];
  const radiance = [light.color[0] * light.intensity * attenuation * radianceScale,
    light.color[1] * light.intensity * attenuation * radianceScale,
    light.color[2] * light.intensity * attenuation * radianceScale];
  // 与 clusterLightingPbrWgsl.deepClusterBrdf 同式:末项 ×nDotL(2026-10-04 真机对拍
  // 抓出的镜像缺项——nDotL 只做了 early-out,未进乘法,偏差 = 平均 nDotL ≈ 14%)。
  return [
    (diffuse[0]! + distribution * visibility * fresnel[0]!) * radiance[0]! * nDotL,
    (diffuse[1]! + distribution * visibility * fresnel[1]!) * radiance[1]! * nDotL,
    (diffuse[2]! + distribution * visibility * fresnel[2]!) * radiance[2]! * nDotL,
  ];
}

const PI_FACTOR = 1 / PI;

/**
 * 单灯贡献(聚光锥 + 面积光中心点近似全链)。`iesFactor` 钩子缺省恒等(无 IES);
 * 携带 iesSpotIndex 的灯由调用方经 iesShading.evaluateIesShadingFactor 注入真值。
 * 钩子第二参 = 本灯 surfaceToLight 单位向量(与 WGSL deepSpotIesFactor 的
 * surfaceToLightDirection 同域,2026-10-06 随 native IES 注入切片开放;原单参闭包
 * 无消费方,签名扩展向后兼容)。radianceScale 供 RIS 权重回路复用(权重 = 贡献亮度,
 * 胜者着色 = 贡献 × 权重和/(M×选中概率),同 Bitterli RIS 公式)。
 */
export function evaluateMegaLightCpu(light: MegaLight, surface: MegaLightSurface,
  iesFactor: (light: MegaLight, surfaceToLight: LightVector3) => number = () => 1): LightVector3 {
  if (light.kind === "area") {
    const toSurface: LightVector3 = [surface.positionView[0] - light.positionView[0],
      surface.positionView[1] - light.positionView[1], surface.positionView[2] - light.positionView[2]];
    const facing = dot3(toSurface, safeNormalize(light.directionView ?? [0, 0, 1], [0, 0, 1]));
    if (!(light.twoSided ?? false) && facing < 0) return [0, 0, 0];
    if (light.range > 0 && Math.hypot(...toSurface) > light.range) return [0, 0, 0];
    return megaLightBrdfCpu(light, surface, megaAreaLightExtentFactor(light));
  }
  const toLight: LightVector3 = [light.positionView[0] - surface.positionView[0],
    light.positionView[1] - surface.positionView[1], light.positionView[2] - surface.positionView[2]];
  const distance = Math.max(Math.hypot(...toLight), 1e-8);
  // surfaceToLight 提升到锥分支外(与 WGSL deepMegaContribution 同位:IES 钩子与
  // 锥共用同一单位向量;point 分支同样可消费钩子)。
  const surfaceToLight: LightVector3 = [toLight[0] / distance, toLight[1] / distance, toLight[2] / distance];
  let cone = 1;
  if (light.kind === "spot") {
    const direction = safeNormalize(light.directionView ?? [0, 0, 1], [0, 0, 1]);
    const coneScale = light.innerConeCos === light.outerConeCos ? 0 : 1 / ((light.innerConeCos ?? 1) - (light.outerConeCos ?? -1));
    cone = megaLightSpotConeCpu(-dot3(surfaceToLight, direction), light.outerConeCos ?? -1, coneScale);
  }
  if (cone <= 0) return [0, 0, 0];
  return megaLightBrdfCpu(light, surface, cone * iesFactor(light, surfaceToLight));
}
