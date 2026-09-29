/**
 * I-C6 物理大气散射天空 —— 运行时采样器与 equirect 环境图生成(CPU)。
 *
 * 与权威路径的关系:产出的 RadianceHdrImage 形状对象直接喂给 PbrEnvironmentSource
 * 的 `radiance-hdr` 源(createHdrEnvironment 做 GGX 预滤波 + 漫反射辐照 + 背景全景),
 * IBL 能量链零改动 —— 天空只是"环境辐照输入"的替代,不是放大器(白炉守恒前提)。
 * opt-in 决策在 atmosphereSkyGate.ts,本文件只做采样与图像。
 *
 * 采样:预计算表(atmosphereTables.ts,sha256 自钉)+ 解析相函数:
 *   L_c = P_R(γ)·S_R,c + P_M(γ)·(T/T0)·S_M,c + iso_c(μv,μs) + a_c(μv,μs)·P_R(γ)
 * 其中 T/T0 = 浊度缩放(仅 Mie 分量;Rayleigh 与 MS 不缩放,MS 对浊度一阶不敏感)。
 * 表域外:μv 钳到 [0,1](下半球走 Lambert 地面反射);μs 钳到表域(地平下自然熄灭)。
 * 太阳圆盘不进天空场:太阳直射归作者方向灯,避免 IBL 与直射重复计能;太阳方向
 * 颜色由透射表提供(atmosphereSunTransmittance)。
 *
 * 全 f64 采样、f32 表;零三方依赖;同输入逐位同输出。
 */

import {
  ATMOSPHERE_GRID, ATMOSPHERE_REFERENCE_TURBIDITY, DEFAULT_GROUND_ALBEDO, SUN_COSINE_TABLE_MIN,
  assembleSkyLuminance, miePhaseFunction, rayleighPhaseFunction, sampleLinear, sampleTrilinear,
  sunMuFromTableU, tableUFromSunMu, tableUFromViewMu, viewMuFromTableU,
} from "./atmosphereModel.js";
import { DEEP_ATMOSPHERE_TABLES_SHA256, ATMOSPHERE_TABLE_SHA256, decodeAtmosphereTableBuffers } from "./atmosphereTables.js";
import { sha256Bytes } from "../shaderPackage/hash.js";
import type { Vec3 } from "./skyReference.js";

/** 解码后的三表(进程内惰性单例;解码时校验逐表 sha256)。 */
export interface DecodedAtmosphereTables {
  readonly transmittance: Float32Array;
  readonly single: Float32Array;
  readonly multiple: Float32Array;
}

let decodedTables: DecodedAtmosphereTables | undefined;

/** 解码预计算表(首次调用解码并校验 sha256,之后返回缓存实例)。 */
export function atmosphereTables(): DecodedAtmosphereTables {
  if (decodedTables) return decodedTables;
  const buffers = decodeAtmosphereTableBuffers();
  const verify = (table: Float32Array, expected: string, name: string): void => {
    const actual = sha256Bytes(new Uint8Array(table.buffer, table.byteOffset, table.byteLength));
    if (actual !== expected) {
      throw new Error(`Atmosphere ${name} table sha256 mismatch: expected ${expected}, got ${actual}.`
        + ` Regenerate via scripts/generateAtmosphereTables.mts.`);
    }
  };
  verify(buffers.transmittance, ATMOSPHERE_TABLE_SHA256.transmittance, "transmittance");
  verify(buffers.single, ATMOSPHERE_TABLE_SHA256.single, "single");
  verify(buffers.multiple, ATMOSPHERE_TABLE_SHA256.multiple, "multiple");
  decodedTables = buffers;
  return decodedTables;
}

/** 预计算表整体指纹(供测试与诊断断言)。 */
export const ATMOSPHERE_TABLES_FINGERPRINT = DEEP_ATMOSPHERE_TABLES_SHA256;

/** 天空参数:turbidity ∈ [1.9,10](与 T09 skyReference 同域),太阳方向 ENU 单位矢量。 */
export interface AtmosphereSkyParameters {
  readonly turbidity: number;
  /** 太阳方向(ENU,单位矢量,z 向上;地平下由表与地影几何自然熄灭)。 */
  readonly sunDirectionEnu: Vec3;
  /** Mie HG 非对称因子,默认 0.8(与 T09 同默认)。 */
  readonly mieAnisotropy?: number;
  /** Lambert 地面反照率(下半球反射与多次散射回流),默认 0.1。 */
  readonly groundAlbedo?: number;
}

function assertParameters(parameters: AtmosphereSkyParameters): void {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new TypeError("Atmosphere sky parameters must be an object.");
  }
  const { turbidity } = parameters;
  if (!Number.isFinite(turbidity) || turbidity < 1.9 || turbidity > 10) {
    throw new RangeError("Atmosphere sky turbidity must be finite in [1.9, 10].");
  }
  const [x, y, z] = parameters.sunDirectionEnu;
  if (!Number.isFinite(Math.hypot(x, y, z)) || Math.abs(Math.hypot(x, y, z) - 1) > 1e-4) {
    throw new RangeError("Atmosphere sky sunDirectionEnu must be a unit vector.");
  }
}

