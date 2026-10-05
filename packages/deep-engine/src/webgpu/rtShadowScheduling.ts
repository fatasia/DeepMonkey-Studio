/**
 * B3 RT 阴影自动选路(帧粒度混合调度):rayTracedShadows 开启时,按**质量档 + 控制器
 * 健康度 + 滞回**在 RT mask 通道与级联通道间逐帧自动分配。
 *
 * == 语义 ==
 * 选路只影响两件事:① 本帧是否发射 RT mask dispatch(pbrRendererFrames 钩子);
 * ② 本帧 frame.output.bloom 开关位(pbrFrameUniforms 打包,1=采样 RT mask)。
 * 位 0 时 WGSL 分支不进入,行为严格等于级联档(pbrShadowSwitch ABI 合同,逐位);
 * 管线保持 RT 变体,无需重建(同 M2 fail-closed 回退通道)。mask 数值语义零变化
 * —— shadowRayGpuTest 的 GPU==CPU/RMSE 门不受选路影响,选路正确性由本模块
 * 单测 + 帧循环不变式(选路 cascade ⇒ 位 0)钉死。
 *
 * == 规则(确定性,按序裁决) ==
 * ① 控制器不健康(未 stage/disabled):cascade(controller:<原因>)—— 控制器自身
 *    sticky,本规则是既有 fail-closed 通道的显式化;
 * ② 自适应质量降到 performance 阴影档(knobs.shadowTier):cascade(adaptive-shadow-tier)
 *    —— 最大压力档卸掉全屏 RT dispatch,级联档 knobs 同帧已降级,总成本单调下降;
 * ③ 滞回冷却期内:cascade(hysteresis-cooldown)—— 档位在边界抖动时不振荡
 *    (默认 120 帧 ≈ 2s@60fps,与 AdaptiveQualityController cooldownFrames 同量级);
 * ④ 其余:ray-traced。
 *
 * == 状态机 ==
 * 状态(冷却计数)由调用方持有(渲染器实例),`tickRtShadowScheduling` 是唯一
 * 变异入口:RT 帧 → 清零;自适应触发 → 置满冷却;冷却帧 → 递减;控制器帧 → 不动。
 */

import type { CascadedShadowQualityTier } from "../shadows/shadowQuality.js";

/** 选路状态(渲染器持有;pbrRendererFrames 逐帧 tick)。 */
export interface RtShadowSchedulingState {
  /** 滞回冷却剩余帧数(0 = 不在冷却期)。 */
  cascadeCooldownFrames: number;
}

export interface RtShadowRouteInput {
  /** 控制器健康:已 stage 且未 disabled(rtShadows.sceneStaged && !rtShadows.disabled)。 */
  readonly rtHealthy: boolean;
  /** 控制器降级原因(仅诊断;规则①必为 cascade)。 */
  readonly controllerFallbackReason?: string;
  /** 自适应质量当前阴影档(knobs.shadowTier;无控制器时调用方传 "ultra" = 不干预)。 */
  readonly shadowTier: CascadedShadowQualityTier;
  /** 调用方持有的状态(冷却计数)。 */
  readonly state: RtShadowSchedulingState;
  /** 滞回冷却帧数(默认 120)。 */
  readonly cooldownFrames?: number;
}

export type RtShadowChannel = "ray-traced" | "cascade";

export type RtShadowRoute =
  | { readonly channel: "ray-traced" }
  | { readonly channel: "cascade"; readonly reason: string };

/** 自适应触发的原因码(tick 据此置冷却;前缀合同,勿改字面量)。 */
export const RT_SHADOW_ADAPTIVE_REASON = "adaptive-shadow-tier-performance";
export const RT_SHADOW_HYSTERESIS_REASON = "hysteresis-cooldown";
export const RT_SHADOW_DEFAULT_COOLDOWN_FRAMES = 120;

/** 逐帧选路(纯裁决,不变异状态;状态变异只在 tickRtShadowScheduling)。 */
export function resolveRtShadowRoute(input: RtShadowRouteInput): RtShadowRoute {
  if (!input.rtHealthy) {
    return Object.freeze({ channel: "cascade" as const,
      reason: `controller:${input.controllerFallbackReason ?? "unstaged"}` });
  }
  if (input.shadowTier === "performance") {
    return Object.freeze({ channel: "cascade" as const, reason: RT_SHADOW_ADAPTIVE_REASON });
  }
  if (input.state.cascadeCooldownFrames > 0) {
    return Object.freeze({ channel: "cascade" as const, reason: RT_SHADOW_HYSTERESIS_REASON });
  }
  return Object.freeze({ channel: "ray-traced" as const });
}

/** 状态机唯一变异入口(帧内 resolve 之后调用一次)。 */
export function tickRtShadowScheduling(state: RtShadowSchedulingState, route: RtShadowRoute,
  cooldownFrames = RT_SHADOW_DEFAULT_COOLDOWN_FRAMES): void {
  if (route.channel === "ray-traced") {
    state.cascadeCooldownFrames = 0;
    return;
  }
  if (route.reason === RT_SHADOW_ADAPTIVE_REASON) {
    state.cascadeCooldownFrames = cooldownFrames;
    return;
  }
  if (route.reason === RT_SHADOW_HYSTERESIS_REASON) {
    state.cascadeCooldownFrames = Math.max(0, state.cascadeCooldownFrames - 1);
  }
  // controller:<原因> 帧:控制器自身 sticky,冷却计数不动(恢复由 stageRayTracedShadowScene
  // 切回 RT 档,下一帧规则④直通)。
}

/** 帧指标披露形状(FrameMetrics.rtShadowRoute)。 */
export type RtShadowRouteMetrics = Readonly<{ channel: RtShadowChannel; reason?: string }>;

export function rtShadowRouteMetrics(route: RtShadowRoute): RtShadowRouteMetrics {
  return route.channel === "cascade"
    ? Object.freeze({ channel: "cascade", reason: route.reason })
    : Object.freeze({ channel: "ray-traced" });
}
