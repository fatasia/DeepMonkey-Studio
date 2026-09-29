import { DEFAULT_PQ_PEAK_NITS, type HdrDisplayPolicy } from "./hdrDisplayOutput.js";

/**
 * I-C21 HDR 显示输出 CPU 镜像与量化对照分析器。
 *
 * == 职责 ==
 * 1. `linearNitsToPq` / `linearToHlg` / `extendedLinearHeadroom`:WGSL 编码核的逐位
 *    CPU 镜像(字面量与 `pbrHdrDisplayWgsl.ts` 同源,测试以源文本对拍钉死);
 * 2. `hdrSettingsUniform`:present 链 HDR 变体管线的 16B uniform 打包(策略索引与
 *    WGSL 分支阈值同源:0=extended-linear,1=pq-2020,2=hlg-2020);
 * 3. `quantifyHdrVsSdr`:同一份场景线性 HDR 数据(present-color 读回)下,SDR 终点
 *    (ACES+ sRGB 钳 0..1)与三种 HDR 策略的亮度/色域数值对照 —— 验收"量化=HDR vs
 *    SDR 色域/亮度对照"的计算单源,TS 单测与真机 GPU 探针共用。
 *
 * == 白炉守恒边界 ==
 * HDR 策略只作用 present 终点编码,不做任何能量放大:0.5 线性白炉经任一策略编码后
 * 的往返(pq 解码/nits 换算)必须回到 0.5×参考白,单测钉住。
 */

/** WGSL `DeepHdrOutputSettings.strategy` 分支索引(与 pbrHdrDisplayWgsl.ts 阈值同源)。 */
export const HDR_STRATEGY_UNIFORM_INDEX = Object.freeze({
  "extended-linear": 0, "pq-2020": 1, "hlg-2020": 2,
} as const);

/** BT.2100 PQ 系数(与 WGSL 字面量逐位同源;出处 ITU-R BT.2100 Table 5)。 */
export const PQ_M1 = 2610 / 16384;
export const PQ_M2 = 2523 / 4096 * 128;
export const PQ_C1 = 3424 / 4096;
export const PQ_C2 = 2413 / 4096 * 32;
export const PQ_C3 = 2392 / 4096 * 32;
/** BT.2100 HLG OETF 系数(BT.2100 Table 5 发表值,与 WGSL 字面量逐位同源;
 * 派生关系 1-4a / 0.5-a·ln(4a) 由测试以容差钉住)。 */
export const HLG_A = 0.17883277;
export const HLG_B = 0.28466892;
export const HLG_C = 0.55991073;

/** nits → PQ 码值(BT.2100 EOTF 编码方向;物理域 [0,10000] 外钳制;黑点按规范恒为 0)。 */
export function linearNitsToPq(nits: number): number {
  const y = Math.min(10000, Math.max(0, nits)) / 10000;
  if (y === 0) return 0;
  const powered = Math.pow(y, PQ_M1);
  return Math.pow((PQ_C1 + PQ_C2 * powered) / (1 + PQ_C3 * powered), PQ_M2);
}

/** PQ 码值 → nits(解码方向;量化对照的 nits 报告单源)。 */
export function pqToLinearNits(code: number): number {
  const inverse = Math.pow(Math.min(1, Math.max(0, code)), 1 / PQ_M2);
  const powered = Math.max((inverse - PQ_C1) / (PQ_C2 - PQ_C3 * inverse), 0);
  return Math.pow(powered, 1 / PQ_M1) * 10000;
}

/** 相对场景线性 [0,1] → HLG 信号(BT.2100 OETF;>1 输入钳制)。 */
export function linearToHlg(sceneLinear: number): number {
  const e = Math.min(1, Math.max(0, sceneLinear));
  return e <= 1 / 12 ? Math.sqrt(3 * e) : HLG_A * Math.log(12 * e - HLG_B) + HLG_C;
}

/**
 * extended-linear headroom 肩部压缩(与 WGSL `deepExtendedLinearHeadroom` 同式):
 * ≤1(SDR 参考白)逐值直通,>1 沿 tanh 软肩压向 headroom 顶(倍数,1.0=参考白)。
 */
export function extendedLinearHeadroom(value: number, headroom: number): number {
  const positive = Math.max(0, value);
  if (positive <= 1) return positive;
  const room = Math.max(headroom - 1, 1e-6);
  return 1 + room * Math.tanh((positive - 1) / room);
}

/** 策略编码 CPU 总入口(镜像 `deepHdrDisplayColor` 的编码阶;exposure/grading 由上游链)。 */
export function hdrEncodeChannel(value: number, policy: Pick<HdrDisplayPolicy, "strategy" | "pqPeakNits">,
  referenceWhiteNits: number, extendedHeadroom: number): number {
  if (policy.strategy === "extended-linear") return extendedLinearHeadroom(value, extendedHeadroom);
  if (policy.strategy === "pq-2020") {
    const nits = Math.min(Math.max(0, value) * referenceWhiteNits, policy.pqPeakNits ?? DEFAULT_PQ_PEAK_NITS);
    return linearNitsToPq(nits);
  }
  if (policy.strategy === "hlg-2020") return linearToHlg(value);
  throw new RangeError(`hdrEncodeChannel: SDR strategy "${policy.strategy}" has no HDR encode.`);
}