/**
 * 表域内采样天空辐亮度(不含太阳圆盘;viewMu = 视线天顶余弦,cosGamma = 视线·太阳)。
 * 这是运行时与测试的单一采样路径(与生成器重建同构)。
 */
export function evaluateAtmosphereSkyLuminance(parameters: AtmosphereSkyParameters,
  viewMu: number, cosGamma: number, out: Float32Array): void {
  assertParameters(parameters);
  const tables = atmosphereTables();
  const clampedViewMu = Math.min(Math.max(viewMu, 0), 1);
  const uView = tableUFromViewMu(clampedViewMu, ATMOSPHERE_GRID.viewExponent);
  const uSun = tableUFromSunMu(parameters.sunDirectionEnu[2], ATMOSPHERE_GRID.sunExponent);
  const gamma = Math.acos(Math.min(Math.max(cosGamma, -1), 1));
  const uGamma = gamma / Math.PI;
  const mieScale = parameters.turbidity / ATMOSPHERE_REFERENCE_TURBIDITY;
  const anisotropy = parameters.mieAnisotropy ?? 0.8;
  const singlePlane = ATMOSPHERE_GRID.singleViewCount * ATMOSPHERE_GRID.singleSunCount * ATMOSPHERE_GRID.singleGammaCount;
  const multiplePlane = ATMOSPHERE_GRID.multipleViewCount * ATMOSPHERE_GRID.multipleSunCount;
  const phaseR = rayleighPhaseFunction(cosGamma);
  const phaseM = miePhaseFunction(cosGamma, anisotropy);
  for (let channel = 0; channel < 3; channel += 1) {
    const rayleigh = sampleTrilinear(tables.single,
      [ATMOSPHERE_GRID.singleViewCount, ATMOSPHERE_GRID.singleSunCount, ATMOSPHERE_GRID.singleGammaCount],
      uView, uSun, uGamma, channel * singlePlane);
    const mie = sampleTrilinear(tables.single,
      [ATMOSPHERE_GRID.singleViewCount, ATMOSPHERE_GRID.singleSunCount, ATMOSPHERE_GRID.singleGammaCount],
      uView, uSun, uGamma, (3 + channel) * singlePlane);
    const iso = sampleTrilinear(tables.multiple,
      [ATMOSPHERE_GRID.multipleViewCount, ATMOSPHERE_GRID.multipleSunCount, 1], uView, uSun, 0,
      channel * multiplePlane);
    const coefficient = sampleTrilinear(tables.multiple,
      [ATMOSPHERE_GRID.multipleViewCount, ATMOSPHERE_GRID.multipleSunCount, 1], uView, uSun, 0,
      3 * multiplePlane);
    out[channel] = rayleigh * phaseR + mie * phaseM * mieScale + iso + coefficient * phaseR;
  }
}

const luminanceScratch = new Float32Array(3);

/** 方向采样天空辐亮度(ENU 单位矢量;下半球为 Lambert 地面反射)。 */
export function sampleAtmosphereSkyRadiance(parameters: AtmosphereSkyParameters,
  directionEnu: Vec3): Vec3 {
  assertParameters(parameters);
  const [x, y, z] = directionEnu;
  const length = Math.hypot(x, y, z);
  const viewMu = z / length;
  if (viewMu >= 0) {
    const [sx, sy, sz] = parameters.sunDirectionEnu;
    const cosGamma = Math.min(Math.max((x * sx + y * sy + z * sz) / length, -1), 1);
    evaluateAtmosphereSkyLuminance(parameters, viewMu, cosGamma, luminanceScratch);
    return Object.freeze([luminanceScratch[0]!, luminanceScratch[1]!, luminanceScratch[2]!]) as Vec3;
  }
  const ground = atmosphereGroundReflectedRadiance(parameters);
  return Object.freeze([ground[0], ground[1], ground[2]]) as Vec3;
}

interface GroundCacheEntry {
  readonly key: string;
  readonly radiance: Vec3;
}
let groundCache: GroundCacheEntry | undefined;

