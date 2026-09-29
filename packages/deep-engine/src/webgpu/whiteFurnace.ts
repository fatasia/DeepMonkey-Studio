import { decodeHalfFloat } from "../rayTracing/probeGridBakeMath.js";
import type { RadianceHdrImage } from "../textures/radianceHdr.js";

/**
 * C12 白炉(white furnace)验收核心——纯 CPU 参考,无 GPU/DOM/Node 依赖。
 *
 * 白炉配置:全白 Lambert(albedo 1、rough 1、metal 0)+ 均匀恒定辐射度环境 E +
 * 禁用方向灯/雾/地面/AO/bloom/TAA。渲染不变量:任意出射辐射度 ≡ E——背景全景是
 * 直采样,白 Lambert 面 = base · irradiance(diffuse cube 存 irradiance/π,均匀环境
 * 卷积恰为 E,见 environmentShader/shade 契约),SSR 合成 color·(1−a)+radiance·a 在
 * radiance≡E 的炉内对任意 mask 净零。偏差只能来自着色能量错误(过亮/暗/色偏),
 * 因此断言即能量守恒断言:mean/max/p99 相对误差 + RGB 通道增益(色偏)。
 */

/** 白炉环境辐射度(线性 HDR);0.5 留出双向误差余量,避免半精度钳制混淆。 */
export const WHITE_FURNACE_ENVIRONMENT_RADIANCE = 0.5;

/** 相对误差容差:background 是纯采样链;geometry 含 IBL 卷积、DFG 采样与 half 缓冲。 */
export const FURNACE_TOLERANCES = Object.freeze({
  backgroundMeanRelative: 0.005,
  backgroundMaxRelative: 0.02,
  geometryMeanRelative: 0.02,
  geometryMaxRelative: 0.08,
  /** RGB 均值相对亮度通道的增益漂移;均匀炉内三通道必须等值。 */
  channelGainDrift: 0.02,
  /** SSR 开/关逐像素净差 p99(替换式合成必须净零;半分辨率上采样留插值余量)。 */
  ssrToggleP99Delta: 0.02,
});

export type FurnaceRegion = "background" | "geometry";

export interface FurnaceRegionStats {
  readonly region: FurnaceRegion;
  readonly pixels: number;
  readonly meanRadiance: number;
  readonly meanRelativeError: number;
  readonly maxAbsRelativeError: number;
  readonly p99AbsRelativeError: number;
  /** mean(channel)/mean(luma);>1 表示该通道能量泄漏(色偏检测)。 */
  readonly channelGain: readonly [number, number, number];
}

export interface FurnaceAnalysis {
  readonly environmentRadiance: number;
  readonly background: FurnaceRegionStats;
  readonly geometry: FurnaceRegionStats | undefined;
  readonly global: FurnaceRegionStats;
}

/**
 * 区域分割:0=geometry、1=background、2=排除环带(已知圆盘轮廓附近硬边缘,
 * 不进任何域的统计)。undefined = 全帧单一区域(box 腿全几何、background 腿全背景)。
 */
export type FurnaceSegmentation = readonly number[] | undefined;

/** 均匀恒定灰度等距柱状 HDR;白炉环境唯一来源。 */
export function uniformFurnaceEquirect(radiance: number = WHITE_FURNACE_ENVIRONMENT_RADIANCE,
  width = 64, height = 32): RadianceHdrImage {
  if (!(Number.isFinite(radiance) && radiance > 0)) throw new RangeError("Furnace radiance must be finite and positive.");
  const data = new Float32Array(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 3] = radiance; data[index * 3 + 1] = radiance; data[index * 3 + 2] = radiance;
  }
  return { width, height, data };
}

/** 白 Lambert 材质:albedo 1、rough 1、metal 0;白炉的被测表面。 */
export const WHITE_LAMBERTIAN_MATERIAL = Object.freeze({ baseColor: [1, 1, 1] as const,
  metallic: 0, roughness: 1 });

/** 12 浮点/实例布局(与 spherePacket 契约一致):pos3 半径 rgb 金属 粗糙 000。 */
export function packFurnaceSphere(instances: ReadonlyArray<{ readonly position: readonly [number, number, number];
  readonly radius: number; readonly material?: typeof WHITE_LAMBERTIAN_MATERIAL }>): Float32Array<ArrayBuffer> {
  const data = new Float32Array(instances.length * 12);
  instances.forEach((instance, index) => {
    if (!(Number.isFinite(instance.radius) && instance.radius > 0)) {
      throw new RangeError("Furnace instance radius must be finite and positive.");
    }
    const material = instance.material ?? WHITE_LAMBERTIAN_MATERIAL;
    data.set([instance.position[0]!, instance.position[1]!, instance.position[2]!, instance.radius,
      material.baseColor[0], material.baseColor[1], material.baseColor[2],
      material.metallic, material.roughness], index * 12);
  });
  return data;
}

/**
 * 球腿的解析轮廓分割:已知相机(eye/target/fov)、球心与半径,轮廓是屏空间圆盘。
 * 返回 regionOf(geometry 0 / background 1 / 环带 2),环带内外各留安全带避免边缘像素。
 */
