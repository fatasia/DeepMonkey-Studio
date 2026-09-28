import { compareText } from "@bim-studio/contracts";
import type { PprOperation, PprPrecedenceRelation } from "@bim-studio/contracts";

/**
 * 线平衡求解(位置权重 RPW 启发式,确定性):给定工序、前置关系、目标节拍与工位池,
 * 生成满足前置关系与节拍上限的工位分配建议。
 * 这是"评估"(calculateLineBalance)之外的"求解"半环:求解结果可直接交给评估对比效率。
 * 教科书确定性算法,不用随机/优化器;无可行解时如实报告残余工序,不猜测。
 */

export interface LineBalanceSolverInput {
  readonly operations: readonly Pick<PprOperation, "id" | "standardTimeMinutes">[];
  readonly precedenceRelations: readonly Pick<PprPrecedenceRelation, "predecessorOperationId" | "successorOperationId">[];
  /** 目标节拍,分钟;必须为正。 */
  readonly targetTaktMinutes: number;
  /** 工位池;省略时按理论最少工位数生成连续编号 Station-1..N。 */
  readonly stationIds?: readonly string[];
}

export interface LineBalanceAssignment {
  readonly stationId: string;
  readonly operationId: string;
  readonly position: number;
}

export interface LineBalanceSolution {
  readonly assignments: readonly LineBalanceAssignment[];
  readonly stationsUsed: number;
  readonly cycleMinutes: number;
  /** 无法放入任何工位的工序(单工序超节拍或前置不可满足);建议列表不含它们。 */
  readonly unscheduledOperationIds: readonly string[];
}

/** 前置关系图 + 每工序"自身+全部下游"总工时(位置权重);返回拓扑序或环错误。 */
export function rankPositionalWeights(
  operations: readonly Pick<PprOperation, "id" | "standardTimeMinutes">[],
  precedenceRelations: readonly Pick<PprPrecedenceRelation, "predecessorOperationId" | "successorOperationId">[],
): { weights: Map<string, number>; successors: Map<string, string[]>; order: string[] } {
  const times = new Map(operations.map((operation) => [operation.id, operation.standardTimeMinutes]));
  const successors = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const operation of operations) {
    indegree.set(operation.id, 0);
  }
  for (const relation of precedenceRelations) {
    if (!times.has(relation.predecessorOperationId) || !times.has(relation.successorOperationId)) continue;
    const list = successors.get(relation.predecessorOperationId) ?? [];
    list.push(relation.successorOperationId);
    successors.set(relation.predecessorOperationId, list);
    indegree.set(relation.successorOperationId, (indegree.get(relation.successorOperationId) ?? 0) + 1);
  }
  // Kahn 拓扑序,id 字典序破平,保证同输入同输出。
  const order: string[] = [];
  const ready = operations.map((operation) => operation.id)
    .filter((id) => indegree.get(id) === 0)
    .sort((left, right) => compareText(left, right));
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of successors.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        const position = ready.findIndex((candidate) => candidate > next);
        if (position < 0) ready.push(next);
        else ready.splice(position, 0, next);
      }
    }
  }
  if (order.length !== operations.length) {
    throw new Error("前置关系存在环,无法求解线平衡");
  }
  const weights = new Map<string, number>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order[index]!;
    let downstream = 0;
    for (const next of successors.get(id) ?? []) downstream += weights.get(next) ?? 0;
    weights.set(id, (times.get(id) ?? 0) + downstream);
  }
  return { weights, successors, order };
}

/** RPW 求解:每工位按权重降序选可调度工序(全部前驱已排),装入不超过节拍;溢出换下一工位。 */
export function solveLineBalance(input: LineBalanceSolverInput): LineBalanceSolution {
  const takt = input.targetTaktMinutes;
  if (!Number.isFinite(takt) || takt <= 0) throw new Error("目标节拍必须为正数");
  const times = new Map(input.operations.map((operation) => [operation.id, operation.standardTimeMinutes]));
  for (const time of times.values()) {
    if (!Number.isFinite(time) || time < 0) throw new Error("工序标准工时必须为非负有限数");
  }
  const { weights, successors, order } = rankPositionalWeights(input.operations, input.precedenceRelations);
  const scheduled = new Set<string>();
  const assignments: LineBalanceAssignment[] = [];
  const unscheduled: string[] = [];
  const stationIds = input.stationIds;
  const overflow = (time: number): boolean => time > takt;
  let stationIndex = 0;
  let cycle = 0;
  while (scheduled.size + unscheduled.length < input.operations.length) {
    const stationId = stationIds ? stationIds[stationIndex] : `Station-${stationIndex + 1}`;
    if (stationId === undefined) {
      for (const id of order) if (!scheduled.has(id) && !unscheduled.includes(id)) unscheduled.push(id);
      break;
    }
    let remaining = takt;
    let position = 0;
    let progress = true;
    while (progress) {
      progress = false;
      const candidates = order
        .filter((id) => !scheduled.has(id) && !unscheduled.includes(id))
        .filter((id) => (successors.get(id) ?? []).every((next) => true)) // 前驱检查见下
        .filter((id) => predecessorsScheduled(id, order, successors, scheduled, input.precedenceRelations))
        .filter((id) => (times.get(id) ?? 0) <= remaining)
        .sort((left, right) => (weights.get(right) ?? 0) - (weights.get(left) ?? 0) || compareText(left, right));
      const chosen = candidates[0];
      if (chosen !== undefined) {
        const time = times.get(chosen)!;
        assignments.push({ stationId, operationId: chosen, position: position++ });
        scheduled.add(chosen);
        remaining -= time;
        progress = true;
      }
    }
    const used = takt - remaining;
    if (used > 0) cycle = Math.max(cycle, used);
    // 剩余工序中单工序超节拍的进 unscheduled,其余留给下一工位。
    for (const id of order) {
      if (!scheduled.has(id) && !unscheduled.includes(id) && overflow(times.get(id) ?? 0)) unscheduled.push(id);
    }
    stationIndex += 1;
    if (stationIndex > input.operations.length + 1) {
      for (const id of order) if (!scheduled.has(id) && !unscheduled.includes(id)) unscheduled.push(id);
      break;
    }
  }
  return { assignments, stationsUsed: stationIndex, cycleMinutes: cycle, unscheduledOperationIds: unscheduled };
}

function predecessorsScheduled(
  id: string,
  order: readonly string[],
  successors: Map<string, string[]>,
  scheduled: Set<string>,
  relations: readonly Pick<PprPrecedenceRelation, "predecessorOperationId" | "successorOperationId">[],
): boolean {
  for (const relation of relations) {
    if (relation.successorOperationId === id && !scheduled.has(relation.predecessorOperationId)) return false;
  }
  return true;
}
