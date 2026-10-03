import type { LightVector3 } from "./types.js";
import { evaluateMegaLightCpu, MEGALIGHTS_RIS_CANDIDATES, MEGALIGHTS_RIS_M,
  MEGALIGHTS_SPATIAL_REUSE_RADIUS, type MegaLight } from "./megaLights.js";

/**
 * B2 MegaLights M1 RIS 采样的 CPU 权威镜像——与 wgsl/megaLightsRis.wgsl 逐式同源
 * (两趟:buildReservoirs → reuseAndShade;确定性种子;时域/空间复用同门同钳)。
 *
 * == 估计器(无偏性推导,M1 定案) ==
 * 目标权重 t_i = luminance(单灯贡献)(全量 BRDF 评价,M1 成本可承受;UE MegaLights 同口径)。
 * K 个候选均匀 i.i.d.(p=1/N)经加权蓄水池采样选胜者 y,输出
 *   color = shade(y) × N × Σt_k / (K × t_y)。
 * 归一化目标 pdf f̂ = t/T 代入 Bitterli 2022 Alg.4(W_Y = w_sum/(K·p̂(y)))后 T 恰好
 * 相消,得上式;E[color] = Σ_i shade(i) 严格无偏。**K ≥ N 且候选遍历全灯时估计量
 * 与 y 无关、恒等于精确和 Σ shade(i)**——这是验收⑤「退化一致性」的数学基础
 * (MegaLights 穷举模式 ↔ 既有簇光逐灯路径同式对拍)。
 *
 * 时域/空间复用按标准蓄水池合并(M 钳制 20× 本帧候选数,压 bias;相似门:深度比 +
 * 法线夹角)合并后统一以 M_total 重算 W_Y;复用引入的近似(无 MIS)由门与钳制控制,
 * 与真机闪烁门(③)共同验收。胜者可见性槽 M1 恒 1.0(硬阴影走 M2 BVH,任务书边界)。
 */

/** 蓄水池(单像素单 M 流)。 */
export interface RisReservoir {
  /** Σt_k(候选目标权重和)。 */
  weightSum: number;
  /** 胜者灯下标;0xffffffff = 无有效候选。 */
  winner: number;
  /** 已合并候选总数(K 与时域/空间合并的 M 之和;W_Y 公式的分母因子)。 */
  m: number;
}

/** 与 WGSL deepMegaHash 同式的 32 位整数哈希(wang hash 家族;逐位一致可对拍)。 */
export function megaHashU32(value: number): number {
  let state = value | 0;
  state = (state ^ 61) ^ (state >>> 16);
  state = (state + (state << 3)) | 0;
  state = state ^ (state >>> 4);
  state = Math.imul(state, 0x27d4eb2d);
  state = state ^ (state >>> 15);
  return state >>> 0;
}

/** 与 WGSL deepMegaRandom 同式:PCG 输出函数(state 上下文调用方持有)。 */
export function megaRandomNext(state: number): { readonly state: number; readonly value: number } {
  const next = (Math.imul(state, 747796405) + 2891336453) >>> 0;
  const word = ((next >>> ((next >>> 28) + 4)) ^ next) >>> 0;
  return { state: next, value: word / 4294967296 };
}

/** 确定性像素种子:像素序号 × 帧号 × 流序号(wgsl deepMegaPixelSeed 同式)。 */
export function megaPixelSeed(pixelIndex: number, frameIndex: number, stream: number): number {
  return (megaHashU32(pixelIndex + 0x9e3779b9) + Math.imul(frameIndex | 0, 0x85ebca6b) + Math.imul(stream | 0, 0xc2b2ae35)) >>> 0;
}