export function furnaceSphereSegmentation(width: number, height: number,
  eyeDistance: number, radius: number, verticalFovRadians: number): readonly number[] {
  const alpha = Math.asin(Math.min(radius / eyeDistance, 1));
  const discRadius = Math.tan(alpha) / Math.tan(verticalFovRadians / 2) * (height / 2);
  const guard = Math.max(1, discRadius * 0.08);
  const center = [width / 2, height / 2];
  const regionOf = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x + 0.5 - center[0]!, y + 0.5 - center[1]!);
      regionOf[y * width + x] = distance < discRadius - guard ? 0 : distance > discRadius + guard ? 1 : 2;
    }
  }
  return regionOf;
}

/** 解码 present-color(rgba16float)为逐像素线性 HDR rgb 紧凑数组。 */
export function decodeFurnaceColor(snapshot: { readonly width: number; readonly height: number;
  readonly bytesPerRow: number; readonly format: string; readonly bytes: Uint8Array }): Float32Array {
  if (snapshot.format !== "rgba16float") throw new Error(`Furnace color readback must be rgba16float, got ${snapshot.format}.`);
  const words = new Uint16Array(snapshot.bytes.buffer, snapshot.bytes.byteOffset, snapshot.bytes.byteLength / 2);
  const stride = snapshot.bytesPerRow / 2;
  const pixels = new Float32Array(snapshot.width * snapshot.height * 3);
  for (let y = 0; y < snapshot.height; y += 1) {
    for (let x = 0; x < snapshot.width; x += 1) {
      const source = y * stride + x * 4, target = (y * snapshot.width + x) * 3;
      pixels[target] = decodeHalfFloat(words[source]!);
      pixels[target + 1] = decodeHalfFloat(words[source + 1]!);
      pixels[target + 2] = decodeHalfFloat(words[source + 2]!);
    }
  }
  return pixels;
}

function regionStats(pixels: Float32Array, segmentation: FurnaceSegmentation, environment: number,
  region: FurnaceRegion): FurnaceRegionStats {
  const want = region === "background" ? 1 : 0;
  let count = 0, lumaSum = 0;
  const channelSums: [number, number, number] = [0, 0, 0], relative: number[] = [];
  for (let index = 0; index < pixels.length / 3; index += 1) {
    if (segmentation && segmentation[index] !== want) continue;
    const base = index * 3;
    const r = pixels[base]!, g = pixels[base + 1]!, b = pixels[base + 2]!;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    count += 1; lumaSum += luma;
    channelSums[0] += r; channelSums[1] += g; channelSums[2] += b;
    relative.push(Math.abs(luma - environment) / environment);
  }
  if (count === 0) {
    return Object.freeze({ region, pixels: 0, meanRadiance: NaN, meanRelativeError: NaN,
      maxAbsRelativeError: NaN, p99AbsRelativeError: NaN, channelGain: [NaN, NaN, NaN] as const });
  }
  relative.sort((left, right) => left - right);
  const meanLuma = lumaSum / count;
  const gain = channelSums.map(channel => channel / count / meanLuma) as [number, number, number];
  return Object.freeze({ region, pixels: count, meanRadiance: meanLuma,
    meanRelativeError: (meanLuma - environment) / environment,
    maxAbsRelativeError: relative[relative.length - 1]!,
    p99AbsRelativeError: relative[Math.min(relative.length - 1, Math.floor(0.99 * relative.length))]!,
    channelGain: Object.freeze(gain) });
}

function emptyRegionStats(region: FurnaceRegion): FurnaceRegionStats {
  return Object.freeze({ region, pixels: 0, meanRadiance: NaN, meanRelativeError: NaN,
    maxAbsRelativeError: NaN, p99AbsRelativeError: NaN, channelGain: [NaN, NaN, NaN] as const });
}

/** 白炉帧分析;segmentation 缺省 = 全帧单一域(singleRegion 声明该域是背景还是几何)。 */
export function analyzeFurnaceFrame(color: Float32Array, environmentRadiance: number,
  segmentation: FurnaceSegmentation, singleRegion: FurnaceRegion): FurnaceAnalysis {
  if (!Number.isFinite(environmentRadiance) || environmentRadiance <= 0) {
    throw new RangeError("Furnace environment radiance must be finite and positive.");
  }
  const background = segmentation !== undefined || singleRegion === "background"
    ? regionStats(color, segmentation, environmentRadiance, "background")
    : emptyRegionStats("background");
  const geometry = segmentation !== undefined || singleRegion === "geometry"
    ? regionStats(color, segmentation, environmentRadiance, "geometry")
    : undefined;
  return Object.freeze({ environmentRadiance, background, geometry,
    global: regionStats(color, undefined, environmentRadiance, "background") });
}

export interface FurnaceCheck { readonly name: string; readonly passed: boolean; readonly detail: string }

const percent = (value: number): string => `${(100 * value).toFixed(3)}%`;

