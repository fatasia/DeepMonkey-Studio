/**
 * Split 分流节点的确定性路由。
 * 路由决策禁止消耗随机数：份额路按"累积份额 × 已投件数"的最大亏空轮转（Bresenham 式）
 * 选目标，长程份额精确且与事件顺序无关；份额路全满时才依次尝试兜底路，全满则阻塞保件。
 */

import type { PlantLiteModel, PlantLiteNode } from "./modelTypes.js";
import type { SplitRoutePlan } from "./runtimeTypes.js";

export function isSplitNode(node: PlantLiteNode): node is Extract<PlantLiteNode, { kind: "split" }> {
  return node.kind === "split";
}

/** 按模型顺序推导全部 split 的路由计划；份额和校验为 1 后不再归一，直接使用原值。 */
export function buildSplitPlans(model: PlantLiteModel): Map<string, SplitRoutePlan> {
  const plans = new Map<string, SplitRoutePlan>();
  for (const node of model.nodes) {
    if (!isSplitNode(node)) continue;
    const shareRoutes: number[] = [];
    const fallbackRoutes: number[] = [];
    node.routes.forEach((route, index) => {
      if (route.share !== undefined && route.share > 0) shareRoutes.push(index);
      else if (route.share === undefined) fallbackRoutes.push(index);
    });
    // 兜底路按 priority 升序、数组序破平，与既有出边优先级语义一致。
    fallbackRoutes.sort((left, right) =>
      (node.routes[left]!.priority ?? 0) - (node.routes[right]!.priority ?? 0) || left - right);
    plans.set(node.id, {
      targets: node.routes.map((route) => route.to),
      shares: node.routes.map((route) => route.share ?? 0),
      shareRoutes,
      fallbackRoutes,
    });
  }
  return plans;
}

/**
 * 返回本件待投 item 的候选路下标序列：
 * 先按亏空降序（下标破平）排列份额路，再按计划序追加兜底路。
 * 亏空 = (已投总件数 + 1) × 份额 − 该路已投件数；份额和为 1 保证至少一条亏空为正。
 */
export function selectSplitRouteOrder(plan: SplitRoutePlan, delivered: number[]): number[] {
  const shareCount = plan.shareRoutes.length;
  if (shareCount === 0) return [...plan.fallbackRoutes];
  if (shareCount === 1) return [plan.shareRoutes[0]!, ...plan.fallbackRoutes];
  let shareDelivered = 0;
  for (const routeIndex of plan.shareRoutes) shareDelivered += delivered[routeIndex]!;
  const order = plan.shareRoutes
    .map((routeIndex) => ({
      routeIndex,
      deficit: (shareDelivered + 1) * plan.shares[routeIndex]! - delivered[routeIndex]!,
    }))
    .sort((left, right) => right.deficit - left.deficit || left.routeIndex - right.routeIndex)
    .map((entry) => entry.routeIndex);
  order.push(...plan.fallbackRoutes);
  return order;
}