/** HDR 变体管线 16B uniform 打包(1 float 对齐 4 分量,binding 3)。
 * 显式 `Float32Array<ArrayBuffer>`:GPU queue.writeBuffer 的 GPUAllowSharedBufferSource
 * 不收 ArrayBufferLike 视图(与 pbrFrameUniforms outputData 同型约束)。 */
export function hdrSettingsUniform(policy: HdrDisplayPolicy, referenceWhiteNits: number,
  extendedHeadroom: number): Float32Array<ArrayBuffer> {
  if (policy.mode !== "hdr") throw new TypeError("hdrSettingsUniform requires an active HDR policy.");
  const strategyIndex = policy.strategy === "hlg-2020" ? 2 : policy.strategy === "pq-2020" ? 1 : 0;
  const data = new Float32Array(4);
  data[0] = strategyIndex;
  data[1] = referenceWhiteNits;
  data[2] = policy.pqPeakNits ?? 0;
  data[3] = extendedHeadroom;
  return data;
}

// ---- 量化对照:CIE 1931 色度 + 色域三角形 + 亮度统计 ----

/** 线性 sRGB → CIE XYZ(BT.709 / sRGB 定义矩阵)。 */
const SRGB_TO_XYZ = Object.freeze([
  0.4123907993, 0.3575843394, 0.1804807884,
  0.2126390059, 0.7151686788, 0.0721923154,
  0.0193308187, 0.1191947798, 0.9505321522,
] as const);

/** 原色色度(CIE 1931 xy)与白点。 */
export const GAMUT_PRIMARIES = Object.freeze({
  srgb: Object.freeze({
    red: [0.64, 0.33], green: [0.30, 0.60], blue: [0.15, 0.06], white: [0.3127, 0.3290],
  }),
  displayP3: Object.freeze({
    red: [0.680, 0.320], green: [0.265, 0.690], blue: [0.150, 0.060], white: [0.3127, 0.3290],
  }),
  rec2020: Object.freeze({
    red: [0.708, 0.292], green: [0.170, 0.797], blue: [0.131, 0.046], white: [0.3127, 0.3290],
  }),
});

/** 线性 sRGB 像素 → CIE 1931 xy 色度。 */
export function cieXyFromLinearSrgb(r: number, g: number, b: number): readonly [number, number] {
  const x = SRGB_TO_XYZ[0]! * r + SRGB_TO_XYZ[1]! * g + SRGB_TO_XYZ[2]! * b;
  const y = SRGB_TO_XYZ[3]! * r + SRGB_TO_XYZ[4]! * g + SRGB_TO_XYZ[5]! * b;
  const z = SRGB_TO_XYZ[6]! * r + SRGB_TO_XYZ[7]! * g + SRGB_TO_XYZ[8]! * b;
  const sum = x + y + z;
  return sum <= 1e-9 ? [0.3127, 0.329] : [x / sum, y / sum];
}

