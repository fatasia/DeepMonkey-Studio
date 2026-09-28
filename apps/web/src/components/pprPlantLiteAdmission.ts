import type { PprBopVersionDraft } from "@bim-studio/contracts";
import type { PlantLiteEdge, PlantLiteSplitRoute } from "@bim-studio/contracts";

export type PprPlantLiteReviewCode =
  | "conditional-resource"
  | "conditional-scope"
  | "disconnected-flow"
  | "minimum-lag"
  | "multiple-predecessors"
  | "multiple-resources"
  | "multiple-successors"
  | "name-shortened"
  | "resource-capacity"
  | "resource-limit"
  | "resource-unassigned"
  | "unsupported-resource";

export interface PprPlantLiteMappingItem {
  code: PprPlantLiteReviewCode;
  message: string;
  sourceIds: string[];
}

/**
 * 语义准入表逐行结论（对应《总体方案》N8 表）：
 * direct = 等价映射，可进入正式预测；
 * mapped-review = 映射已建立但关键参数是占位，需人工确认后才能正式预测；
 * blocked = 无等价表达，阻断正式预测并给出人工重建指引。
 */
export type PprPlantLiteAdmissionVerdict = "direct" | "mapped-review" | "blocked";

export type PprPlantLiteAdmissionSemantics =
  | "sequential-flow"
  | "branch-split"
  | "joint-equipment-worker"
  | "and-join-convergence"
  | "multi-resource-atomic-lock"
  | "minimum-lag";

export interface PprPlantLiteAdmissionEntry {
  semantics: PprPlantLiteAdmissionSemantics;
  verdict: PprPlantLiteAdmissionVerdict;
  sourceIds: string[];
  reason: string;
}

export interface PprFlowSplitPlan {
  id: string;
  name: string;
  routes: PlantLiteSplitRoute[];
}

export interface PprFlowTopologyPlan {
  edges: PlantLiteEdge[];
  splits: PprFlowSplitPlan[];
  admission: PprPlantLiteAdmissionEntry[];
  flowReviewItems: PprPlantLiteMappingItem[];
}

/** source 与 sink 是草稿图的固定端点；station 节点 ID 由调用方按拓扑序分配。 */
const SOURCE_NODE_ID = "source";
const SINK_NODE_ID = "sink";

/**
 * N8 语义准入表的流拓扑半区：按前置关系逐条判定顺序直连、分流映射与阻断级语义，
 * 并产出可运行审阅图的连边计划。
 *
 * 阻断级语义（AND 汇合、最小滞后）的关系边仍会连接，保证草稿能作为可运行审阅底稿打开；
 * 但 admission 结论与复核项明示语义丢失并配合 -review-only 模型 ID 阻断正式预测，
 * 不做静默线性化。条件关系按 conditional-scope 复核口径进入草稿，不在本表自动执行。
 */