/** 下半球:地面反照率 × 上半球余弦加权辐照(数值积分,参数键控缓存)。 */
export function atmosphereGroundReflectedRadiance(parameters: AtmosphereSkyParameters): Vec3 {
  const albedo = parameters.groundAlbedo ?? DEFAULT_GROUND_ALBEDO;
  const key = `${parameters.turbidity}|${parameters.sunDirectionEnu.join(",")}|`
    + `${parameters.mieAnisotropy ?? 0.8}|${albedo}`;
  if (groundCache?.key === key) return groundCache.radiance;
  const rows = 24, columns = 12;
  const deltaOmega = (1 / rows) * (2 * Math.PI / columns); // μ 均匀网格的立体角微元
  const accumulated: [number, number, number] = [0, 0, 0];
  const scratch = new Float32Array(3);
  for (let row = 0; row < rows; row += 1) {
    const viewMu = viewMuFromTableU((row + 0.5) / rows, ATMOSPHERE_GRID.viewExponent);
    const radial = Math.sqrt(Math.max(0, 1 - viewMu * viewMu));
    for (let column = 0; column < columns; column += 1) {
      const azimuth = 2 * Math.PI * (column + 0.5) / columns;
      const dx = radial * Math.cos(azimuth), dy = radial * Math.sin(azimuth);
      const [sx, sy, sz] = parameters.sunDirectionEnu;
      const cosGamma = Math.min(Math.max(dx * sx + dy * sy + viewMu * sz, -1), 1);
      evaluateAtmosphereSkyLuminance(parameters, viewMu, cosGamma, scratch);
      accumulated[0] += scratch[0]! * viewMu; accumulated[1] += scratch[1]! * viewMu;
      accumulated[2] += scratch[2]! * viewMu;
    }
  }
  const radiance = Object.freeze([
    albedo / Math.PI * accumulated[0] * deltaOmega,
    albedo / Math.PI * accumulated[1] * deltaOmega,
    albedo / Math.PI * accumulated[2] * deltaOmega,
  ]) as Vec3;
  groundCache = { key, radiance };
  return radiance;
}

/** 太阳方向透射率(表插值,含地影;供方向灯颜色映射,不进天空场)。 */
export function atmosphereSunTransmittance(parameters: AtmosphereSkyParameters): Vec3 {
  assertParameters(parameters);
  const tables = atmosphereTables();
  const count = tables.transmittance.length / 3;
  const out: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const plane: number[] = [];
    for (let index = 0; index < count; index += 1) plane.push(tables.transmittance[index * 3 + channel]!);
    out[channel] = sampleLinear(plane, SUN_COSINE_TABLE_MIN, 1, parameters.sunDirectionEnu[2]);
  }
  return Object.freeze(out) as Vec3;
}

export interface AtmosphereSkyImage extends RadianceHdrImageShape {
  readonly parametersKey: string;
}

/** RadianceHdrImage 形状(structural,避免依赖 webgpu 包层;linear-sRGB、top-left 行主序、第 0 行 = 天顶)。 */
export interface RadianceHdrImageShape {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array<ArrayBuffer>;
}

const imageCache = new Map<string, AtmosphereSkyImage>();

/**
 * 生成等距柱状天空环境图(RadianceHdrImage 形状):第 0 行 = 天顶、
 * 方位角自 -π 起行主序,与引擎 `equirectangular()` 采样方向一致。
 * 参数键控缓存;width/height 必须 ≥8。
 */
export function atmosphereSkyEnvironmentImage(parameters: AtmosphereSkyParameters,
  width = 256, height = 128): AtmosphereSkyImage {
  assertParameters(parameters);
  if (!Number.isSafeInteger(width) || width < 8 || width > 4096
    || !Number.isSafeInteger(height) || height < 8 || height > 4096) {
    throw new RangeError("Atmosphere sky image dimensions must be integers in [8, 4096].");
  }
  const parametersKey = `t=${parameters.turbidity},s=${parameters.sunDirectionEnu.join(",")},`
    + `g=${parameters.mieAnisotropy ?? 0.8},a=${parameters.groundAlbedo ?? DEFAULT_GROUND_ALBEDO},`
    + `w=${width},h=${height}`;
  const cached = imageCache.get(parametersKey);
  if (cached) return cached;
  const data = new Float32Array(width * height * 3);
  const scratch = new Float32Array(3);
  const [sx, sy, sz] = parameters.sunDirectionEnu;
  const ground = atmosphereGroundReflectedRadiance(parameters);
  for (let row = 0; row < height; row += 1) {
    // 等距柱状:polar ∈ (0,π),第 0 行 = 天顶(与 studioNeutralEnvironmentImage 同约定)。
    const polar = ((row + 0.5) / height) * Math.PI;
    const sinPolar = Math.sin(polar), cosPolar = Math.cos(polar);
    for (let column = 0; column < width; column += 1) {
      const azimuth = ((column + 0.5) / width - 0.5) * 2 * Math.PI;
      const dx = sinPolar * Math.cos(azimuth), dy = cosPolar, dz = sinPolar * Math.sin(azimuth);
      const offset = (row * width + column) * 3;
      if (cosPolar >= 0) {
        const cosGamma = Math.min(Math.max(dx * sx + dy * sy + dz * sz, -1), 1);
        evaluateAtmosphereSkyLuminance(parameters, cosPolar, cosGamma, scratch);
        data[offset] = scratch[0]!; data[offset + 1] = scratch[1]!; data[offset + 2] = scratch[2]!;
      } else {
        data[offset] = ground[0]; data[offset + 1] = ground[1]; data[offset + 2] = ground[2];
      }
    }
  }
  const image: AtmosphereSkyImage = Object.freeze({
    width, height, data, parametersKey,
  });
  if (imageCache.size > 8) imageCache.clear();
  imageCache.set(parametersKey, image);
  return image;
}

/** 表域常数再导出(gate 与测试单源引用)。 */
export { ATMOSPHERE_GRID, SUN_COSINE_TABLE_MIN, sunMuFromTableU, viewMuFromTableU };
