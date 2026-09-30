/**
 * I-C16 / T10 离线路径追踪出图产品模式——CPU 侧记账类型与纯函数（状态机切片）。
 *
 * == 职责边界 ==
 * 本模块只承载**可独立验证的纯函数**：配置校验/归一化、字节估算、失效身份判定、
 * 在线统计合并与收敛双门。状态机本体在 pathTraceSession.ts；像素/射线核不在本刀
 * （见 pathTraceReferenceKernel.ts 头注释与 docs/specs/i-c16-pathtrace-product-cpu-20261001.md）。
 *
 * == 口径 ==
 * 逐样本标量 X = 通道均值（RGB 平均，线性域），与 probeReferenceIntegrator 同口径；
 * 方差是全图聚合单标量（在线 sum/sumSq 合并），逐像素自适应门是 GPU 刀扩展点。
 * 收敛 = 样本门（n ≥ minSamples）AND 方差门（相对标准误 ≤ varianceThreshold）双门同时满足。
 */

/** 产品模式状态机相位（语义见规格"状态与触发矩阵"）。 */
export type PathTracePhase = "idle" | "accumulating" | "invalidated" | "reaccumulating"
  | "cancelled" | "exported";

/** 失效来源：场景/材质/相机身份变化，或用户显式请求。 */
export type PathTraceInvalidationReason = "material-revision" | "explicit-request";

/** 场景修订身份三元组：任一变化即要求重置累积（相机无特权）。 */
export interface PathTraceSceneIdentity {
  readonly sceneRevision: number;
  readonly materialHash: string;
  readonly cameraHash: string;
}

/** 会话配置；未知字段一律拒绝（fail-closed，见 validatePathTraceConfig）。 */
export interface PathTraceSessionConfig {
  readonly width: number;
  readonly height: number;
  /** 样本预算上限（收敛样本门的上界，也是拒绝推进的硬帽）。 */
  readonly maxSamples: number;
  /** 样本门：n ≥ minSamples 才可能收敛（默认 64）。 */
  readonly minSamples?: number;
  /** 方差门：全图相对标准误阈值（默认 0.01）。 */
  readonly varianceThreshold?: number;
  /** 方差门参照亮度的下限（防全黑图除零，默认 1/65535）。 */
  readonly brightnessFloor?: number;
  /** 累积缓冲字节预算上限（均值+方差两平面合计）。 */
  readonly maxAccumulationBytes: number;
  /** 每样本通道数（默认 3 = RGB 线性）。 */
  readonly channelsPerSample?: number;
  /** 每通道字节数（默认 4 = float32）。 */
  readonly bytesPerChannel?: number;
  /** 显式种子（完整 u32，I-C17 模式）；同 seed 逐位同输出是核的义务。 */
  readonly sampleSeed?: number;
}

/** 归一化后的会话配置（defaults 已填充，只读）。 */
export interface ResolvedPathTraceConfig {
  readonly width: number;
  readonly height: number;
  readonly maxSamples: number;
  readonly minSamples: number;
  readonly varianceThreshold: number;
  readonly brightnessFloor: number;
  readonly maxAccumulationBytes: number;
  readonly channelsPerSample: number;
  readonly bytesPerChannel: number;
  readonly sampleSeed: number | undefined;
}

/** 累积缓冲租约：均值平面 + 方差平面；dispose 恰一次是会话的契约（测试用 spy 钉死）。 */
export interface PathTraceAccumulationLease {
  readonly bytes: number;
  dispose(): void;
}

/** 单批统计观测：标量亮度域的增量聚合输入。 */
export interface PathTraceBatchObservation {
  /** 本批样本数（≥1 安全整数）。 */
  readonly samples: number;
  /** 本批亮度标量和（非负有限）。 */
  readonly brightnessSum: number;
  /** 本批亮度标量平方和（非负有限）。 */
  readonly brightnessSumSq: number;
  /** 可选代际防护：与当前会话代际不符时拒绝（防跨代统计污染）。 */
  readonly generation?: number;
}

export interface PathTraceBeginOutcome {
  readonly status: "started" | "rejected-budget" | "cancelled";
  readonly phase: PathTracePhase;
  readonly generation: number;
  /** started/rejected 时给出预算判定用的估算字节。 */
  readonly estimatedBytes?: number;
}

export interface PathTraceBatchOutcome {
  readonly status: "advanced" | "rejected-limit" | "cancelled";
  readonly phase: PathTracePhase;
  readonly generation: number;
  readonly sampleCount: number;
  readonly converged: boolean;
}

export interface PathTraceInvalidationOutcome {
  readonly phase: PathTracePhase;
  readonly generation: number;
  readonly reason: PathTraceInvalidationReason;
}

export interface PathTraceExportReceipt {
  readonly width: number;
  readonly height: number;
  readonly generation: number;
  readonly sampleCount: number;
  /** 收敛时刻的全图聚合方差（标量亮度域）。 */
  readonly variance: number;
  readonly relativeStandardError: number;
  /** 出图格式标签：Radiance HDR RGBE（textures/radianceHdrEncode.ts 编码）。 */
  readonly format: "radiance-hdr-rgbe";
  readonly seed: number | undefined;
}