export function planPprFlowTopology(draft: PprBopVersionDraft, stationIdByOperation: Map<string, string>): PprFlowTopologyPlan {
  const operationIds = new Set(stationIdByOperation.keys());
  const relations = draft.precedenceRelations.filter((relation) =>
    operationIds.has(relation.predecessorOperationId) && operationIds.has(relation.successorOperationId));
  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  relations.forEach((relation) => {
    predecessors.set(relation.successorOperationId, [...(predecessors.get(relation.successorOperationId) ?? []), relation.predecessorOperationId]);
    successors.set(relation.predecessorOperationId, [...(successors.get(relation.predecessorOperationId) ?? []), relation.successorOperationId]);
  });

  const admission: PprPlantLiteAdmissionEntry[] = [];
  const flowReviewItems: PprPlantLiteMappingItem[] = [];

  relations.forEach((relation) => {
    if ((relation.minimumLagMinutes ?? 0) <= 0) return;
    const sourceIds = [relation.id];
    admission.push({
      semantics: "minimum-lag",
      verdict: "blocked",
      sourceIds,
      reason: `前置关系要求 ${formatNumber(relation.minimumLagMinutes!)} 分钟最小滞后；流程仿真无滞后约束表达，等待时间、日历与生效范围不是同一种约束。`,
    });
    flowReviewItems.push({
      code: "minimum-lag",
      sourceIds,
      message: `前置关系的 ${formatNumber(relation.minimumLagMinutes!)} 分钟最小滞后无法在流程仿真中等价表达，禁止折入加工时间偷换语义。正式预测已被阻断；请按业务依据人工重建滞后（如改设缓冲或调整工时）并另存独立模型。`,
    });
  });

  const operations = [...stationIdByOperation.keys()];
  operations.forEach((operationId) => {
    const operation = draft.operations.find((item) => item.id === operationId);
    if (!operation) return;
    const prior = predecessors.get(operationId) ?? [];
    const next = successors.get(operationId) ?? [];
    if (prior.length > 1) {
      const sourceIds = [operationId, ...prior];
      admission.push({
        semantics: "and-join-convergence",
        verdict: "blocked",
        sourceIds,
        reason: `${prior.length} 个前置工序构成 AND 汇合；流程仿真每件产品只沿一条路径流动，无法由多入边推断齐套等待成立。`,
      });
      flowReviewItems.push({
        code: "multiple-predecessors",
        sourceIds,
        message: `${operation.name} 有 ${prior.length} 个前置工序，属 AND 汇合/装配齐套语义；当前图按单一路径连接，不代表齐套等待。正式预测已被阻断；请人工拆分或重建汇合逻辑并另存独立模型。`,
      });
    }
    if (next.length > 1) {
      const sourceIds = [operationId, ...next];
      admission.push({
        semantics: "branch-split",
        verdict: "mapped-review",
        sourceIds,
        reason: `${next.length} 个并行后续已映射为均分占位路由；BOP 前置关系不含路由份额，若原工艺是每件执行全部分支则不等价。`,
      });
      flowReviewItems.push({
        code: "multiple-successors",
        sourceIds,
        message: `${operation.name} 有 ${next.length} 个并行后续，已映射为分流节点（均分占位份额各 1/${next.length}，即 ${formatNumber(1 / next.length)}）；BOP 不含路由份额，若原工艺是每件都执行全部分支则此映射不等价。请人工校正份额或重组流程。`,
      });
    }
  });

  const roots = operations.filter((operationId) => !predecessors.get(operationId)?.length);
  if (operations.length > 1 && roots.length > 1) {
    flowReviewItems.push({
      code: "disconnected-flow",
      sourceIds: operations,
      message: `PPR 有 ${roots.length} 个起点；草稿按共享来料源分配建模，不代表原流程边界。请按真实产线入口人工重组。`,
    });
  }

  const { edges, splits } = buildTopologyEdges(operations, roots, successors, stationIdByOperation, draft);

  if (!admission.length) {
    admission.push({
      semantics: "sequential-flow",
      verdict: "direct",
      sourceIds: operations,
      reason: "全部工序单前置单后继，按顺序直连映射；加工时间与顺序沿用 PPR 标准工时和前置网络。",
    });
  }
  return { edges, splits, admission, flowReviewItems };
}

function buildTopologyEdges(
  operations: string[],
  roots: string[],
  successors: Map<string, string[]>,
  stationIdByOperation: Map<string, string>,
  draft: PprBopVersionDraft,
): { edges: PlantLiteEdge[]; splits: PprFlowSplitPlan[] } {
  const edges: PlantLiteEdge[] = [];
  const splits: PprFlowSplitPlan[] = [];
  let edgeIndex = 0;
  const addEdge = (from: string, to: string): void => {
    edgeIndex += 1;
    edges.push({ id: `edge-${edgeIndex}`, from, to });
  };
  roots.forEach((rootId) => addEdge(SOURCE_NODE_ID, stationIdByOperation.get(rootId)!));
  operations.forEach((operationId) => {
    const fromStation = stationIdByOperation.get(operationId)!;
    const next = successors.get(operationId) ?? [];
    if (!next.length) {
      addEdge(fromStation, SINK_NODE_ID);
      return;
    }
    if (next.length === 1) {
      addEdge(fromStation, stationIdByOperation.get(next[0]!)!);
      return;
    }
    const splitId = `split-${splits.length + 1}`;
    const operation = draft.operations.find((item) => item.id === operationId);
    splits.push({
      id: splitId,
      name: boundedLabel(`${operation?.name ?? operationId} 分流`, 120),
      routes: next.map((successorId) => ({ to: stationIdByOperation.get(successorId)!, share: 1 / next.length })),
    });
    addEdge(fromStation, splitId);
  });
  return { edges, splits };
}

export function boundedLabel(value: string, maximum: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maximum ? trimmed : trimmed.slice(0, maximum);
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
