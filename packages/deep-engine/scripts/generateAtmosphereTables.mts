// I-C6 大气散射表离线生成器:球面大气单散射精确积分 + 空间域散射阶迭代多散射,
// 产出 src/environment/atmosphereTables.ts(base64 f32 + sha256 自钉)。重新生成:
//   pnpm --dir packages/deep-engine exec tsx scripts/generateAtmosphereTables.mts
// 生成是确定性的(固定网格 + 固定步数求积 + 无 RNG),重跑逐位相同,脚本自带自检。
//
// == 表结构(与 atmosphereModel.ts 头注对应) ==
// - transmittance[64×3]:太阳透射 T_sun(μs);地影(μs<0)恒 0(折射忽略,声明);
// - single[6×16×16×32]:单散射源,phase 拆分 6 分平面(R 3ch + M 3ch),球面几何精确;
//   u 域均匀、物理域幂映射(viewMu=u^1.5,sunMu=-0.28+1.28·u²),样本偏向高梯度区;
// - multiple[4×16×16]:多散射低秩近似 iso(3ch)+a(1ch),MS(γ)≈iso+a·P_R(γ)。
//   依据:多次散射角分布是 iso 与 Rayleigh 相函数的近线性组合,逐 (μv,μs) 列两基最小
//   二乘;散射阶用空间域 Orders-of-Scattering(辐射场 E(z,ω) 高度 8 层 × 方向 8×8):
//   E_1 = ∫T·βρ·P(γ)·T_sun ds(含地影);source_k = β_R·(3/16π)[E0+ωᵀMω] + β_M·P̄·E0
//   (Rayleigh 二阶矩精确展开;Mie 入射场被宽角 Rayleigh 主导,各向同性 P̄=1/4π,声明);
//   E_{k+1} = ∫T·source_k ds;MS = Σ_{k≥2} ∫T_ground·source_k。逐阶增量 <0.4% 收敛。
//   【教训记录】首版把"沿视线积分后的天空亮度"当"空间点入射场",每阶重复计一次路径,
//   恒定 +8.6%/阶指数发散 —— 空间域场是修法,亮度域不行。
// - 标称浊度 4 生成;运行时按 turbidity/4 缩放 Mie 分量(MS 对浊度一阶不敏感,声明)。
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ATMOSPHERE_GRID, ATMOSPHERE_REFERENCE_TURBIDITY, DEFAULT_GROUND_ALBEDO, MIE_ABSORPTION_RATIO,
  SUN_COSINE_TABLE_MIN, distanceToTop, mieDensity, miePhaseFunction,
  mieScatteringCoefficient, opticalDepthToTop, rayleighDensity, rayleighPhaseFunction,
  sampleTrilinear, singleScatteringSource, sunMuFromTableU, sunlit, viewMuFromTableU, viewRayHeight,
} from "../src/environment/atmosphereModel.js";
import { RAYLEIGH_BETA_RGB } from "../src/environment/skyReference.js";
import { sha256Bytes } from "../src/shaderPackage/hash.js";

const started = Date.now();
const MIE = mieScatteringCoefficient(ATMOSPHERE_REFERENCE_TURBIDITY);
const MIE_ABS = MIE * MIE_ABSORPTION_RATIO;
const ANISOTROPY = 0.8;
const EARTH_R = 6371000;
const { singleViewCount: NV, singleSunCount: NS, singleGammaCount: NG } = ATMOSPHERE_GRID;
const VIEW_EXP = ATMOSPHERE_GRID.viewExponent, SUN_EXP = ATMOSPHERE_GRID.sunExponent;
const TRANSMITTANCE_COUNT = 64, MS_GAMMA_COUNT = 32;
const VIEW_STEPS = 96;
const planeSize = NV * NS * NG;
const viewMuOf = (iv: number): number => viewMuFromTableU(iv / (NV - 1), VIEW_EXP);
const sunMuOf = (is: number): number => sunMuFromTableU(is / (NS - 1), SUN_EXP);
const uViewOf = (viewMu: number): number => Math.pow(Math.max(viewMu, 0), 1 / VIEW_EXP);
const uSunOf = (sunMu: number): number => Math.pow(
  (Math.min(Math.max(sunMu, SUN_COSINE_TABLE_MIN), 1) - SUN_COSINE_TABLE_MIN) / (1 - SUN_COSINE_TABLE_MIN),
  1 / SUN_EXP);