/**
 * 能量守恒断言:存在的域(background/geometry 各自在 pixels>0 时)逐项断言,
 * 全空帧 fail-closed。腿按场景声明域;缺域不是缺陷(背景腿无几何域,盒腿无背景域)。
 */
export function evaluateFurnaceChecks(analysis: FurnaceAnalysis): readonly FurnaceCheck[] {
  const checks: FurnaceCheck[] = [];
  const add = (name: string, passed: boolean, detail: string): void => {
    checks.push(Object.freeze({ name, passed, detail }));
  };
  const background = analysis.background;
  const geometry = analysis.geometry;
  const anyPixels = background.pixels > 0 || (geometry?.pixels ?? 0) > 0;
  add("furnace-frame-nonempty", anyPixels,
    `background=${background.pixels} geometry=${geometry?.pixels ?? 0}`);
  if (background.pixels > 0) {
    add("furnace-background-uniform",
      Math.abs(background.meanRelativeError) <= FURNACE_TOLERANCES.backgroundMeanRelative
      && background.maxAbsRelativeError <= FURNACE_TOLERANCES.backgroundMaxRelative,
      `pixels=${background.pixels} meanErr=${percent(background.meanRelativeError)} maxErr=${percent(background.maxAbsRelativeError)}`);
    add("furnace-background-no-chroma-drift",
      background.channelGain.every(gain => Math.abs(gain - 1) <= FURNACE_TOLERANCES.channelGainDrift),
      `gain=[${background.channelGain.map(value => value.toFixed(4)).join(", ")}]`);
  }
  if (geometry !== undefined && geometry.pixels > 0) {
    add("furnace-geometry-conserved",
      Math.abs(geometry.meanRelativeError) <= FURNACE_TOLERANCES.geometryMeanRelative
      && geometry.maxAbsRelativeError <= FURNACE_TOLERANCES.geometryMaxRelative,
      `pixels=${geometry.pixels} meanErr=${percent(geometry.meanRelativeError)} maxErr=${percent(geometry.maxAbsRelativeError)} p99=${percent(geometry.p99AbsRelativeError)}`);
    add("furnace-geometry-no-chroma-drift",
      geometry.channelGain.every(gain => Math.abs(gain - 1) <= FURNACE_TOLERANCES.channelGainDrift),
      `gain=[${geometry.channelGain.map(value => value.toFixed(4)).join(", ")}]`);
  }
  return checks;
}

/** SSR 开/关净差断言:白炉内替换式合成必须净零;p99 逐像素 |on−off|/E。 */
export function evaluateSsrToggleChecks(on: Float32Array, off: Float32Array, environmentRadiance: number,
  segmentation: FurnaceSegmentation): readonly FurnaceCheck[] {
  if (on.length !== off.length) throw new Error("SSR on/off frames must have identical sizes.");
  const deltas: number[] = [];
  for (let index = 0; index < on.length / 3; index += 1) {
    if (segmentation && segmentation[index] === 2) continue;
    const base = index * 3;
    const lumaOn = 0.2126 * on[base]! + 0.7152 * on[base + 1]! + 0.0722 * on[base + 2]!;
    const lumaOff = 0.2126 * off[base]! + 0.7152 * off[base + 1]! + 0.0722 * off[base + 2]!;
    deltas.push(Math.abs(lumaOn - lumaOff) / environmentRadiance);
  }
  if (deltas.length === 0) {
    return [Object.freeze({ name: "ssr-toggle-neutral", passed: false, detail: "no pixels" })];
  }
  deltas.sort((left, right) => left - right);
  const p99 = deltas[Math.min(deltas.length - 1, Math.floor(0.99 * deltas.length))]!;
  return [Object.freeze({ name: "ssr-toggle-neutral", passed: p99 <= FURNACE_TOLERANCES.ssrToggleP99Delta,
    detail: `p99Delta=${percent(p99)} maxDelta=${percent(deltas[deltas.length - 1]!)} pixels=${deltas.length}` })];
}

/**
 * 缺陷模型(C12 发现项):shade() 漫反射因子 = 1 − Schlick(nv, f0, max(1−rough, f0)),
 * rough→1 时坍缩为 1−f0;而高光 split-sum 分数 f0·dfg.x+dfg.y 在 rough→1 仍是大瓣反射,
 * 且乘上多重散射补偿 comp。白炉总出射 = E·[(1−f) + f_spec·comp],过冲系数 = f_spec·comp−f。
 * 供测量对照与修复前后报告。
 */
export function predictedFurnaceOvershoot(f0: number, roughness: number, nv: number,
  dfg: readonly [number, number]): number {
  if (![f0, roughness, nv, dfg[0], dfg[1]].every(Number.isFinite)) {
    throw new RangeError("Furnace defect model inputs must be finite.");
  }
  const fresnel = f0 + (Math.max(1 - roughness, f0) - f0) * Math.pow(1 - nv, 5);
  const specular = f0 * dfg[0] + dfg[1];
  const compensation = 1 + f0 * (1 / Math.max(dfg[0] + dfg[1], 0.05) - 1);
  return specular * compensation - fresnel;
}
