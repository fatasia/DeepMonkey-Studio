/**
 * AA 组合档统测地基(AA-M2,antialiasing-master-plan-20261003 §L2/§AA-M2)——
 * 组合场景(a2c 栅栏 + 细杆 + alpha 植被类图案)的**解析域**各档渲染器与
 * aliasingEnergy 能量表。真实 WebGPU 链路档(MSAA4 渲染器、TSR、SMAA)数字由
 * 浏览器探针采集后由主线程合并进终表;本文件交付的是:
 * 1. 可复现的解析组合场景(几何真值单一来源,与 aliasingEnergy.syntheticStaircaseCase
 *    同骨架,但聚焦三类工业走样源:斜细杆 / alpha 链环栅栏 / 植被叶簇 alpha 场);
 * 2. 各 AA 档的确定性解析模拟器(no-AA 点采样 / MSAA4 rotated-grid /
 *    MSAA4+alpha-to-coverage(IGN hash dither,标准 Jimenez 方案)/
 *    MSAA4+TSR(Halton 抖动累积,静态场景理想化等价档));
 * 3. 各档边缘能量数字表(AA-M2 门:组合档相对 no-AA 降幅 ≥80%)。
 *
 * 定界(诚实条款):解析模拟器表达的是各档的**数学语义**(sample pattern、
 * a2c 的 alpha→coverage 阈值抖动、时域抖动累积),不是 GPU 实现的逐位复刻
 * (硬件 a2c 的 dither 矩阵未规范、TSR 含运动矢量与反应掩码)。GPU 端证据
 * 走 parity/探针体系,本表用于门的机器可断言基线与档间相对比较。
 */

import { measureAliasingEnergy, aliasingReduction, type AliasingEnergyReport } from "./aliasingEnergy.js";

/** 组合场景各 AA 档标识。 */
export type AaComboTier = "noAA" | "msaa4" | "noAA+a2cFallback" | "msaa4+a2c" | "msaa4+tsr" | "msaa4+a2c+tsr";

/**
 * 单档能量行。两组语义对照共享同一参考:
 * - alphaTest 组(noAA→msaa4):0.5 硬切材质,MSAA 的几何平滑贡献;
 * - a2c 组(noAA+a2cFallback→msaa4+a2c):纯 a2c 材质(alphaTest=0)在无 MSAA 时
 *   退化为 α>0 硬边全画(a2cFallback 是**语义对照**,不是 Deep 1x 行为——Deep 在
 *   1x 渲染器上对 a2c 批次 fail-closed 报错),MSAA4+a2c 的阶梯覆盖相对它的降幅
 *   即 a2c 的真实贡献。
 */
export interface AaComboTierRow {
  readonly tier: AaComboTier;
  readonly energy: AliasingEnergyReport;
  /** 相对本组 no-AA 基线的边缘能量降幅(0..1;基线行时为 0)。 */
  readonly reduction: number;
}

/** 组合档能量表:两组语义对照(alphaTest 组与 a2c 组)+ TSR 理想化档。 */
export interface AaComboEnergyTable {
  readonly width: number;
  readonly height: number;
  readonly sourceContrast: number;
  readonly rows: readonly AaComboTierRow[];
  /** AA-M2 组合门:任一 AA 档相对本组 no-AA 基线的边缘能量降幅 ≥80%。 */
  readonly comboGatePassed: boolean;
}

const DARK = 0.1, BRIGHT = 0.9;
/** 源对比度:与 syntheticStaircaseCase 同口径(0.9−0.1),保证跨场景数字可互比。 */
export const AA_COMBO_SOURCE_CONTRAST = BRIGHT - DARK;
/**
 * alpha-to-coverage 的 4 子样本 alpha 阈值阶梯(业界通行近似:覆盖率 = 4 级最近
 * 阶梯 round(alpha·4)/4,偏差有界 ±0.125)。WebGPU 规范不规定硬件 dither 矩阵,
 * 本表取均匀固定阶梯——它是确定性的(纯查表,同输入恒同 sample mask),且对
 * 连续 alpha 无偏;逐像素随机 hash(Jimenez IGN 等)会使单像素阈值整体偏移、
 * 破坏覆盖率无偏性,不用于本模拟。
 */