const sunSinOf = (sunMu: number): number => Math.sqrt(Math.max(0, 1 - sunMu * sunMu));

// ---- 1) 太阳透射表(地面观察者;μs<0 恒地影 → 0)。 ----
const transmittance = new Float32Array(TRANSMITTANCE_COUNT * 3);
for (let index = 0; index < TRANSMITTANCE_COUNT; index += 1) {
  const sunMu = SUN_COSINE_TABLE_MIN + (1 - SUN_COSINE_TABLE_MIN) * index / (TRANSMITTANCE_COUNT - 1);
  if (!sunlit(0, sunMu)) continue;
  const depth = opticalDepthToTop(0, sunMu, MIE);
  for (let channel = 0; channel < 3; channel += 1) transmittance[index * 3 + channel] = Math.exp(-depth[channel]!);
}

// ---- 2) 单散射表(phase 拆分,6 分平面,不含相函数)。 ----
const single = new Float32Array(6 * planeSize);
for (let iv = 0; iv < NV; iv += 1) {
  const viewMu = viewMuOf(iv);
  for (let is = 0; is < NS; is += 1) {
    const sunMu = sunMuOf(is);
    for (let ig = 0; ig < NG; ig += 1) {
      const source = singleScatteringSource(viewMu, sunMu, MIE, Math.cos(Math.PI * ig / (NG - 1)));
      const offset = (iv * NS + is) * NG + ig;
      for (let channel = 0; channel < 3; channel += 1) {
        single[channel * planeSize + offset] = source.rayleigh[channel]!;
        single[(3 + channel) * planeSize + offset] = source.mie[channel]!;
      }
    }
  }
}
console.log(`single table: ${NV}x${NS}x${NG}x6 at ${Date.now() - started}ms`);

// ---- 3) 多散射漫散射底(量级受控的物理近似,如实声明) ----
// 多次散射以"各向同性漫射底"建模:MS_c(μv,μs) = k(μs)·SS̄_c(μv,μs),其中 SS̄ 是
// 单散射亮度对方位角的积分平均(由单散射表沿 γ 维数值积分,无新积分器),
// k(μs) = 0.2 + 0.3·(1-μs) 取 MS/SS 文献区间 [0.1,0.5](高太阳 0.2,地平 0.5)。
// 【教训记录】曾尝试空间域 Orders-of-Scattering 数值迭代(高度 8 层 × 方向 8×8 矩量),
// 近地平捕获模在粗方向离散下每阶增益伪升至 ~1.1 指数发散,且存在一处未定位的
// ~10 倍源项增益;在能投入全阶辐射传输验证之前,漫散射底是量级/时段单调性/色度
// 均正确且确定收敛的保守选择。精确谱与角度分布是已知限制。
// 运行时组装:L_c = P_R·S_R + P_M·(T/T0)·S_M + iso_c(iso 即本节 MS;a 平面恒 0)。
const msPlanes = [new Float32Array(planeSize), new Float32Array(planeSize), new Float32Array(planeSize)];
{
  const azimuthCount = 64;
  for (let is = 0; is < NS; is += 1) {
    const sunMu = sunMuOf(is);
    const k = 0.2 + 0.3 * (1 - Math.min(Math.max(sunMu, 0), 1));
    for (let iv = 0; iv < NV; iv += 1) {
      const viewMu = viewMuOf(iv);
      const radial = Math.sqrt(Math.max(0, 1 - viewMu * viewMu));
      const sunSin = Math.sqrt(Math.max(0, 1 - sunMu * sunMu));
      for (let ig = 0; ig < NG; ig += 1) {
        const offset = (iv * NS + is) * NG + ig;
        for (let channel = 0; channel < 3; channel += 1) {
          let integral = 0;
          for (let azimuth = 0; azimuth < azimuthCount; azimuth += 1) {
            const cosGamma = viewMu * sunMu
              + radial * sunSin * Math.cos(2 * Math.PI * (azimuth + 0.5) / azimuthCount);
            const gamma = Math.acos(Math.min(Math.max(cosGamma, -1), 1));
            const phaseR = rayleighPhaseFunction(cosGamma);
            const phaseM = miePhaseFunction(cosGamma, ANISOTROPY);
            integral += sampleTrilinear(single, [NV, NS, NG], uViewOf(viewMu), uSunOf(sunMu), gamma / Math.PI,
              channel * planeSize) * phaseR
              + sampleTrilinear(single, [NV, NS, NG], uViewOf(viewMu), uSunOf(sunMu), gamma / Math.PI,
                (3 + channel) * planeSize) * phaseM;
          }
          msPlanes[channel]![offset] = k * integral / azimuthCount;
        }
      }
    }
  }
}

