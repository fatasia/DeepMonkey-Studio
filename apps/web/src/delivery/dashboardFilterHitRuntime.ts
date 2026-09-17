import type { DashboardDataWidgetNode, JsonValue } from "@bim-studio/contracts";
import {
  dashboardFilterHitCommand,
  type DashboardFilterActivation,
  type DashboardFilterHitResult,
} from "./dashboardFilterHitCommand";

/**
 * G02 的宿主接线边界：命中白名单只负责解释输入，筛选状态仍由既有 playback store 持有。
 * G01 组合宿主只需把 Native/Web 命中交给此函数，不能另建筛选状态或绕过后代清理语义。
 */
export function dispatchDashboardFilterHit(
  node: DashboardDataWidgetNode,
  activation: DashboardFilterActivation,
  target: Readonly<{
    filters: Readonly<Record<string, JsonValue>>;
    setFilter(key: string, value: JsonValue | undefined): void;
  }>,
): DashboardFilterHitResult {
  const result = dashboardFilterHitCommand(node, activation, target.filters);
  if (result.ok) target.setFilter(result.command.key, result.command.value);
  return result;
}
