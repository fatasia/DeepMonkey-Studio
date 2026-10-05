/**
 * F1 逐 pass GPU 计时的 pass 身份唯一来源。
 *
 * 该清单必须与 pbrFramePlanExecutor.MAPPED_EXECUTORS 的键集合一致(contact-shadow 为上一帧深度的前 opaque 计算步):每个 mapped
 * pass 都要有 marker 括夹与遥测阶段;buildPbrFrameExecutionPlan 在构建计划时做
 * 漂移校验,清单漏记会在计划构建期显式报错而不是静默丢计时。
 */
export const PBR_TIMED_PASS_IDS = Object.freeze([
  "contact-shadow",
  "contact-apply",
  "opaque",
  "ambient-occlusion",
  "apply-ambient-occlusion",
  "transparent-oit",
  "composite-oit",
  "volumetric-fog-march",
  "volumetric-fog-composite",
  "screen-space-reflection-trace",
  "screen-space-reflection-composite",
  "screen-space-gi-trace",
  "screen-space-gi-composite",
  "temporal-aa",
  "temporal-upscale",
  "bloom",
  "sdf-gi-sky-trace",
  "sdf-gi-probe-update",
  "present",
] as const);

export type PbrTimedPassId = (typeof PBR_TIMED_PASS_IDS)[number];

/** EnginePerformanceTelemetry 的逐 pass 阶段键前缀。 */
export const PBR_PASS_TIMING_STAGE_PREFIX = "gpu-pass:";

export function pbrPassTimingStage(passId: string): string {
  return `${PBR_PASS_TIMING_STAGE_PREFIX}${passId}`;
}

export function isPbrPassTimingStage(stage: string): stage is `gpu-pass:${string}` {
  return stage.startsWith(PBR_PASS_TIMING_STAGE_PREFIX)
    && (PBR_TIMED_PASS_IDS as readonly string[]).includes(stage.slice(PBR_PASS_TIMING_STAGE_PREFIX.length));
}