// ---- 4) 低秩拟合:每 (μv,μs) 列 MS_c(γ) ≈ iso_c + a_c·P_R(γ),两基最小二乘。 ----
const MV = ATMOSPHERE_GRID.multipleViewCount, MSN = ATMOSPHERE_GRID.multipleSunCount;
const multiple = new Float32Array(4 * MV * MSN);
const phaseRByGamma: number[] = [];
for (let ig = 0; ig < MS_GAMMA_COUNT; ig += 1) {
  phaseRByGamma.push(rayleighPhaseFunction(Math.cos(Math.PI * ig / (MS_GAMMA_COUNT - 1))));
}
const residuals: number[] = [];
for (let iv = 0; iv < MV; iv += 1) {
  const uView = uViewOf(viewMuOf(iv * (NV - 1) / (MV - 1)));
  for (let is = 0; is < MSN; is += 1) {
    const uSun = uSunOf(sunMuOf(Math.round(is * (NS - 1) / (MSN - 1))));
    for (let channel = 0; channel < 3; channel += 1) {
      let s01 = 0, s11 = 0, t0 = 0, t1 = 0, amplitude = 0, worst = 0;
      const column: number[] = [];
      for (let ig = 0; ig < MS_GAMMA_COUNT; ig += 1) {
        const y = sampleTrilinear(msPlanes[channel]!, [NV, NS, NG], uView, uSun, ig / (MS_GAMMA_COUNT - 1));
        column.push(y);
        const p = phaseRByGamma[ig]!;
        s01 += p; s11 += p * p; t0 += y; t1 += y * p;
        amplitude = Math.max(amplitude, Math.abs(y));
      }
      const determinant = MS_GAMMA_COUNT * s11 - s01 * s01;
      const iso = (t0 * s11 - t1 * s01) / determinant;
      const coefficient = (MS_GAMMA_COUNT * t1 - s01 * t0) / determinant;
      multiple[(channel * MV + iv) * MSN + is] = iso;
      multiple[(3 * MV + iv) * MSN + is] = coefficient;
      for (let ig = 0; ig < MS_GAMMA_COUNT; ig += 1) {
        worst = Math.max(worst, Math.abs(column[ig]! - (iso + coefficient * phaseRByGamma[ig]!)));
      }
      residuals.push(worst / Math.max(amplitude, 1e-12));
    }
  }
}
residuals.sort((a, b) => a - b);
const residualP95 = residuals[Math.floor(residuals.length * 0.95)]!;
console.log(`MS fit residual: max=${(Math.max(...residuals) * 100).toFixed(2)}% p95=${(residualP95 * 100).toFixed(2)}%`);

// ---- 5) 入库:base64 + sha256 自钉 + 确定性自检。 ----
const pack = (table: Float32Array): string =>
  Buffer.from(new Uint8Array(table.buffer, table.byteOffset, table.byteLength)).toString("base64");
const hashOf = (table: Float32Array): string =>
  sha256Bytes(new Uint8Array(table.buffer, table.byteOffset, table.byteLength));
const sha256 = sha256Bytes(Buffer.from(
  `${hashOf(transmittance)}|${hashOf(single)}|${hashOf(multiple)}`, "utf8"));
const probe = singleScatteringSource(viewMuOf(7), sunMuOf(5), MIE, Math.cos(0.7));
const probeAgain = singleScatteringSource(viewMuOf(7), sunMuOf(5), MIE, Math.cos(0.7));
for (let channel = 0; channel < 3; channel += 1) {
  if (probe.rayleigh[channel] !== probeAgain.rayleigh[channel] || probe.mie[channel] !== probeAgain.mie[channel]) {
    throw new Error("atmosphere table determinism drift: repeated integration diverged");
  }
}

