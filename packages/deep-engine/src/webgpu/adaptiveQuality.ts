import type { CascadedShadowQualityTier } from "../shadows/shadowQuality.js";
import { CASCADED_SHADOW_QUALITY_PROFILES } from "../shadows/shadowQuality.js";
import type { DeviceResourceMemorySnapshot } from "./deviceResourceMemory.js";

export interface AdaptiveQualityKnobs {
  readonly ssrConeLevels: number;
  readonly ddgiUpdateBudget: number;
  readonly fogSteps: number;
  readonly shadowTier: CascadedShadowQualityTier;
  readonly lodDetailScale: number;
  readonly residencyBudgetScale: number;
}

export interface AdaptiveQualityOverrides extends Partial<AdaptiveQualityKnobs> {}

export interface AdaptiveQualityOptions {
  readonly enabled?: boolean;
  readonly targetFrameMs?: number;
  readonly minimumSamples?: number;
  readonly pressureWindows?: number;
  readonly recoveryWindows?: number;
  readonly cooldownFrames?: number;
  readonly overrides?: AdaptiveQualityOverrides;
  /** Local summaries remain disabled unless explicitly enabled. */
  readonly collectHotspots?: boolean;
}

export interface AdaptiveQualitySample {
  readonly frame: number;
  readonly sampleCount: number;
  readonly cpuP95Ms: number;
  readonly cpuP99Ms: number;
  readonly gpuP95Ms?: number;
  readonly gpuP99Ms?: number;
  readonly longFrameCount: number;
  readonly width: number;
  readonly height: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly memory: DeviceResourceMemorySnapshot;
}

export type AdaptiveQualityReason = "initial" | "gpu-pressure" | "cpu-pressure" | "memory-pressure"
  | "long-frame-pressure" | "recovered" | "user-override";

export interface AdaptiveQualityState {
  readonly enabled: boolean;
  readonly level: 0 | 1 | 2 | 3;
  readonly knobs: Readonly<AdaptiveQualityKnobs>;
  readonly reason: AdaptiveQualityReason;
  readonly explanation: string;
  readonly changedAtFrame: number;
}

export type AdaptiveQualityHotspotKind = "gpu-frame" | "cpu-frame" | "memory" | "long-frame" | "fill-rate" | "content";
export interface AdaptiveQualityHotspotSummary {
  readonly kind: AdaptiveQualityHotspotKind;
  readonly severity: "notice" | "pressure";
  readonly sampleCount: number;
  readonly p95?: number;
  readonly p99?: number;
  readonly ratio?: number;
}

const PROFILES: readonly Readonly<AdaptiveQualityKnobs>[] = Object.freeze([
  Object.freeze({ ssrConeLevels: 6, ddgiUpdateBudget: 64, fogSteps: 64, shadowTier: "ultra", lodDetailScale: 1, residencyBudgetScale: 1 }),
  Object.freeze({ ssrConeLevels: 5, ddgiUpdateBudget: 48, fogSteps: 48, shadowTier: "high", lodDetailScale: 0.9, residencyBudgetScale: 0.9 }),
  Object.freeze({ ssrConeLevels: 4, ddgiUpdateBudget: 32, fogSteps: 40, shadowTier: "balanced", lodDetailScale: 0.75, residencyBudgetScale: 0.8 }),
  Object.freeze({ ssrConeLevels: 3, ddgiUpdateBudget: 16, fogSteps: 32, shadowTier: "performance", lodDetailScale: 0.6, residencyBudgetScale: 0.7 }),
]);

/** Hysteretic, cooldown-bound controller. It never disables an effect or drops objects. */
export class AdaptiveQualityController {
  private readonly options: Required<Omit<AdaptiveQualityOptions, "overrides">> & { readonly overrides: AdaptiveQualityOverrides };
  private level: 0 | 1 | 2 | 3 = 0;
  private pressure = 0; private recovery = 0; private lastChange = Number.NEGATIVE_INFINITY;
  private currentState: AdaptiveQualityState;
  private readonly hotspots: AdaptiveQualityHotspotSummary[] = [];

  constructor(options: AdaptiveQualityOptions = {}) {
    this.options = validateOptions(options);
    this.currentState = this.makeState(0, this.options.enabled ? "initial" : "user-override",
      this.options.enabled ? "设备自适应已启用，等待足够的本地样本。" : "设备自适应已关闭。", 0);
  }

