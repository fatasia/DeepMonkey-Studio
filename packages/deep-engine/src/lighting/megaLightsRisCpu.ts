import type { LightVector3 } from "./types.js";
import { evaluateIesShadingFactor, type PackedIesShading } from "./iesShading.js";
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
 * 时域复用按标准蓄水池合并(单候选合并,M 钳制 20× 本帧候选数;相似门:深度比)。
 * 空间复用(M2 定案 2026-10-04)= **值域无偏平均**:每源独立 RIS 估计 W_src·shade 的
 * 邻域均值,精确无偏(WRS 恒等式,见 spatialUnbiasedAverageCpu 注释),取代旧式
 * 「邻居胜者单候选并入 + 全局 ÷m」——旧式把 resampled 胜者当均匀候选,系统性过亮
 * +17.7%,是 M2 验收① 16% 偏差的主源;标准 Alg.6 权重(W_j×t、Σw 不除 m)同因 T̂
 * 失配 +19%,一并弃用。复用引入的近似(无 MIS)残差由门与颜色 EMA 控制。
 * 胜者可见性(M2 2026-10-05)只乘 shade 侧:self 路径乘本像素 mask、空间分支乘源
 * 像素 mask(ReSTIR DI visibility reuse 惯例,过相似门传递);目标权重保持无遮挡
 * 口径,穷举参考保持无遮挡精确和——镜像经 MegaLightsFrameInput.visibility 注入,
 * 缺省恒 1(M1 逐位)。GPU 端 mask 由 traceTwoLevelOccluded 片段族在独立 pass 写入。
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
  /** 每像素胜者可见性 mask(1=可见/0=遮挡;M2 胜者可见性射线,GPU color.w 同语义。
   * 只乘 shade 侧:self 路径乘本像素、空间分支乘源像素(ReSTIR DI visibility reuse
   * 惯例);缺省 undefined = 恒 1(M1 逐位)。目标权重保持无遮挡口径。 */
  readonly visibility?: Float32Array | undefined;
  /** E02 IES 打包载荷(packIesShading 输出;2026-10-06 native IES 注入切片随帧链
   * 开放)。携带 iesSpotIndex 的灯:因子 = evaluateIesShadingFactor(同一份打包字节,
   * GPU binding 8 同源),乘在 cone 侧——目标权重与胜者着色同变(与 WGSL
   * deepMegaContribution 的 `radiance × attenuation × cone × ies` 同位)。缺省
   * undefined = 因子恒 1,帧输出与无 IES 逐位一致。 */
  readonly ies?: PackedIesShading | undefined;
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

/** IES 因子钩子(打包字节真值;与 WGSL deepMegaContribution 同位:方向取打包口径
 * 的单位向量(打包时归一),surfaceToLight 由 evaluateMegaLightCpu 传入同域向量;
 * 0.5° 网格量化吸收两端 acos/atan2 的 ULP 差异,iesShading.evaluateIesShadingFactor
 * 权威)。 */
function megaIesFactorOf(ies: PackedIesShading): (light: MegaLight, surfaceToLight: LightVector3) => number {
  return (light, surfaceToLight) => {
    if (light.iesSpotIndex === undefined) return 1;
    const direction = light.directionView ?? [0, 0, 1];
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    const packedDirection: LightVector3 = [direction[0]! / length, direction[1]! / length, direction[2]! / length];
    return evaluateIesShadingFactor(ies, light.iesSpotIndex, packedDirection, surfaceToLight);
  };
}

function surfaceEvaluation(lights: readonly MegaLight[], surface: readonly (number | LightVector3)[],
  index: number, ies?: PackedIesShading | undefined): LightVector3 {
  const iesFactor = ies === undefined ? undefined : megaIesFactorOf(ies);
  return evaluateMegaLightCpu(lights[index]!, megaSurfaceDecodeCpu(surface),
    ...(iesFactor === undefined ? [] : [iesFactor] as const));
}

/** 目标权重 = luminance(全量单灯贡献)(与 WGSL deepMegaContribution+luminance 同式同序)。 */
export function megaTargetWeightCpu(lights: readonly MegaLight[],
  surface: readonly (number | LightVector3)[], index: number,
  ies?: PackedIesShading | undefined): number {
  return luminance(surfaceEvaluation(lights, surface, index, ies));
}

/** 胜者着色(可见性因子乘 shade 侧;与 WGSL deepMegaShadeWinner 同式同位——
 * 缺省 1.0 = M1 恒 1 行为,×1.0 精确;穷举参考不走此参数,保持无遮挡精确和)。 */