export function luminance(color: LightVector3): number {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

export const MEGALIGHTS_INVALID_LIGHT = 0xffffffff;
/** 时域复用相似门:视深相对差(M1 视深门;与 WGSL 同值)。 */
export const MEGALIGHTS_TEMPORAL_DEPTH_GATE = 0.1;
/** 空间复用相似门:法线点积下限(与 WGSL 同值)。 */
export const MEGALIGHTS_SPATIAL_NORMAL_GATE = 0.9;

export interface MegaLightsFrameConfig {
  readonly width: number;
  readonly height: number;
  /** K 候选数(缺省 32;穷举对拍模式自动 ≥N)。 */
  readonly candidateCount?: number;
  readonly temporal?: boolean;
  readonly spatial?: boolean;
  /** 穷举对拍模式:逐灯求和(与簇光逐灯路径同式;⑤ 退化一致性腿)。 */
  readonly exhaustive?: boolean;
  /** 颜色 EMA 系数(temporal 开启时生效;缺省 1/32;首帧传 1 全量替换)。 */
  readonly alphaBlend?: number;
}

export interface MegaLightsFrameInput {
  readonly lights: readonly MegaLight[];
  /** 行主序 w×h 表面(GBuffer 的 CPU 形态;与 GPU storage 布局逐字同构,3 vec4/像素):
   * [0]=(positionView.xyz, metallic) [1]=(normalView.xyz, roughness) [2]=(baseColor.xyz, 预留)。
   * 视向量按视空间相机在原点约定派生 view = normalize(−position),与 WGSL 同式。 */
  readonly surfaces: readonly (readonly (number | LightVector3)[])[];
  readonly previous?: readonly RisReservoir[] | undefined;
  /** 每像素当前→上一帧 UV 运动(T07 口径:previous = pixel + 0.5 + motion)。 */
  readonly motionUv?: readonly number[] | undefined;
  /** 上一帧 EMA 颜色(temporal 开启时混合;与 GPU deepMegaColorHistory 同语义)。 */
  readonly previousColor?: Float32Array | undefined;
  readonly frame: number;
  readonly config: MegaLightsFrameConfig;
}

export interface MegaLightsFrameOutput {
  readonly color: Float32Array;
  readonly reservoirs: readonly RisReservoir[];
}

function surfaceField(surface: readonly (number | LightVector3)[], index: number): LightVector3 {
  return surface[index] as LightVector3;
}

/** MegaLightSurface 视图(GPU 3-vec4 布局解码;view 按相机在原点派生,与 WGSL 同式)。
 * 行的 .w 槽(metallic/roughness/预留)**必须截断**:WGSL 只读 xyz,而 CPU 镜像的
 * safeNormalize/Math.hypot(...v) 会把第 4 元素一并算进模长——不截断时 roughness(0.45)
 * 会把法线长度污染到 1.097,CPU 参考全链 ~15% 偏低(2026-10-04 真机对拍抓出)。 */
export function megaSurfaceDecodeCpu(surface: readonly (number | LightVector3)[]): {
  readonly positionView: LightVector3; readonly normalView: LightVector3; readonly view: LightVector3;
  readonly baseColor: LightVector3; readonly metallic: number; readonly roughness: number } {
  const raw = (row: number): LightVector3 => {
    const source = surfaceField(surface, row) as readonly number[];
    return [source[0]!, source[1]!, source[2]!];
  };
  const position = raw(0);
  const normal = raw(1);
  const baseColor = raw(2);
  const viewLength = Math.hypot(position[0], position[1], position[2]);
  const view: LightVector3 = viewLength > 1e-8
    ? [-position[0] / viewLength, -position[1] / viewLength, -position[2] / viewLength] : [0, 0, 1];
  return { positionView: position, normalView: normal, view, baseColor,
    metallic: (surface[0] as readonly number[])[3] ?? 0, roughness: (surface[1] as readonly number[])[3] ?? 0 };
}

function surfaceEvaluation(lights: readonly MegaLight[], surface: readonly (number | LightVector3)[], index: number): LightVector3 {
  return evaluateMegaLightCpu(lights[index]!, megaSurfaceDecodeCpu(surface));
}

/** 目标权重 = luminance(全量单灯贡献)(与 WGSL deepMegaContribution+luminance 同式同序)。 */
export function megaTargetWeightCpu(lights: readonly MegaLight[],
  surface: readonly (number | LightVector3)[], index: number): number {
  return luminance(surfaceEvaluation(lights, surface, index));
}

/** 胜者着色(可见性槽 M1 恒 1.0;与 WGSL deepMegaShadeWinner 同式)。 */
export function megaShadeWinnerCpu(lights: readonly MegaLight[],
  surface: readonly (number | LightVector3)[], index: number): LightVector3 {
  return surfaceEvaluation(lights, surface, index);
}

/** 视深(视空间 -z;相似门用,与 WGSL surfaceA.w 同值)。 */
export function megaViewDepthCpu(surface: readonly (number | LightVector3)[]): number {
  return -(surfaceField(surface, 0)[2] ?? 0);
}

interface Stream {
  state: number;
  next(): number;
}

function openStream(pixelIndex: number, frame: number, stream: number): Stream {
  let state = megaPixelSeed(pixelIndex, frame, stream);
  return { state, next(): number { const step = megaRandomNext(this.state); this.state = step.state; return step.value; } };
}

/** 加权蓄水池合并(与 WGSL deepMegaReservoirMerge 同式:m 带权累积 + 单均匀值竞选)。 */
export function mergeReservoirCpu(reservoir: RisReservoir, weight: number, winner: number, count: number, uniform: number): void {
  if (count <= 0 || weight <= 0) return;
  const total = reservoir.weightSum + weight * count;
  if (uniform * total < weight * count) reservoir.winner = winner;
  reservoir.weightSum = total;
  reservoir.m += count;
}

/** 蓄水池收尾:W_Y = N × w_sum/(M × t_y)(t_y 胜者目标权重在本像素重评价;
 * 与 WGSL deepMegaReservoirFinish 同式;趟二内联同式,本函数供外部诊断/测试复用)。 */
export function finishReservoirCpu(reservoir: RisReservoir, lights: readonly MegaLight[],
  surface: readonly (number | LightVector3)[], lightCount: number): number {
  if (reservoir.winner === MEGALIGHTS_INVALID_LIGHT || reservoir.m <= 0) return 0;
  const winnerWeight = megaTargetWeightCpu(lights, surface, reservoir.winner);
  if (winnerWeight <= 0) return 0;
  return lightCount * reservoir.weightSum / (reservoir.m * winnerWeight);
}

/** 趟一:K 候选 + 时域合并(与 WGSL buildReservoirs 入口同式)。 */
export function buildReservoirPassCpu(input: MegaLightsFrameInput): RisReservoir[] {
  const { lights, surfaces, previous, motionUv, frame, config } = input;
  const { width, height } = config;
  const lightCount = lights.length;
  const requested = config.candidateCount ?? MEGALIGHTS_RIS_CANDIDATES;
  const candidateCount = config.exhaustive ? Math.max(requested, lightCount) : requested;
  const temporal = config.temporal !== false && previous !== undefined && previous.length === width * height;
  const reservoirs: RisReservoir[] = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const stream = openStream(pixelIndex, frame, 0);
      const reservoir: RisReservoir = { weightSum: 0, winner: MEGALIGHTS_INVALID_LIGHT, m: 0 };
      const surface = surfaces[pixelIndex]!;
      for (let k = 0; k < candidateCount; k++) {
        // 穷举模式第 k 个候选恒 k(遍历全灯);随机模式均匀 i.i.d.
        const candidate = config.exhaustive && k < lightCount ? k : Math.min(lightCount - 1, Math.floor(stream.next() * lightCount));
        const weight = megaTargetWeightCpu(lights, surface, candidate);
        if (weight > 0) mergeReservoirCpu(reservoir, weight, candidate, 1, stream.next());
      }
      if (temporal) {
        const previousIndex = temporalPreviousPixelCpu(x, y, width, height, motionUv);
        if (previousIndex >= 0) {
          const history = previous[previousIndex]!;
          if (history.winner !== MEGALIGHTS_INVALID_LIGHT
            && temporalGateCpu(surface, surfaces[previousIndex]!)) {
            const weight = megaTargetWeightCpu(lights, surface, history.winner);
            // 历史胜者按**单候选**合并(与 WGSL 同式同注释:克隆计权在胜者冻结后产生
            // 持久像素偏置,2026-10-04 定案;真 MIS 复用属 M2)。
            mergeReservoirCpu(reservoir, weight, history.winner, 1, stream.next());
          }
        }
      }
      reservoirs[pixelIndex] = reservoir;
    }
  }
  return reservoirs;
}