  sample(sample: AdaptiveQualitySample): AdaptiveQualityState | undefined {
    validateSample(sample);
    if (!this.options.enabled || sample.sampleCount < this.options.minimumSamples) return undefined;
    const signal = classifyPressure(sample, this.options.targetFrameMs);
    this.recordHotspots(sample, signal);
    const cooldown = sample.frame - this.lastChange < this.options.cooldownFrames;
    if (signal) {
      this.pressure++; this.recovery = 0;
      if (cooldown || this.pressure < this.options.pressureWindows || this.level === 3) return undefined;
      this.pressure = 0; this.level = (this.level + 1) as 1 | 2 | 3; this.lastChange = sample.frame;
      this.currentState = this.makeState(this.level, signal.reason, signal.explanation, sample.frame);
      return this.currentState;
    }
    this.pressure = 0;
    const healthy = Math.max(sample.cpuP95Ms, sample.gpuP95Ms ?? 0) <= this.options.targetFrameMs * 0.72
      && memoryRatio(sample.memory) < 0.72 && sample.longFrameCount === 0;
    if (!healthy || this.level === 0) { this.recovery = 0; return undefined; }
    this.recovery++;
    if (cooldown || this.recovery < this.options.recoveryWindows) return undefined;
    this.recovery = 0; this.level = (this.level - 1) as 0 | 1 | 2; this.lastChange = sample.frame;
    this.currentState = this.makeState(this.level, "recovered", "CPU、GPU 与显存压力持续恢复，逐级恢复画质。", sample.frame);
    return this.currentState;
  }

  state(): AdaptiveQualityState { return this.currentState; }
  hotspotSummary(): readonly AdaptiveQualityHotspotSummary[] {
    return this.options.collectHotspots ? Object.freeze(this.hotspots.map(item => Object.freeze({ ...item }))) : Object.freeze([]);
  }

  private makeState(level: 0 | 1 | 2 | 3, reason: AdaptiveQualityReason, explanation: string, frame: number): AdaptiveQualityState {
    const profile = PROFILES[level]!;
    const knobs = Object.freeze({ ...profile, ...this.options.overrides });
    return Object.freeze({ enabled: this.options.enabled, level, knobs, reason,
      explanation: Object.keys(this.options.overrides).length ? `${explanation} 作者覆盖项保持不变。` : explanation,
      changedAtFrame: frame });
  }

  private recordHotspots(sample: AdaptiveQualitySample, signal: ReturnType<typeof classifyPressure>): void {
    if (!this.options.collectHotspots) return;
    const append = (summary: AdaptiveQualityHotspotSummary): void => {
      this.hotspots.push(Object.freeze(summary)); if (this.hotspots.length > 16) this.hotspots.shift();
    };
    if (signal?.reason === "gpu-pressure") append({ kind: "gpu-frame", severity: "pressure", sampleCount: sample.sampleCount,
      p95: sample.gpuP95Ms!, p99: sample.gpuP99Ms ?? sample.gpuP95Ms! });
    else if (signal?.reason === "cpu-pressure") append({ kind: "cpu-frame", severity: "pressure", sampleCount: sample.sampleCount,
      p95: sample.cpuP95Ms, p99: sample.cpuP99Ms });
    else if (signal?.reason === "memory-pressure") append({ kind: "memory", severity: "pressure", sampleCount: sample.sampleCount,
      ratio: memoryRatio(sample.memory) });
    else if (signal?.reason === "long-frame-pressure") append({ kind: "long-frame", severity: "pressure", sampleCount: sample.sampleCount,
      ratio: sample.longFrameCount / sample.sampleCount });
    if (signal?.reason === "gpu-pressure" && sample.width * sample.height >= 3_000_000) append({ kind: "fill-rate",
      severity: "notice", sampleCount: sample.sampleCount, ratio: sample.width * sample.height / 3_000_000 });
    if (signal?.reason === "cpu-pressure" && (sample.drawCalls >= 1_000 || sample.triangles >= 5_000_000)) append({ kind: "content",
      severity: "notice", sampleCount: sample.sampleCount, ratio: Math.max(sample.drawCalls / 1_000, sample.triangles / 5_000_000) });
  }
}

/** The author shadow map size is a ceiling: adaptive pressure only ever asks for equal or less. */
export function adaptiveShadowMapSize(tier: CascadedShadowQualityTier,
  authorShadowSize: number | undefined): number | undefined {
  const tierSize = CASCADED_SHADOW_QUALITY_PROFILES[tier].options.shadowMapSize;
  if (authorShadowSize === undefined) return undefined;
  return tierSize < authorShadowSize ? tierSize : undefined;
}