/** 校验并归一化会话配置；非法输入抛 TypeError/RangeError（fail-closed）。 */
export function validatePathTraceConfig(config: PathTraceSessionConfig): ResolvedPathTraceConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("Path trace session config is required.");
  }
  const integer = (value: number | undefined, name: string, minimum: number): number => {
    if (value === undefined) throw new TypeError(`Path trace ${name} is required.`);
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new RangeError(`Path trace ${name} must be a safe integer ≥ ${minimum}.`);
    }
    return value;
  };
  const positive = (value: number | undefined, name: string): number => {
    if (value === undefined) throw new TypeError(`Path trace ${name} is required.`);
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new RangeError(`Path trace ${name} must be finite and positive.`);
    }
    return value;
  };
  const width = integer(config.width, "width", 1);
  const height = integer(config.height, "height", 1);
  const maxSamples = integer(config.maxSamples, "maxSamples", 1);
  const channelsPerSample = config.channelsPerSample === undefined ? 3
    : integer(config.channelsPerSample, "channelsPerSample", 1);
  const bytesPerChannel = config.bytesPerChannel === undefined ? 4
    : integer(config.bytesPerChannel, "bytesPerChannel", 1);
  const maxAccumulationBytes = positive(config.maxAccumulationBytes, "maxAccumulationBytes");
  let seed: number | undefined;
  if (config.sampleSeed !== undefined) {
    if (!Number.isSafeInteger(config.sampleSeed) || config.sampleSeed < 0 || config.sampleSeed > 0xFFFFFFFF) {
      throw new RangeError("Path trace sampleSeed must be a safe integer in [0, 2^32-1].");
    }
    seed = config.sampleSeed;
  }
  const resolved: ResolvedPathTraceConfig = Object.freeze({
    width, height, maxSamples,
    minSamples: config.minSamples === undefined ? 64 : integer(config.minSamples, "minSamples", 1),
    varianceThreshold: positive(config.varianceThreshold ?? 0.01, "varianceThreshold"),
    brightnessFloor: positive(config.brightnessFloor ?? 1 / 65535, "brightnessFloor"),
    maxAccumulationBytes, channelsPerSample, bytesPerChannel, sampleSeed: seed,
  });
  if (resolved.minSamples > resolved.maxSamples) {
    throw new RangeError("Path trace minSamples must not exceed maxSamples.");
  }
  return resolved;
}

/** 累积驻留字节估算：均值平面 + 方差平面（两份 width×height×channels×bytesPerChannel）。 */
export function estimateAccumulationBytes(config: ResolvedPathTraceConfig): number {
  const pixels = config.width * config.height;
  return pixels * config.channelsPerSample * config.bytesPerChannel * 2;
}

/** 身份判定：initial（首次）/ unchanged（全等）/ identity（任一成员变化，需重置）。 */
export function classifyIdentityInvalidation(previous: PathTraceSceneIdentity | undefined,
  next: PathTraceSceneIdentity): "initial" | "unchanged" | "identity" {
  for (const value of [previous, next]) {
    if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value)
      || !Number.isSafeInteger(value.sceneRevision) || value.sceneRevision < 0
      || typeof value.materialHash !== "string" || typeof value.cameraHash !== "string"
      || value.materialHash.length === 0 || value.cameraHash.length === 0)) {
      throw new TypeError("Path trace scene identity is malformed.");
    }
  }
  if (previous === undefined) return "initial";
  return previous.sceneRevision === next.sceneRevision && previous.materialHash === next.materialHash
    && previous.cameraHash === next.cameraHash ? "unchanged" : "identity";
}

/** 在线统计累加器（标量亮度域；n/sum/sumSq 全部有限）。 */
export interface BrightnessAccumulator {
  readonly sampleCount: number;
  readonly sum: number;
  readonly sumSq: number;
}

/** 合并单批观测；样本预算超限返回 undefined（调用方按 rejected-limit 处理，不改状态）。 */
export function mergeBatchObservation(state: BrightnessAccumulator,
  observation: PathTraceBatchObservation, maxSamples: number): BrightnessAccumulator | undefined {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw new TypeError("Path trace batch observation is required.");
  }
  const { samples, brightnessSum, brightnessSumSq } = observation;
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new RangeError("Path trace batch samples must be a safe integer ≥ 1.");
  }
  for (const [value, name] of [[brightnessSum, "brightnessSum"], [brightnessSumSq, "brightnessSumSq"]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`Path trace batch ${name} must be finite and non-negative.`);
    }
  }
  if (state.sampleCount + samples > maxSamples) return undefined;
  return Object.freeze({ sampleCount: state.sampleCount + samples,
    sum: state.sum + brightnessSum, sumSq: state.sumSq + brightnessSumSq });
}

export interface ConvergenceEvaluation {
  readonly converged: boolean;
  readonly sampleCount: number;
  readonly variance: number;
  readonly standardError: number;
  readonly relativeStandardError: number;
}

/**
 * 收敛双门：样本门（n ≥ minSamples）AND 方差门（se/max(mean,floor) ≤ threshold）。
 * var 由 sum/sumSq 合成：sumSq/n − mean²，负漂移钳 0；单样本（n=1）方差恒 0 但样本门挡住。
 */
export function evaluateConvergence(state: BrightnessAccumulator,
  config: ResolvedPathTraceConfig): ConvergenceEvaluation {
  const n = state.sampleCount;
  if (n < 1) {
    return Object.freeze({ converged: false, sampleCount: n, variance: 0,
      standardError: Number.POSITIVE_INFINITY, relativeStandardError: Number.POSITIVE_INFINITY });
  }
  const mean = state.sum / n;
  const variance = Math.max(0, state.sumSq / n - mean * mean);
  const standardError = Math.sqrt(variance / n);
  const relativeStandardError = standardError / Math.max(mean, config.brightnessFloor);
  const converged = n >= config.minSamples && relativeStandardError <= config.varianceThreshold;
  return Object.freeze({ converged, sampleCount: n, variance, standardError, relativeStandardError });
}