export const A2C_ALPHA_THRESHOLDS: readonly number[] = Object.freeze([0.125, 0.375, 0.625, 0.875]);

/**
 * WebGPU/DX 惯用 4-sample rotated-grid 采样位置(单位:像素,像素中心为原点)。
 * 标准模式 (-2,-6),(6,-2),(-6,2),(2,6) ÷ 16 —— 近 45° 旋转网格,对水平/垂直
 * 边与斜边均衡。MSAA4 与 MSAA4+a2c 共享同一 sample pattern(几何分支语义一致)。
 */
export const MSAA4_SAMPLE_OFFSETS: readonly (readonly [number, number])[] = Object.freeze([
  [-2 / 16, -6 / 16], [6 / 16, -2 / 16], [-6 / 16, 2 / 16], [2 / 16, 6 / 16],
]);

export interface AaComboSceneInput {
  /** 求值点(像素坐标,可含亚像素偏移)。 */
  readonly px: number;
  readonly py: number;
  readonly width: number;
  readonly height: number;
}

export interface AaComboSample {
  /** 二值不透明几何覆盖(斜细杆 + 栅栏杆体;alpha 恒 1)。 */
  readonly solid: boolean;
  /** alpha 图案场不透明度(链环栅栏 alpha 纹理 + 植被叶簇;0..1)。 */
  readonly alpha: number;
}

/**
 * 组合场景几何真值(单一来源)。三条水平带,全部按相对坐标定义(缩放不变):
 * - 细杆带 y∈[0.04,0.32]:周期 6px、宽 1.4px 的 15° 斜杆——纯二值几何走样源,
 *   MSAA 的主战场,a2c 对它无增益(alpha=1)。
 * - 栅栏带 y∈[0.36,0.62]:周期 5px 的 45° 斜栅栏,杆体中心实心 + 0.8px alpha
 *   渐变半影(链环栅栏 alpha 贴图的解析化)——几何+alpha 双重边缘,MSAA 与
 *   a2c 叠加收益。
 * - 植被带 y∈[0.66,0.96]:三簇圆形叶簇(像素半径,1.2px smoothstep 渐变)——
 *   a2c 的主战场,alphaTest 硬切 vs 阶梯 coverage 差异最显著。
 */
export function aaComboSample(input: AaComboSceneInput): AaComboSample {
  const { px, py, width, height } = input;
  const ny = py / height;
  // 细杆:沿 x 平移 + 15° 倾斜(斜率以高度为基准,与分辨率无关)。
  const railBand = ny >= 0.04 && ny < 0.32;
  if (railBand) {
    const period = 6;
    const tilt = px + (ny - 0.18) * height * Math.tan(15 * Math.PI / 180);
    const phase = mod(tilt, period);
    const solid = phase < 1.4;
    return { solid, alpha: solid ? 1 : 0 };
  }
  // 栅栏:45° 斜栅栏,杆体中心 1.1px 实心 + 两侧 0.8px alpha 渐变(半影)。
  const fenceBand = ny >= 0.36 && ny < 0.62;
  if (fenceBand) {
    const period = 5;
    const diagonal = (px + py) * Math.SQRT1_2;
    const phase = mod(diagonal, period);
    const distance = Math.min(phase, period - phase); // 到杆中心线的距离(px)
    const solid = distance <= 0.55;
    const alpha = distance <= 1.35 ? 1 - smoothstep(0.55, 1.35, distance) : 0;
    return { solid, alpha: solid ? 1 : alpha };
  }
  // 植被:三簇圆形叶簇(像素半径),smoothstep 1.2px 边缘渐变。
  const foliageBand = ny >= 0.66 && ny < 0.96;
  if (foliageBand) {
    let alpha = 0;
    for (const cluster of FOLIAGE_CLUSTERS) {
      const distance = Math.hypot(px - cluster.u * width, py - cluster.v * height);
      alpha = Math.max(alpha, 1 - smoothstep(cluster.r, cluster.r + 1.2, distance));
    }
    return { solid: false, alpha };
  }
  return { solid: false, alpha: 0 };
}

/** 叶簇参数(相对坐标圆心 + 像素半径):固定的布局常量,非迭代生成。 */
const FOLIAGE_CLUSTERS: readonly { readonly u: number; readonly v: number; readonly r: number }[] =
  Object.freeze([
    { u: 0.18, v: 0.81, r: 12 },
    { u: 0.50, v: 0.74, r: 9 },
    { u: 0.82, v: 0.84, r: 14 },
  ] as const);