/** 趟二:5×5 空间合并 + 胜者着色(与 WGSL reuseAndShade 入口同式)。 */
export function reuseAndShadePassCpu(input: MegaLightsFrameInput, built: readonly RisReservoir[]): MegaLightsFrameOutput {
  const { lights, surfaces, frame, config, previousColor } = input;
  const { width, height } = config;
  const lightCount = lights.length;
  const requested = config.candidateCount ?? MEGALIGHTS_RIS_CANDIDATES;
  const candidateCount = config.exhaustive ? Math.max(requested, lightCount) : requested;
  const spatial = config.spatial !== false && config.exhaustive !== true;
  const radius = MEGALIGHTS_SPATIAL_REUSE_RADIUS;
  const color = new Float32Array(width * height * 3);
  const reservoirs: RisReservoir[] = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const stream = openStream(pixelIndex, frame, 1);
      const surface = surfaces[pixelIndex]!;
      const reservoir: RisReservoir = { ...built[pixelIndex]! };
      if (config.exhaustive === true) {
        // 穷举对拍模式:逐灯求和(与簇光逐灯路径同式同序;⑤ 退化一致性腿)。
        let total: LightVector3 = [0, 0, 0];
        for (let index = 0; index < lights.length; index++) {
          const c = megaShadeWinnerCpu(lights, surface, index);
          total = [total[0] + c[0], total[1] + c[1], total[2] + c[2]];
        }
        color[pixelIndex * 3] = total[0]; color[pixelIndex * 3 + 1] = total[1]; color[pixelIndex * 3 + 2] = total[2];
        reservoirs[pixelIndex] = reservoir;
        continue;
      }
      if (spatial) {
        for (let offsetY = -radius; offsetY <= radius; offsetY++) {
          for (let offsetX = -radius; offsetX <= radius; offsetX++) {
            if (offsetX === 0 && offsetY === 0) continue;
            const nx = x + offsetX, ny = y + offsetY;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const neighbor = built[ny * width + nx]!;
            if (neighbor.winner === MEGALIGHTS_INVALID_LIGHT || neighbor.m <= 0) continue;
            if (!spatialGateCpu(surface, surfaces[ny * width + nx]!)) continue;
            const weight = megaTargetWeightCpu(lights, surface, neighbor.winner);
            // 邻居胜者按**单候选**合并(与 WGSL 同式同注释:克隆计权实测偏差放大,定案 2026-10-04)。
            if (weight > 0) mergeReservoirCpu(reservoir, weight, neighbor.winner, 1, stream.next());
          }
        }
      }
      reservoirs[pixelIndex] = reservoir;
      const shade = reservoir.winner === MEGALIGHTS_INVALID_LIGHT || reservoir.m <= 0 ? [0, 0, 0] as LightVector3
        : megaShadeWinnerCpu(lights, surface, reservoir.winner);
      // W_Y 重用 finish 公式(胜者目标权重在本像素重评价)。
      const weightY = reservoir.winner === MEGALIGHTS_INVALID_LIGHT || reservoir.m <= 0 ? 0
        : megaTargetWeightCpu(lights, surface, reservoir.winner);
      const scaleY = weightY > 0 ? lightCount * reservoir.weightSum / (reservoir.m * weightY) : 0;
      var r = shade[0] * scaleY, g = shade[1] * scaleY, b = shade[2] * scaleY;
      if (config.temporal !== false && previousColor !== undefined) {
        // 颜色时域 EMA(与 WGSL 趟二 mix 同式;首帧 previousColor 缺省 = 全量替换)。
        const alpha = config.alphaBlend ?? 1 / 32;
        r = previousColor[pixelIndex * 3]! + (r - previousColor[pixelIndex * 3]!) * alpha;
        g = previousColor[pixelIndex * 3 + 1]! + (g - previousColor[pixelIndex * 3 + 1]!) * alpha;
        b = previousColor[pixelIndex * 3 + 2]! + (b - previousColor[pixelIndex * 3 + 2]!) * alpha;
      }
      color[pixelIndex * 3] = r;
      color[pixelIndex * 3 + 1] = g;
      color[pixelIndex * 3 + 2] = b;
    }
  }
  return { color, reservoirs };
}

