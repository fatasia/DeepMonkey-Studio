import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";

type DashboardAnimation = NonNullable<DashboardDataWidgetConfig["animation"]>;

/**
 * 入场类动画默认播放一次；脉冲表达持续状态，因此默认循环。
 * 显式配置始终优先，确保旧项目升级后仍可覆盖产品默认值。
 */
export function resolveDashboardAnimationLoop(widget: DashboardDataWidgetConfig): boolean {
  return widget.animationLoop ?? widget.animation === "pulse";
}

export function defaultDashboardAnimationLoop(animation: DashboardAnimation): boolean {
  return animation === "pulse";
}