function mod(value: number, period: number): number { return ((value % period) + period) % period; }
function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** 覆盖 → 合成亮度:被覆盖 sample 为前景色,未覆盖为背景色(双色场景)。 */
function shaded(coverage: number): number { return DARK + (BRIGHT - DARK) * coverage; }

/**
 * no-AA 基线:像素中心单点采样。
 * - alphaTest 语义(缺省):alpha 图案按 0.5 阈值硬切(MASK 材质),走样形态与
 *   真实 1x 渲染的 alphaTest 几何一致。
 * - a2cFallback 语义(alphaToCoverage=true):纯 a2c 材质(alphaTest=0)无采样掩码
 *   可用时退化为 α>0 全画(硬边)——这是**解析对照**,表达 a2c 收益的基线;
 *   Deep 引擎在 1x 渲染器上对 a2c 批次 fail-closed,不做此静默降级。
 */
export function renderAaComboNoAA(width: number, height: number, alphaToCoverage = false): Float32Array {
  const output = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = (y * width + x) * 4;
    const sample = aaComboSample({ px: x + 0.5, py: y + 0.5, width, height });
    const covered = alphaToCoverage ? sample.alpha > 0 : sample.solid || sample.alpha >= 0.5;
    const value = covered ? BRIGHT : DARK;
    output.set([value, value, value, 1], pixel);
  }
  return output;
}

/**
 * MSAA4 档:rotated-grid 4 子样本解析覆盖,几何与 alpha 图案均按子样本中心
 * 0.5 阈值判决(无 a2c:每 sample 的 alpha 判决是二值)。
 */
export function renderAaComboMsaa4(width: number, height: number): Float32Array {
  return renderMsaa(width, height, sample => sample.solid || sample.alpha >= 0.5);
}

/**
 * MSAA4+a2c 档:alpha 图案的逐子样本判决走固定 4 阈值阶梯(A2C_ALPHA_THRESHOLDS)——
 * alpha 渐变边缘获得 4 级 alpha→coverage 量化,残差有界 ±0.125,显著小于
 * alphaTest 硬切(±0.5)。二值几何(alpha=1)全部阈值通过——a2c 对全不透明
 * 几何零增益,与规范一致。
 */
export function renderAaComboMsaa4A2c(width: number, height: number): Float32Array {
  return renderMsaa(width, height, (sample, _px, _py, sampleIndex) =>
    sample.solid || sample.alpha > A2C_ALPHA_THRESHOLDS[sampleIndex]!);
}

/**
 * 时域抖动累积档(Halton(2,3) 序列亚像素抖动):静态场景、无运动矢量与反应
 * 掩码的理想化等价档(每帧 1 sample × frames 帧累积),表达 TSR 的时域累积上限。
 * alphaToCoverage=true 时逐帧判决用 a2c 阶梯(表达 MSAA4+a2c+TSR 完整组合档),
 * 否则用 alphaTest 硬切。真实 TSR 数字由 GPU 探针合并。
 */
export function renderAaComboMsaa4Tsr(width: number, height: number, frames = 8,
  alphaToCoverage = false): Float32Array {
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > 64) {
    throw new Error("TSR accumulation frame count must be a safe integer in [1, 64].");
  }
  const output = new Float32Array(width * height * 4);
  const jitterX = haltonSequence(frames, 2), jitterY = haltonSequence(frames, 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = (y * width + x) * 4;
    let sum = 0;
    for (let frame = 0; frame < frames; frame++) {
      const sample = aaComboSample({ px: x + jitterX[frame]!, py: y + jitterY[frame]!, width, height });
      sum += sample.solid || (alphaToCoverage ? sample.alpha > A2C_ALPHA_THRESHOLDS[frame % 4]!
        : sample.alpha >= 0.5) ? 1 : 0;
    }
    const value = shaded(sum / frames);
    output.set([value, value, value, 1], pixel);
  }
  return output;
}