export function megaShadeWinnerCpu(lights: readonly MegaLight[],
  surface: readonly (number | LightVector3)[], index: number, visibility = 1,
  ies?: PackedIesShading | undefined): LightVector3 {
  const shade = surfaceEvaluation(lights, surface, index, ies);
  return [shade[0] * visibility, shade[1] * visibility, shade[2] * visibility];
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
  surface: readonly (number | LightVector3)[], lightCount: number,
  ies?: PackedIesShading | undefined): number {
  if (reservoir.winner === MEGALIGHTS_INVALID_LIGHT || reservoir.m <= 0) return 0;
  const winnerWeight = megaTargetWeightCpu(lights, surface, reservoir.winner, ies);
  if (winnerWeight <= 0) return 0;
  return lightCount * reservoir.weightSum / (reservoir.m * winnerWeight);
}

/** 趟一:K 候选 + 时域合并(与 WGSL buildReservoirs 入口同式)。 */
export function buildReservoirPassCpu(input: MegaLightsFrameInput): RisReservoir[] {
  const { lights, surfaces, previous, motionUv, frame, config, ies } = input;
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
        const weight = megaTargetWeightCpu(lights, surface, candidate, ies);
        if (weight > 0) mergeReservoirCpu(reservoir, weight, candidate, 1, stream.next());
      }
      if (temporal) {
        const previousIndex = temporalPreviousPixelCpu(x, y, width, height, motionUv);
        if (previousIndex >= 0) {
          const history = previous[previousIndex]!;
          if (history.winner !== MEGALIGHTS_INVALID_LIGHT
            && temporalGateCpu(surface, surfaces[previousIndex]!)) {
            const weight = megaTargetWeightCpu(lights, surface, history.winner, ies);
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

/**
 * 趟二空间复用(M2 定案 2026-10-04):值域无偏平均(与 WGSL reuseAndShade spatial 分支同式)。
 *
 * 旧式(邻居胜者按 t(y_j, 本像素) 单候选并入 reservoir + 全局 ÷m)把 importance-resampled
 * 的邻居胜者当均匀候选:其期望权重 = E_p̂[t] >> E_U[t] = T/N,且相邻像素胜者高度重复,
 * 每重复一次多骗一份均匀权重 → 系统性过亮(实测 biasMeanRatio 1.177;双开时偏置跨帧同号,
 * EMA 无法消除 → 验收① 15.6%)。标准 Bitterli Alg.6 权重(W_j×t(y_j,x)、W_final=Σw 不除 m)
 * 同因 T̂ 失配仍 +19%(原型实测 39.4% relRMSE),两式皆弃。
 *
 * 值域平均:每源输出一个独立 RIS 估计 W_src·shade(y_src, 本像素),其中
 *   W_src = N·wSum_src/(m_src·t(y_src, 源像素))  (t 在**源像素**评价——恒等式要求)
 * 由 WRS 恒等式 E[(Σ_k t_k)·g(胜者)] = Σ_k E[t(x_k)·g(x_k)] 得
 *   E[W_src·shade] = (N/K)·K·(1/N)Σ_i shade_i = Σ_i shade_i(精确,无需几何相似近似),
 * J+1 源平均零偏置,方差按源相关性收缩(实测 8×8 场景单帧 15%→6%,双开 EMA 后 0.98%)。
 * 邻域越界槽跳过(非 clamp):clamp 重复最近源会减少边界像素的独立源数(实测单帧
 * RMSE +0.3~0.6pt),比率分母(实际计入源数)的边界效应在真实分辨率下可忽略,
 * 测试口径以后 16 帧均值吸收 8×8 小图的边界波动。
 * 相似门(法线+深度)保留:gate 失败的源无偏但高方差(几何断裂),条件剔除与旧 gate 语义一致。
 * 返回 null = 无有效源(调用方回落 self reservoir 着色)。
 */
function spatialUnbiasedAverageCpu(lights: readonly MegaLight[],
  surfaces: readonly (readonly (number | LightVector3)[])[], surface: readonly (number | LightVector3)[],
  built: readonly RisReservoir[], x: number, y: number, width: number, height: number,
  radius: number, lightCount: number, visibility: Float32Array | undefined,
  ies?: PackedIesShading | undefined): LightVector3 | null {
  let accR = 0, accG = 0, accB = 0, sources = 0;
  for (let offsetY = -radius; offsetY <= radius; offsetY++) {
    for (let offsetX = -radius; offsetX <= radius; offsetX++) {
      const nx = x + offsetX, ny = y + offsetY;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const sourceIndex = ny * width + nx;
      const source = built[sourceIndex]!;
      if (source.winner === MEGALIGHTS_INVALID_LIGHT || source.m <= 0) continue;
      const sourceSurface = surfaces[sourceIndex]!;
      if (!spatialGateCpu(surface, sourceSurface)) continue;
      const sourceTarget = megaTargetWeightCpu(lights, sourceSurface, source.winner, ies);
      if (sourceTarget <= 0) continue;
      const sourceWeight = lightCount * source.weightSum / (source.m * sourceTarget);
      // 源像素可见性复用(与 WGSL deepMegaVisibilityAt(sourceIndex) 同位;过门传递)。
      const shade = megaShadeWinnerCpu(lights, surface, source.winner, visibility?.[sourceIndex] ?? 1, ies);
      accR += shade[0] * sourceWeight;
      accG += shade[1] * sourceWeight;
      accB += shade[2] * sourceWeight;
      sources++;
    }
  }
  return sources > 0 ? [accR / sources, accG / sources, accB / sources] : null;
}

/** 趟二:5×5 空间值域平均 + 胜者着色(与 WGSL reuseAndShade 入口同式)。 */
export function reuseAndShadePassCpu(input: MegaLightsFrameInput, built: readonly RisReservoir[]): MegaLightsFrameOutput {
  const { lights, surfaces, config, previousColor, visibility, ies } = input;
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
      const surface = surfaces[pixelIndex]!;
      // 趟二不再改写蓄水池:空间复用走值域平均,输出 reservoir 保持趟一 self 状态
      // (下一帧时域历史只消费 winner/无效位,与 WGSL 宿主写回同语义)。
      const reservoir: RisReservoir = { ...built[pixelIndex]! };
      reservoirs[pixelIndex] = reservoir;
      if (config.exhaustive === true) {
        // 穷举对拍模式:逐灯求和(与簇光逐灯路径同式同序;⑤ 退化一致性腿;
        // IES 随 deepMegaContribution 同位消费,与 WGSL 穷举分支一致)。
        let total: LightVector3 = [0, 0, 0];
        for (let index = 0; index < lights.length; index++) {
          const c = megaShadeWinnerCpu(lights, surface, index, 1, ies);
          total = [total[0] + c[0], total[1] + c[1], total[2] + c[2]];
        }
        color[pixelIndex * 3] = total[0]; color[pixelIndex * 3 + 1] = total[1]; color[pixelIndex * 3 + 2] = total[2];
        continue;
      }
      let r: number, g: number, b: number;
      const averaged = spatial ? spatialUnbiasedAverageCpu(lights, surfaces, surface, built,
        x, y, width, height, radius, lightCount, visibility, ies) : null;
      if (averaged !== null) {
        [r, g, b] = averaged;
      } else {
        // self reservoir 着色(spatial 关闭,或空间平均无有效源回落)。
        // 可见性乘本像素 mask(与 WGSL deepMegaVisibilityAt(pixelIndex) 同位)。
        const selfVisibility = visibility?.[pixelIndex] ?? 1;
        const shade = reservoir.winner === MEGALIGHTS_INVALID_LIGHT || reservoir.m <= 0 ? [0, 0, 0] as LightVector3
          : megaShadeWinnerCpu(lights, surface, reservoir.winner, selfVisibility, ies);
        // W_Y 重用 finish 公式(胜者目标权重在本像素重评价)。
        const weightY = reservoir.winner === MEGALIGHTS_INVALID_LIGHT || reservoir.m <= 0 ? 0
          : megaTargetWeightCpu(lights, surface, reservoir.winner, ies);
        const scaleY = weightY > 0 ? lightCount * reservoir.weightSum / (reservoir.m * weightY) : 0;
        r = shade[0] * scaleY; g = shade[1] * scaleY; b = shade[2] * scaleY;
      }
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
 * `ies` 缺省恒等;帧内穷举腿与参考须同口径消费(与 WGSL 穷举分支一致)。
 */
export function megaLightsExhaustiveReferenceCpu(lights: readonly MegaLight[],
  surfaces: readonly (readonly (number | LightVector3)[])[], width: number, height: number,
  ies?: PackedIesShading | undefined): Float32Array {
  const color = new Float32Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    let total: LightVector3 = [0, 0, 0];
    for (let index = 0; index < lights.length; index++) {
      const shade = megaShadeWinnerCpu(lights, surfaces[pixel]!, index, 1, ies);
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