/** 射线法三角形包含测试(色域覆盖判定单源)。 */
export function pointInTriangle(px: number, py: number,
  a: readonly number[], b: readonly number[], c: readonly number[]): boolean {
  const sign = (ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number =>
    (ox - ax) * (by - ay) - (oy - ay) * (bx - ax);
  const d1 = sign(px, py, a[0]!, a[1]!, b[0]!, b[1]!);
  const d2 = sign(px, py, b[0]!, b[1]!, c[0]!, c[1]!);
  const d3 = sign(px, py, c[0]!, c[1]!, a[0]!, a[1]!);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function gamutCoverage(linear: Float32Array, primaries: (typeof GAMUT_PRIMARIES)["displayP3"]): number {
  let inside = 0, total = 0;
  for (let pixel = 0; pixel < linear.length / 3; pixel += 1) {
    const [x, y] = cieXyFromLinearSrgb(linear[pixel * 3]!, linear[pixel * 3 + 1]!, linear[pixel * 3 + 2]!);
    if (pointInTriangle(x, y, primaries.red, primaries.green, primaries.blue)) inside += 1;
    total += 1;
  }
  return total === 0 ? 0 : inside / total;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

/** 既有 SDR 终点镜像(Narkowicz ACES;公式同 pbrDisplayColor.deepAces,交叉对拍)。 */
function acesToneChannel(value: number, exposure: number): number {
  const v = Math.max(0, value * exposure);
  const mapped = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
  return Math.min(1, Math.max(0, mapped));
}

/** 既有 SDR 终点全链(ACES + sRGB;交叉对拍 pbrDisplayColor.encodePbrDisplayColor 用)。 */
function sdrEncodeChannel(value: number, exposure: number): number {
  const clamped = acesToneChannel(value, exposure);
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/** 相对色度(色度/亮度):对高光去饱和的度量口径,编码域无关。 */
function relativeChroma(r: number, g: number, b: number): number {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return chroma(r, g, b) / Math.max(luma, 1e-6);
}

/** 色度(去亮度饱和度近似):max-min 通道展宽,sRGB 线性域。 */
function chroma(r: number, g: number, b: number): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

export interface HdrVsSdrQuantification {
  readonly pixels: number;
  /** 场景线性(present-color 读回域)亮度统计,Rec.709 加权。 */
  readonly linear: { readonly peak: number; readonly p99: number; readonly mean: number;
    /** 线性 >1(SDR 参考白)的像素占比 —— SDR 终点会把这些压成同一白色。 */ readonly overSdrWhiteRatio: number };
  /** SDR 终点(ACES+sRGB 钳 0..1):峰值恒为参考白,高光色度被 ACES 高光去饱和吞掉。 */
  readonly sdr: { readonly peakNits: number; readonly headroomLossRatio: number; readonly p3Coverage: number;
    readonly rec2020Coverage: number };
  /** 三种 HDR 策略的亮度对照(nits 由 PQ 域换算报告)。 */
  readonly hdr: { readonly extendedLinearPeakNits: number; readonly pqPeakNits: number; readonly pqP99Nits: number;
    readonly pqMeanNits: number; readonly hlgPeakSignal: number };
  /** 高光色度保留:SDR 钳白像素上,源相对色度 ÷ ACES 色调映射后相对色度(>1 = HDR 保留被吞的色度)。 */
  readonly highlightChromaRetentionRatio: number;
}

export interface QuantifyOptions {
  readonly referenceWhiteNits: number;
  readonly pqPeakNits: number;
  readonly extendedHeadroom: number;
  /** 场景曝光(与 present 链 settings.exposure 同义);缺省 1。 */
  readonly exposure?: number;
}

/**
 * 同一份场景线性 HDR 数据下 SDR vs HDR 的量化对照。
 * 输入 = present-color 读回解出的行主序 RGB(f16 线性);输出 = 亮度/色域数值表。
 */
export function quantifyHdrVsSdr(linear: Float32Array, options: QuantifyOptions): HdrVsSdrQuantification {
  if (linear.length % 3 !== 0) throw new TypeError("quantifyHdrVsSdr expects RGB triplets.");
  if (!Number.isFinite(options.referenceWhiteNits) || options.referenceWhiteNits <= 0
    || !Number.isFinite(options.pqPeakNits) || options.pqPeakNits <= 0) {
    throw new TypeError("quantifyHdrVsSdr requires positive reference white and PQ peak.");
  }
  const exposure = options.exposure ?? 1;
  const pixels = linear.length / 3;
  const linearLuma: number[] = [];
  let overWhite = 0, linearPeak = 0, linearSum = 0;
  let retentionSum = 0, retentionCount = 0;
  const pqNits: number[] = [];
  let hlgPeak = 0, extendedPeak = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const r = linear[pixel * 3]!, g = linear[pixel * 3 + 1]!, b = linear[pixel * 3 + 2]!;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    linearLuma.push(luma);
    linearPeak = Math.max(linearPeak, luma);
    linearSum += luma;
    if (luma > 1) {
      overWhite += 1;
      retentionSum += relativeChroma(r, g, b) / Math.max(relativeChroma(
        acesToneChannel(r, exposure), acesToneChannel(g, exposure), acesToneChannel(b, exposure)), 1e-6);
      retentionCount += 1;
    }
    extendedPeak = Math.max(extendedPeak,
      Math.max(extendedLinearHeadroom(r, options.extendedHeadroom),
        extendedLinearHeadroom(g, options.extendedHeadroom), extendedLinearHeadroom(b, options.extendedHeadroom)));
    for (const channel of [r, g, b]) {
      const nits = Math.min(Math.max(0, channel * exposure) * options.referenceWhiteNits, options.pqPeakNits);
      pqNits.push(nits);
      hlgPeak = Math.max(hlgPeak, linearToHlg(channel));
    }
  }
  linearLuma.sort((left, right) => left - right);
  pqNits.sort((left, right) => left - right);
  const meanPq = pqNits.reduce((sum, value) => sum + value, 0) / Math.max(pqNits.length, 1);
  return Object.freeze({
    pixels,
    linear: Object.freeze({
      peak: linearPeak, p99: percentile(linearLuma, 0.99), mean: linearSum / Math.max(pixels, 1),
      overSdrWhiteRatio: overWhite / Math.max(pixels, 1),
    }),
    sdr: Object.freeze({
      peakNits: options.referenceWhiteNits,
      headroomLossRatio: overWhite / Math.max(pixels, 1),
      p3Coverage: gamutCoverage(linear, GAMUT_PRIMARIES.displayP3),
      rec2020Coverage: gamutCoverage(linear, GAMUT_PRIMARIES.rec2020),
    }),
    hdr: Object.freeze({
      extendedLinearPeakNits: extendedPeak * options.referenceWhiteNits,
      pqPeakNits: pqNits.length === 0 ? 0 : pqNits[pqNits.length - 1]!,
      pqP99Nits: percentile(pqNits, 0.99),
      pqMeanNits: meanPq,
      hlgPeakSignal: hlgPeak,
    }),
    highlightChromaRetentionRatio: retentionCount === 0 ? 1 : retentionSum / retentionCount,
  });
}