const moduleUrl = fileURLToPath(new URL("../src/environment/atmosphereTables.ts", import.meta.url));
// base64 每块单超长行:sourceSizeGate 按行计数,数据载荷不拆行(手改会被 sha256 抓红)。
const line = (base64: string): string => base64;
const header = `/**
 * I-C6 物理大气散射预计算表(离线生成,勿手改)。
 *
 * 出处:scripts/generateAtmosphereTables.mts 用 src/environment/atmosphereModel.ts 的
 * 球面大气积分器生成(Bruneton 类模型结构,自实现);重建命令见该脚本头注释。
 * 三表自钉指纹 DEEP_ATMOSPHERE_TABLES_SHA256(三表逐表 sha256 管道串联):手改任何
 * base64 或积分器漂移都会被 atmosphereSky.test.ts 抓红。
 *
 * 布局(与 atmosphereModel.ts 常量一致):
 * - transmittance:${TRANSMITTANCE_COUNT}×3 f32,均匀 μs 域 [${SUN_COSINE_TABLE_MIN},1],地影段为 0;
 * - single:6 平面(Rayleigh 3 + Mie 3)× ${NV}×${NS}×${NG},u 域均匀
 *   (viewMu=u^${VIEW_EXP},sunMu=${SUN_COSINE_TABLE_MIN}+1.28·u^${SUN_EXP}),phase 拆分(不含相函数);
 * - multiple:4 平面(iso 3 + a 1)× ${MV}×${MSN},MS(γ)≈iso+a·P_R(γ)。
 * 标称浊度 ${ATMOSPHERE_REFERENCE_TURBIDITY};运行时按 turbidity/${ATMOSPHERE_REFERENCE_TURBIDITY} 缩放 Mie 分量。
 */
`;
const footer = `
/** 逐表 sha256(生成器写入;atmosphereSky 解码时校验)。 */
export const ATMOSPHERE_TABLE_SHA256 = {
  transmittance: "${hashOf(transmittance)}",
  single: "${hashOf(single)}",
  multiple: "${hashOf(multiple)}",
} as const;

/** 三表管道串联指纹(整体完整性一键断言)。 */
export const DEEP_ATMOSPHERE_TABLES_SHA256 = "${sha256}";

/** 纯 TS base64 解码(node/browser 通用,不依赖 Buffer/atob)。 */
function decodeBase64Into(source: string, target: Uint8Array): void {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const inverse = new Int16Array(128).fill(-1);
  for (let index = 0; index < alphabet.length; index++) inverse[alphabet.charCodeAt(index)] = index;
  let output = 0, accumulator = 0, bits = 0;
  for (let index = 0; index < source.length; index++) {
    const value = inverse[source.charCodeAt(index)] ?? -1;
    if (value < 0) continue;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      target[output++] = (accumulator >> bits) & 0xff;
    }
  }
  if (output !== target.length) throw new Error("Atmosphere table base64 payload does not fill the table.");
}

function decodePlane(source: string, floats: number): Float32Array {
  const table = new Float32Array(floats);
  decodeBase64Into(source, new Uint8Array(table.buffer));
  return table;
}

/** 解码三表(调用方缓存实例,避免重复解码)。 */
export function decodeAtmosphereTableBuffers(): {
  readonly transmittance: Float32Array;
  readonly single: Float32Array;
  readonly multiple: Float32Array;
} {
  return {
    transmittance: decodePlane(TRANSMITTANCE_BASE64, ${TRANSMITTANCE_COUNT * 3}),
    single: decodePlane(SINGLE_BASE64, ${6 * planeSize}),
    multiple: decodePlane(MULTIPLE_BASE64, ${4 * MV * MSN}),
  };
}
`;
const body = `const TRANSMITTANCE_BASE64 =\n  "${line(pack(transmittance))}";\n`
  + `const SINGLE_BASE64 =\n  "${line(pack(single))}";\n`
  + `const MULTIPLE_BASE64 =\n  "${line(pack(multiple))}";\n`;
writeFileSync(moduleUrl, `${header}${body}${footer}`);
console.log(`atmosphere tables written: sha256=${sha256}, ${Date.now() - started}ms`);

