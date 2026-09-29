import type { OntologyActionRisk, OntologyStatus } from "./ontology.js";

/**
 * H-C4-P1 本体数据图谱契约（ai-ontology-integration-plan-2026-09-29 §4.3/§6.3）。
 *
 * 定位：图谱不是独立知识图谱产品，而是已发布/草稿 OntologyPackage 的**可交互视图投影**：
 * - 节点 = 对象 / 数据来源（dataset 等 sourceBinding）/ 行动 / 事件四类；
 * - 边 = 关系（对象↔对象，带语义标签与方向）+ 绑定边（行动/事件→对象、对象→数据来源）；
 * - 查询 = 以某节点为根的 1—3 跳有限 BFS（禁止大图一次性加载），limit 封顶防失控。
 *
 * 本文件只声明查询与投影形态；BFS 实现在 apps/api/src/ontologyGraph/（服务端同函数可测）。
 * 图谱节点/边全部携带 status/version/evidence 计数——来源和时间可追溯，不是静态示意图。
 */

export type OntologyGraphNodeKind = "object" | "dataset" | "action" | "event";

export const ONTOLOGY_GRAPH_NODE_KINDS: readonly OntologyGraphNodeKind[] = ["object", "dataset", "action", "event"];

export function ontologyGraphNodeLabel(kind: OntologyGraphNodeKind): string {
  return { object: "对象", dataset: "数据", action: "行动", event: "事件" }[kind];
}

/** 节点 id 组装口径（服务端与前端共用，避免 kind 前缀漂移）。 */
export function ontologyGraphNodeId(kind: OntologyGraphNodeKind, key: string): string {
  return `${kind}:${key}`;
}

export function parseOntologyGraphNodeId(id: string): { kind: OntologyGraphNodeKind; key: string } | undefined {
  const index = id.indexOf(":");
  if (index <= 0) return undefined;
  const kind = id.slice(0, index) as OntologyGraphNodeKind;
  if (!ONTOLOGY_GRAPH_NODE_KINDS.includes(kind)) return undefined;
  const key = id.slice(index + 1);
  return key ? { kind, key } : undefined;
}

/** 图节点：本体资产摘要 + 可观测元数据（状态必须带图标/文字，颜色只表达类型）。 */
export interface OntologyGraphNode {
  /** `object:<key>` / `dataset:<sourceId>` / `action:<key>` / `event:<key>`。 */
  id: string;
  kind: OntologyGraphNodeKind;
  /** 对象/行动/事件取资产 key；dataset 取 sourceId。 */
  key: string;
  label: string;
  status: OntologyStatus;
  version: number;
  domain?: string;
  owner?: string;
  /** 行动节点：效果与风险（风险用图标+文字+色三重编码，不靠颜色单独表达）。 */
  effect?: string;
  riskLevel?: OntologyActionRisk;
  approvalRequired?: boolean;
  /** 可观测摘要：属性数 / 来源数 / 证据数。 */
  propertyCount?: number;
  sourceCount?: number;
  evidenceCount?: number;
  /** 对象节点的别名（搜索定位用）。 */
  aliases?: string[];
}

/** 边类型：relation=关系契约；action/event=资产绑定；data=对象来源绑定。 */
export type OntologyGraphEdgeKind = "relation" | "action" | "event" | "data";

export const ONTOLOGY_GRAPH_EDGE_KINDS: readonly OntologyGraphEdgeKind[] = ["relation", "action", "event", "data"];

export interface OntologyGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: OntologyGraphEdgeKind;
  /** 语义标签：relation 取关系 key；其余为 `acts-on` / `triggers-on` / `describes`。 */
  label: string;
  direction: "directed" | "undirected";
  status: OntologyStatus;
  cardinality?: string;
  /** 证据条数（relation.evidence 长度；绑定边取所在资产状态可追溯性=0/1）。 */
  evidenceCount: number;
  /** 关系建立理由/来源说明（检查器展示）。 */
  note?: string;
  /** relation 的 key（relationTypes 过滤口径）；非关系边缺省。 */
  relationKey?: string;
}