/** 整帧(CPU 镜像入口):趟一 + 趟二。 */
export function megaLightsFrameCpu(input: MegaLightsFrameInput): MegaLightsFrameOutput {
  return reuseAndShadePassCpu(input, buildReservoirPassCpu(input));
}

function temporalPreviousPixelCpu(x: number, y: number, width: number, height: number,
  motionUv: readonly number[] | undefined): number {
  if (!motionUv) return -1;
  const px = x + 0.5 + (motionUv[(y * width + x) * 2] ?? 0);
  const py = y + 0.5 + (motionUv[(y * width + x) * 2 + 1] ?? 0);
  const ix = Math.floor(px), iy = Math.floor(py);
  if (ix < 0 || iy < 0 || ix >= width || iy >= height) return -1;
  return iy * width + ix;
}

function temporalGateCpu(surface: readonly (number | LightVector3)[], previous: readonly (number | LightVector3)[]): boolean {
  const depth = megaViewDepthCpu(surface), previousDepth = megaViewDepthCpu(previous);
  if (previousDepth <= 0) return false;
  return Math.abs(depth - previousDepth) <= MEGALIGHTS_TEMPORAL_DEPTH_GATE * Math.max(depth, previousDepth);
}

function spatialGateCpu(surface: readonly (number | LightVector3)[], neighbor: readonly (number | LightVector3)[]): boolean {
  const normal = surfaceField(surface, 1), neighborNormal = surfaceField(neighbor, 1);
  const dot = normal[0] * neighborNormal[0] + normal[1] * neighborNormal[1] + normal[2] * neighborNormal[2];
  if (dot < MEGALIGHTS_SPATIAL_NORMAL_GATE) return false;
  const depth = megaViewDepthCpu(surface), neighborDepth = megaViewDepthCpu(neighbor);
  return Math.abs(depth - neighborDepth) <= MEGALIGHTS_TEMPORAL_DEPTH_GATE * Math.max(depth, neighborDepth);
}

