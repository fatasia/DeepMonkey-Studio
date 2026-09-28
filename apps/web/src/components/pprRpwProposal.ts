import type { PprBopVersionDraft } from "@bim-studio/contracts";
import { solveLineBalance, type LineBalanceSolution } from "@bim-studio/ppr-lite-engine";

export type PprRpwProposal =
  | { status: "blocked"; reason: string }
  | { status: "ready"; solution: LineBalanceSolution; assignments: PprBopVersionDraft["resourceAssignments"] };

/** RPW is a station-allocation suggestion, not a DES prediction or a replacement for other resource assignments. */
export function proposePprRpw(draft: PprBopVersionDraft): PprRpwProposal {
  const takt = draft.targetTaktMinutes;
  if (!Number.isFinite(takt) || takt === undefined || takt <= 0) return { status: "blocked", reason: "请先填写正数目标节拍。" };
  if (!draft.operations.length) return { status: "blocked", reason: "请先添加工序。" };
  if (draft.condition || draft.variantIds?.length || draft.operations.some((item) => item.condition || item.variantIds?.length)
    || draft.precedenceRelations.some((item) => item.condition || (item.minimumLagMinutes ?? 0) > 0)) {
    return { status: "blocked", reason: "条件、变体或前置等待无法映射到 RPW 排序，请先为目标工况单独建立无条件版本。" };
  }
  if (draft.operations.some((item) => !Number.isFinite(item.standardTimeMinutes) || item.standardTimeMinutes <= 0)) {
    return { status: "blocked", reason: "工序标准工时必须为正数。" };
  }
  const stations = draft.resources.filter((resource) => resource.kind === "station");
  if (!stations.length) return { status: "blocked", reason: "请先在资源配置中添加工位。" };
  if (stations.some((station) => station.capacity !== undefined && station.capacity !== 1)) {
    return { status: "blocked", reason: "多并行单元工位不能按单工位 RPW 直接映射，请先人工核对资源模型。" };
  }
  const stationIds = new Set(stations.map((station) => station.id));
  if (draft.resourceAssignments.some((item) => stationIds.has(item.resourceId) && (item.requiredCapacity ?? 1) !== 1)) {
    return { status: "blocked", reason: "工位占用能力不为 1，不能应用单工位 RPW 建议。" };
  }
  try {
    const solution = solveLineBalance({ operations: draft.operations, precedenceRelations: draft.precedenceRelations, targetTaktMinutes: takt, stationIds: stations.map((station) => station.id) });
    if (solution.unscheduledOperationIds.length || solution.assignments.length !== draft.operations.length) {
      return { status: "blocked", reason: `工位不足或工序超节拍；${solution.unscheduledOperationIds.length} 道工序未排入，建议不能写入草稿。` };
    }
    const retained = draft.resourceAssignments.filter((item) => !stationIds.has(item.resourceId));
    const existingIds = new Set(retained.map((item) => item.id));
    const assignments = solution.assignments.map(({ operationId, stationId }) => {
      let id = `rpw-${operationId}`;
      for (let index = 1; existingIds.has(id); index += 1) id = `rpw-${operationId}-${index}`;
      existingIds.add(id);
      return { id, operationId, resourceId: stationId, requiredCapacity: 1 };
    });
    return { status: "ready", solution, assignments: [...retained, ...assignments] };
  } catch (error) {
    return { status: "blocked", reason: error instanceof Error ? error.message : "RPW 求解失败，请检查工序关系。" };
  }
}