/** 图查询（方案 §6.3）：root + 1—3 跳 + 过滤 + limit。 */
export interface OntologyGraphQuery {
  root: { type: OntologyGraphNodeKind; id: string };
  depth: 1 | 2 | 3;
  /** 只遍历指定关系 key 的关系边；缺省全部。只作用于 relation 边。 */
  relationTypes?: string[];
  /** 关系边遍历方向；绑定边（行动/事件/数据）始终双向可达。缺省 both。 */
  direction?: "out" | "in" | "both";
  includeActions?: boolean;
  includeEvents?: boolean;
  includeDatasets?: boolean;
  /** 节点上限；服务端 clamp 到 [1, ONTOLOGY_GRAPH_MAX_LIMIT]。 */
  limit: number;
}

export const ONTOLOGY_GRAPH_MAX_LIMIT = 2000;

export const ONTOLOGY_GRAPH_DEPTHS: readonly (1 | 2 | 3)[] = [1, 2, 3];

export function clampOntologyGraphLimit(value: unknown, fallback = 300): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(numeric, 1), ONTOLOGY_GRAPH_MAX_LIMIT);
}

export type OntologyGraphQueryParseResult =
  | { ok: true; query: OntologyGraphQuery }
  | { ok: false; errors: string[] };

/** 运行时校验（HTTP body 不可信）：非法 depth/type/direction 直接拒绝，limit 走 clamp。 */
export function parseOntologyGraphQuery(input: unknown): OntologyGraphQueryParseResult {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["图查询必须是一个对象"] };
  }
  const candidate = input as Partial<OntologyGraphQuery> & { root?: { type?: unknown; id?: unknown }; depth?: unknown; limit?: unknown };
  const rootType = candidate.root?.type;
  if (!ONTOLOGY_GRAPH_NODE_KINDS.includes(rootType as OntologyGraphNodeKind)) {
    errors.push(`root.type 必须是 ${ONTOLOGY_GRAPH_NODE_KINDS.join("/")}`);
  }
  if (typeof candidate.root?.id !== "string" || !candidate.root.id.trim()) {
    errors.push("root.id 必须是非空字符串");
  }
  if (candidate.depth !== 1 && candidate.depth !== 2 && candidate.depth !== 3) {
    errors.push("depth 必须是 1、2 或 3");
  }
  if (candidate.relationTypes !== undefined && (!Array.isArray(candidate.relationTypes) || candidate.relationTypes.some((item) => typeof item !== "string"))) {
    errors.push("relationTypes 必须是字符串数组");
  }
  if (candidate.direction !== undefined && candidate.direction !== "out" && candidate.direction !== "in" && candidate.direction !== "both") {
    errors.push("direction 必须是 out、in 或 both");
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    query: {
      root: { type: rootType as OntologyGraphNodeKind, id: candidate.root!.id as string },
      depth: candidate.depth as 1 | 2 | 3,
      ...(Array.isArray(candidate.relationTypes) ? { relationTypes: [...(candidate.relationTypes as string[])] } : {}),
      ...(candidate.direction ? { direction: candidate.direction } : {}),
      ...(candidate.includeActions !== undefined ? { includeActions: Boolean(candidate.includeActions) } : {}),
      ...(candidate.includeEvents !== undefined ? { includeEvents: Boolean(candidate.includeEvents) } : {}),
      ...(candidate.includeDatasets !== undefined ? { includeDatasets: Boolean(candidate.includeDatasets) } : {}),
      limit: clampOntologyGraphLimit(candidate.limit),
    },
  };
}

/** 图查询响应：节点/边 + 截断标志 + 观测统计（节点数/关系数/耗时/数据时间可观测）。 */
export interface OntologyGraphResult {
  packageId: string;
  packageStatus: OntologyStatus;
  packageVersion: number;
  /** 包 updatedAt——"数据时间"可观测口径。 */
  packageUpdatedAt: string;
  root: { type: OntologyGraphNodeKind; id: string };
  depth: 1 | 2 | 3;
  nodes: OntologyGraphNode[];
  edges: OntologyGraphEdge[];
  /** limit 截断时为 true：UI 提示缩小深度或加筛选，禁止静默吞节点。 */
  truncated: boolean;
  /** 服务端 BFS 耗时（毫秒）。 */
  elapsedMs: number;
}