/** MSAA 公共骨架:4 子样本覆盖投票 → 覆盖率混合。judge 返回该子样本是否被覆盖。 */
function renderMsaa(width: number, height: number,
  judge: (sample: AaComboSample, px: number, py: number, sampleIndex: number) => boolean): Float32Array {
  const output = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = (y * width + x) * 4;
    let covered = 0;
    for (let index = 0; index < MSAA4_SAMPLE_OFFSETS.length; index++) {
      const [offsetX, offsetY] = MSAA4_SAMPLE_OFFSETS[index]!;
      const sample = aaComboSample({ px: x + 0.5 + offsetX, py: y + 0.5 + offsetY, width, height });
      if (judge(sample, x + 0.5 + offsetX, y + 0.5 + offsetY, index)) covered++;
    }
    const value = shaded(covered / MSAA4_SAMPLE_OFFSETS.length);
    output.set([value, value, value, 1], pixel);
  }
  return output;
}

/** Halton 低差异序列前 count 项(基 base),返回 [0,1) 抖动偏移。 */
function haltonSequence(count: number, base: number): readonly number[] {
  return Array.from({ length: count }, (_, index) => {
    let value = 0, f = 1, i = index + 1;
    while (i > 0) { f /= base; value += f * (i % base); i = Math.floor(i / base); }
    return value;
  });
}

/**
 * 4× 超采样解析参考(组合场景真值):16 子样本覆盖率连续合成(alpha 不做
 * 阈值判决,保留渐变),与 aliasingEnergy.syntheticStaircaseCase 的参考语义同构。
 */
export function aaComboReference(width: number, height: number): Float32Array {
  const reference = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = (y * width + x) * 4;
    let sum = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const sample = aaComboSample({ px: x + (sx + 0.5) / 4, py: y + (sy + 0.5) / 4, width, height });
      sum += sample.solid ? 1 : sample.alpha;
    }
    const value = shaded(sum / 16);
    reference.set([value, value, value, 1], pixel);
  }
  return reference;
}

/**
 * 组合档能量表:alphaTest 组(noAA→msaa4)+ a2c 组(noAA+a2cFallback→msaa4+a2c)
 * + TSR 理想化档(相对 alphaTest 基线),AA-M2 组合门(组内降幅 ≥80%)机器判定。
 */
export function aaComboEnergyTable(width: number, height: number): AaComboEnergyTable {
  const reference = aaComboReference(width, height);
  const measure = (output: Float32Array): AliasingEnergyReport =>
    measureAliasingEnergy({ output, reference, width, height, sourceContrast: AA_COMBO_SOURCE_CONTRAST });
  const alphaTestBaseline = measure(renderAaComboNoAA(width, height));
  const a2cBaseline = measure(renderAaComboNoAA(width, height, true));
  // AA-M2 组合档:MSAA4+a2c+TSR(16 帧理想化累积,与参考同为 16 子样本阶)相对
  // a2c 材质基线的降幅 —— 这是完整 AA 方案对 a2c 植被类资产的门判定;alphaTest
  // 组与各单档如实并列,供与路 7 SMAA 真实链数字合并。
  const combo = measure(renderAaComboMsaa4Tsr(width, height, 16, true));
  const rows: AaComboTierRow[] = [
    { tier: "noAA", energy: alphaTestBaseline, reduction: 0 },
  ];
  let best = aliasingReduction(a2cBaseline.edgeEnergy, combo.edgeEnergy);
  for (const [tier, output, baseline] of [
    ["msaa4", renderAaComboMsaa4(width, height), alphaTestBaseline],
    ["noAA+a2cFallback", renderAaComboNoAA(width, height, true), a2cBaseline],
    ["msaa4+a2c", renderAaComboMsaa4A2c(width, height), a2cBaseline],
    ["msaa4+tsr", renderAaComboMsaa4Tsr(width, height), alphaTestBaseline],
  ] as const) {
    const energy = measure(output);
    const reduction = aliasingReduction(baseline.edgeEnergy, energy.edgeEnergy);
    best = Math.max(best, reduction);
    rows.push({ tier, energy, reduction });
  }
  rows.push({ tier: "msaa4+a2c+tsr", energy: combo,
    reduction: aliasingReduction(a2cBaseline.edgeEnergy, combo.edgeEnergy) });
  return { width, height, sourceContrast: AA_COMBO_SOURCE_CONTRAST, rows, comboGatePassed: best >= 0.8 };
}
