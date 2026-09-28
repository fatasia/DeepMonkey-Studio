/**
 * T10 硬件 RT 能力探测的纯映射层（无 GPU 依赖，vitest / Node / 浏览器共用单一来源）。
 * 输入：wgpu adapter 暴露的原始 feature 名列表（+ 可选 adapter info / limits 摘要）；
 * 输出：P4 合同 `RayTracingCapabilities` 快照 + `resolveRayTracingDecision` 路径决策。
 *
 * == 纪律（主计划 §T10）==
 * 1. 能力探测不启用 RT 渲染：本模块只做「特征名 → 合同快照 → 决策」的确定性映射，
 *    不含任何 dispatch/构建加速结构逻辑；真机采集在 scripts/rtCapabilityGpuProbe.mjs。
 * 2. 候选特征名按已知生态命名逐枚举（wgpu-rs JS 映射名、Dawn 实验名、提案名），
 *    命中任一即算该 P4 feature 支持；探测层（枚举/设备请求/API 表面）由采集脚本分层记录。
 * 3. 不支持设备必须给出明确「软件路径」决策：tier=none 时 decision.enabled=false 且
 *    fallbacks=["raster","software-gi","software-shadows"]（合同函数语义，此处固化断言）。
 * 4. maxAccelerationStructureBytes=0 表示「本探测路径无法给出该值」，不是支持且为 0；
 *    浏览器 wgpu 未提供该 limit，仅在 native 腿给出真实值时才非 0。
 */

import {
  resolveRayTracingDecision,
  validateRayTracingCapabilities,
  type RayTracingCapabilities,
  type RayTracingDecision,
  type RayTracingFeature,
  type RayTracingTier,
} from "../rayTracingCapabilities.js";

/**
 * P4 feature → 已知 adapter feature 名候选（任一命中即支持）。
 * 命名依据：wgpu-rs `Features::RAY_TRACING_ACCELERATION_STRUCTURE` / `EXPERIMENTAL_RAY_QUERY`
 * 的 JS kebab-case 映射、Dawn `chromium-experimental-ray-query`、WebGPU RT 提案名。
 * 列表是探测输入不是结论；未见候选名 ≠ 永不支持，只表示当前 adapter 未暴露。
 */
export const RT_FEATURE_NAME_CANDIDATES: Readonly<Record<RayTracingFeature, readonly string[]>> = Object.freeze({
  "acceleration-structure": Object.freeze(["ray-tracing-acceleration-structure", "acceleration-structure",
    "ray-tracing-vertex-returns", "ray-tracing-hit-records"]),
  "ray-query": Object.freeze(["ray-query", "chromium-experimental-ray-query"]),
  "rt-pipeline": Object.freeze(["rt-pipeline", "ray-tracing-pipeline"]),
});

export const ALL_RT_FEATURE_CANDIDATE_NAMES: readonly string[] =
  Object.values(RT_FEATURE_NAME_CANDIDATES).flat();

export interface RtFeatureSupport {
  readonly features: Readonly<Record<RayTracingFeature, boolean>>;
  /** 每个 P4 feature 实际命中的候选名（证据链；未命中为空数组）。 */
  readonly matchedNames: Readonly<Record<RayTracingFeature, readonly string[]>>;
}

/** 从 adapter 特征名列表推导 P4 feature 支持矩阵；纯函数，同输入逐字段同输出。 */
export function detectRayTracingFeatureSupport(featureNames: readonly string[]): RtFeatureSupport {
  const present = new Set(featureNames);
  const features = {} as Record<RayTracingFeature, boolean>;
  const matchedNames = {} as Record<RayTracingFeature, readonly string[]>;
  for (const feature of Object.keys(RT_FEATURE_NAME_CANDIDATES) as RayTracingFeature[]) {
    const matched = RT_FEATURE_NAME_CANDIDATES[feature]!.filter((name) => present.has(name));
    matchedNames[feature] = Object.freeze(matched);
    features[feature] = matched.length > 0;
  }
  return { features: Object.freeze(features), matchedNames: Object.freeze(matchedNames) };
}

/** tier 推导：三件套齐 = pipeline；AS+ray-query = query；否则 none（与 P4 resolve 决策语义一致）。 */
export function deriveRayTracingTier(features: Readonly<Record<RayTracingFeature, boolean>>): RayTracingTier {
  if (!features["acceleration-structure"]) return "none";
  if (!features["ray-query"]) return "none";
  return features["rt-pipeline"] ? "pipeline" : "query";
}

export interface RtCapabilitySnapshotInput {
  /** adapter 稳定标识（info 序列化串或调用方命名；空串合法但会被合同视为普通 id）。 */
  readonly adapterId: string;
  readonly featureNames: readonly string[];
  /** 仅当 native/其它腿给出真实值时传入；浏览器腿省略 → 0（=未知，非「支持且为 0」）。 */
  readonly maxAccelerationStructureBytes?: number;
}

export interface RtCapabilitySnapshot {
  readonly capabilities: RayTracingCapabilities;
  readonly support: RtFeatureSupport;
  readonly tierDerived: RayTracingTier;
  /** 合同校验回执（false 即快照构造有 bug，fail-closed）。 */
  readonly contractValid: boolean;
}

/** 组装 P4 合同快照并回执合同校验；探测数据落盘一律以此为唯一组装点。 */
export function buildRayTracingCapabilitiesSnapshot(input: RtCapabilitySnapshotInput): RtCapabilitySnapshot {
  const support = detectRayTracingFeatureSupport(input.featureNames);
  const tierDerived = deriveRayTracingTier(support.features);
  const capabilities: RayTracingCapabilities = {
    schemaVersion: 1,
    adapterId: input.adapterId,
    tier: tierDerived,
    features: support.features,
    maxAccelerationStructureBytes: input.maxAccelerationStructureBytes ?? 0,
  };
  return { capabilities, support, tierDerived, contractValid: validateRayTracingCapabilities(capabilities) };
}

export interface T10PathDecision {
  readonly decision: RayTracingDecision;
  /** 明确软件路径语义：决策关闭 RT 即必须走软件/光栅路径（验收条款的机读形态）。 */
  readonly softwarePathRequired: boolean;
}

/**
 * T10 路径决策：requested tier 默认 pipeline（静帧路径追踪目标形态）。
 * tier=none 时 fallbacks 必须含 raster/software-gi/software-shadows 三项（合同语义），否则抛错。
 */
export function resolveT10PathDecision(capabilities: RayTracingCapabilities,
  requested: RayTracingTier = "pipeline"): T10PathDecision {
  const decision = resolveRayTracingDecision(capabilities, requested);
  if (!decision.enabled) {
    const required = new Set(["raster", "software-gi", "software-shadows"] as const);
    for (const fallback of decision.fallbacks) required.delete(fallback as "raster");
    if (required.size > 0) {
      throw new Error(`Software path decision incomplete: fallbacks missing ${[...required].join(", ")}.`);
    }
  }
  return { decision, softwarePathRequired: !decision.enabled };
}