function classifyPressure(sample: AdaptiveQualitySample, target: number): { reason: AdaptiveQualityReason; explanation: string } | undefined {
  const memory = memoryRatio(sample.memory);
  if (memory >= 0.9) return { reason: "memory-pressure", explanation: `显存预算使用率 ${(memory * 100).toFixed(0)}%，降低瞬时与更新预算。` };
  if (sample.gpuP95Ms !== undefined && (sample.gpuP95Ms > target * 1.12 || (sample.gpuP99Ms ?? 0) > target * 1.45)) {
    return { reason: "gpu-pressure", explanation: `GPU P95/P99 为 ${sample.gpuP95Ms.toFixed(1)}/${(sample.gpuP99Ms ?? sample.gpuP95Ms).toFixed(1)} ms。` };
  }
  if (sample.cpuP95Ms > target * 1.12 || sample.cpuP99Ms > target * 1.45) {
    return { reason: "cpu-pressure", explanation: `CPU P95/P99 为 ${sample.cpuP95Ms.toFixed(1)}/${sample.cpuP99Ms.toFixed(1)} ms。` };
  }
  if (sample.longFrameCount / sample.sampleCount >= 0.04) return { reason: "long-frame-pressure", explanation: "长帧比例持续超过 4%。" };
  return undefined;
}

function memoryRatio(memory: DeviceResourceMemorySnapshot): number {
  return memory.admission ? memory.estimatedBytes / memory.admission.budgetBytes : 0;
}

function validateOptions(value: AdaptiveQualityOptions): Required<Omit<AdaptiveQualityOptions, "overrides">> & { readonly overrides: AdaptiveQualityOverrides } {
  if (value.enabled !== undefined && typeof value.enabled !== "boolean"
    || value.collectHotspots !== undefined && typeof value.collectHotspots !== "boolean") {
    throw new TypeError("Adaptive enabled and collectHotspots options must be boolean.");
  }
  const targetFrameMs = value.targetFrameMs ?? 16.67, minimumSamples = value.minimumSamples ?? 64;
  const pressureWindows = value.pressureWindows ?? 3, recoveryWindows = value.recoveryWindows ?? 6, cooldownFrames = value.cooldownFrames ?? 180;
  if (!Number.isFinite(targetFrameMs) || targetFrameMs < 8 || targetFrameMs > 100) throw new RangeError("Adaptive targetFrameMs must be in [8,100].");
  for (const [name, candidate, min, max] of [["minimumSamples", minimumSamples, 16, 4096], ["pressureWindows", pressureWindows, 1, 32],
    ["recoveryWindows", recoveryWindows, 1, 64], ["cooldownFrames", cooldownFrames, 0, 36000]] as const) {
    if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) throw new RangeError(`Adaptive ${name} must be an integer in [${min},${max}].`);
  }
  const overrides = Object.freeze({ ...(value.overrides ?? {}) }); validateKnobs(overrides);
  return Object.freeze({ enabled: value.enabled ?? false, targetFrameMs, minimumSamples, pressureWindows, recoveryWindows,
    cooldownFrames, overrides, collectHotspots: value.collectHotspots ?? false });
}

function validateKnobs(value: AdaptiveQualityOverrides): void {
  const bounded = (candidate: number | undefined, min: number, max: number, name: string): void => {
    if (candidate !== undefined && (!Number.isFinite(candidate) || candidate < min || candidate > max)) throw new RangeError(`Adaptive ${name} must be in [${min},${max}].`);
  };
  bounded(value.ssrConeLevels, 2, 6, "ssrConeLevels"); bounded(value.ddgiUpdateBudget, 1, 64, "ddgiUpdateBudget");
  bounded(value.fogSteps, 32, 64, "fogSteps"); bounded(value.lodDetailScale, 0.5, 1, "lodDetailScale");
  bounded(value.residencyBudgetScale, 0.5, 1, "residencyBudgetScale");
  for (const [name, candidate] of [["ssrConeLevels", value.ssrConeLevels], ["ddgiUpdateBudget", value.ddgiUpdateBudget],
    ["fogSteps", value.fogSteps]] as const) if (candidate !== undefined && !Number.isSafeInteger(candidate)) {
    throw new RangeError(`Adaptive ${name} must be an integer.`);
  }
  if (value.shadowTier !== undefined && !["performance", "balanced", "high", "ultra"].includes(value.shadowTier)) throw new RangeError("Unknown adaptive shadowTier.");
}

function validateSample(sample: AdaptiveQualitySample): void {
  if (!Number.isSafeInteger(sample.frame) || sample.frame < 0 || !Number.isSafeInteger(sample.sampleCount) || sample.sampleCount < 1) throw new RangeError("Adaptive sample frame/count is invalid.");
  for (const value of [sample.cpuP95Ms, sample.cpuP99Ms, sample.gpuP95Ms, sample.gpuP99Ms]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new RangeError("Adaptive timing must be finite and nonnegative.");
  if (!Number.isSafeInteger(sample.longFrameCount) || sample.longFrameCount < 0 || sample.longFrameCount > sample.sampleCount) throw new RangeError("Adaptive long-frame count is invalid.");
  if (![sample.width, sample.height, sample.drawCalls, sample.triangles].every(value => Number.isSafeInteger(value) && value >= 0)) throw new RangeError("Adaptive frame complexity is invalid.");
}
