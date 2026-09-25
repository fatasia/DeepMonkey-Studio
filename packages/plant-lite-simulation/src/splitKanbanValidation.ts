/**
 * Split 分流与看板缓冲的模型校验。
 * 份额语义：配置了 share 的路由合计必须精确为 1（不归一），全 0 或部分份额均拒绝；
 * 未配 share 的路由只作 priority 兜底路。routes 即出边，split 不得再声明 edges 出边。
 */

import type { PlantLiteModelIssue, PlantLiteNode } from "./modelTypes.js";

const MAX_SPLIT_ROUTES = 64;

export function validateSplitNodeShape(value: Record<string, unknown>, path: string, issues: PlantLiteModelIssue[]): void {
  const routes = value.routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    issues.push({ path: `${path}.routes`, message: "必须包含至少一条路由" });
    return;
  }
  if (routes.length > MAX_SPLIT_ROUTES) {
    issues.push({ path: `${path}.routes`, message: `路由不能超过 ${MAX_SPLIT_ROUTES} 条` });
  }
  let shareTotal = 0;
  let shareConfigured = false;
  routes.forEach((route, index) => {
    const routePath = `${path}.routes[${index}]`;
    if (!isRecord(route)) return void issues.push({ path: routePath, message: "必须是对象" });
    validateRouteText(route.to, `${routePath}.to`, issues);
    if (route.share !== undefined) {
      if (typeof route.share !== "number" || !Number.isFinite(route.share) || route.share < 0 || route.share > 1) {
        issues.push({ path: `${routePath}.share`, message: "必须是 0 到 1 的有限数" });
      } else {
        shareTotal += route.share;
        shareConfigured = true;
      }
    }
    if (route.priority !== undefined && !Number.isSafeInteger(route.priority)) {
      issues.push({ path: `${routePath}.priority`, message: "必须是整数" });
    }
  });
  if (shareConfigured && Math.abs(shareTotal - 1) > 1e-6) {
    issues.push({
      path: `${path}.routes`,
      message: shareTotal === 0 ? "份额不能全为 0" : "已配份额路由的份额合计必须为 1",
    });
  }
}

/** 节点集合齐备后校验 split 路由引用：目标必须存在且不得指向 source。 */
export function validateSplitReferences(nodes: unknown[], issues: PlantLiteModelIssue[]): void {
  const kinds = new Map<string, string>();
  for (const node of nodes) {
    if (isRecord(node) && typeof node.id === "string") kinds.set(node.id, String(node.kind));
  }
  nodes.forEach((value, index) => {
    if (!isRecord(value) || value.kind !== "split" || !Array.isArray(value.routes)) return;
    value.routes.forEach((route, routeIndex) => {
      const path = `$.nodes[${index}].routes[${routeIndex}].to`;
      if (!isRecord(route) || typeof route.to !== "string" || !route.to.trim()) return;
      if (!kinds.has(route.to)) return void issues.push({ path, message: "未知路由目标" });
      if (kinds.get(route.to) === "source") issues.push({ path, message: "路由目标不得指向 source" });
    });
  });
}

/** split 的流转由 routes 定义；edges 中出现 split 出边属于双重语义，一律拒绝。 */
export function validateSplitEdges(edges: unknown[], nodes: unknown[], issues: PlantLiteModelIssue[]): void {
  const splitIds = new Set(nodes.flatMap((node) => isRecord(node) && node.kind === "split" && typeof node.id === "string" ? [node.id] : []));
  edges.forEach((edge, index) => {
    if (isRecord(edge) && typeof edge.from === "string" && splitIds.has(edge.from)) {
      issues.push({ path: `$.edges[${index}].from`, message: "split 的流转由 routes 定义，不得再配置出边" });
    }
  });
}

/** 把 split 路由并入邻接表，供环检测与 source 可达性分析使用。 */
export function appendSplitAdjacency(nodes: PlantLiteNode[], adjacency: Map<string, string[]>): void {
  for (const node of nodes) {
    if (node.kind !== "split") continue;
    const targets = adjacency.get(node.id) ?? [];
    for (const route of node.routes) targets.push(route.to);
    adjacency.set(node.id, targets);
  }
}

/** 把 split 路由目标并入入边集合，供"非 source 节点必须有入边"判断使用。 */
export function appendSplitIncoming(nodes: PlantLiteNode[], incoming: Set<string>): void {
  for (const node of nodes) {
    if (node.kind !== "split") continue;
    for (const route of node.routes) incoming.add(route.to);
  }
}

/** 看板卡参数：两字段都必须为正整数。 */
export function validateKanbanCard(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) return void issues.push({ path, message: "必须是对象" });
  validatePositiveInteger(value.cardCount, `${path}.cardCount`, issues);
  validatePositiveInteger(value.cardQuantity, `${path}.cardQuantity`, issues);
}

function validateRouteText(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (typeof value !== "string" || !value.trim() || value.length > 120) {
    issues.push({ path, message: "必须是 1 到 120 个字符的文本" });
  }
}

function validatePositiveInteger(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) issues.push({ path, message: "必须是正整数" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