/**
 * 穷举精确参考(验收②真值端,2026-10-04 定案):逐灯求和 = 零方差真值;
 * 点/聚/面积中心点近似的直接光本是有限和,穷举即离线参考的 S→∞ 极限。
 */
export function megaLightsExhaustiveReferenceCpu(lights: readonly MegaLight[],
  surfaces: readonly (readonly (number | LightVector3)[])[], width: number, height: number): Float32Array {
  const color = new Float32Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    let total: LightVector3 = [0, 0, 0];
    for (let index = 0; index < lights.length; index++) {
      const shade = megaShadeWinnerCpu(lights, surfaces[pixel]!, index);
      total = [total[0] + shade[0], total[1] + shade[1], total[2] + shade[2]];
    }
    color[pixel * 3] = total[0]; color[pixel * 3 + 1] = total[1]; color[pixel * 3 + 2] = total[2];
  }
  return color;
}

/**
 * 512 样本均匀 MC 参考(参考积分器自身的无偏性对拍腿;LCG 种子逐像素固定,无 RNG 依赖)。
 */

export function megaLightsReferenceCpu(lights: readonly MegaLight[], surfaces: readonly (readonly (number | LightVector3)[])[],
  width: number, height: number, samples = 512, seed = 0x9e3779b9): Float32Array {
  const lightCount = lights.length;
  const color = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const surface = surfaces[pixelIndex]!;
      let state = (megaHashU32(pixelIndex) ^ seed) >>> 0;
      let r = 0, g = 0, b = 0;
      for (let s = 0; s < samples; s++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const candidate = Math.min(lightCount - 1, Math.floor((state / 4294967296) * lightCount));
        const shade = megaShadeWinnerCpu(lights, surface, candidate);
        r += shade[0]; g += shade[1]; b += shade[2];
      }
      const scale = lightCount / samples;
      color[pixelIndex * 3] = r * scale; color[pixelIndex * 3 + 1] = g * scale; color[pixelIndex * 3 + 2] = b * scale;
    }
  }
  return color;
}

/** RMSE(线性 RGB,逐通道平方均值开根;验收②③的门度量)。 */
export function rmse(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error("rmse length mismatch.");
  let total = 0;
  for (let index = 0; index < a.length; index++) { const d = a[index]! - b[index]!; total += d * d; }
  return Math.sqrt(total / a.length);
}

/** RIS M 常数再导出(供 WGSL 互钉测试引用同一单源)。 */
export const RIS_CANDIDATES = MEGALIGHTS_RIS_CANDIDATES;
export const RIS_M = MEGALIGHTS_RIS_M;
