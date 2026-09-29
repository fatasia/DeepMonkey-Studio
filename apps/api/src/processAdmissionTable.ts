import type {
  ProcessAdmissionCounts,
  ProcessAdmissionEntry,
  ProcessAdmissionPlan,
  ProcessAdmissionReasonCode,
  ProcessAdmissionReport,
} from "@bim-studio/contracts";
import type { PprOperationResourceAssignment, PprResource } from "@bim-studio/contracts";

/**
 * 非线性工艺映射准入表（C2，服务端机器可读版）。
 *
 * 对 BOP 的四类非线性结构逐项映射或显式拒绝，不做静默线性化：
 * - 分流（≥2 后继）→ mapped-review：分流占位映射（BOP 无路由份额）；
 * - AND 汇合（≥2 不同前置）→ blocked：流程仿真单路径流动，无等价表达，阻断正式预测；
 * - 联合占用（白名单内：1 台 equipment/robot + 1 名 person 各占 1 单位）→ direct；
 *   白名单外（多设备/工具类/占用超 1 单位/资源未登记）→ blocked；
 * - 最小滞后（minimumLagMinutes > 0）→ blocked：禁止折入加工时间偷换语义。
 *
 * `assertFormalPredictionAdmissible` 是结构级 fail-closed 门：阻断与模型命名无关，
 * 去掉 -review-only 后缀也不能绕过（现有 plantLiteStudy 的后缀门禁之外的第二道结构门）。
 */

export class ProcessAdmissionBlockedError extends Error {
  readonly reasonCodes: ProcessAdmissionReasonCode[];
  readonly report: ProcessAdmissionReport;

  constructor(report: ProcessAdmissionReport) {
    super(
      `非线性工艺准入阻断（${report.blockingReasonCodes.join(", ")}）：存在无等价表达或占位映射的结构，` +
        "禁止正式预测；请按各项准入结论人工重建并另存独立模型后再运行。",
    );
    this.name = "ProcessAdmissionBlockedError";
    this.reasonCodes = [...report.blockingReasonCodes];
    this.report = report;
  }
}

/** 逐项评估 BOP 的非线性结构并产出机器可读准入报告；纯函数，无时钟与随机。 */
export function evaluateProcessAdmission(plan: ProcessAdmissionPlan): ProcessAdmissionReport {
  const operationIds = new Set(plan.operations.map((operation) => operation.id));
  const relations = plan.precedenceRelations.filter(
    (relation) => operationIds.has(relation.predecessorOperationId) && operationIds.has(relation.successorOperationId),
  );

  const entries: ProcessAdmissionEntry[] = [];

  // 滞后行：逐条前置关系独立判定（>0 才算；0/缺省即无滞后语义）。
  for (const relation of relations) {
    const lag = relation.minimumLagMinutes;
    if (lag === undefined || lag <= 0) continue;
    entries.push({
      structure: "minimum-lag",
      verdict: "blocked",
      reasonCode: "minimum-lag",
      subjectIds: [relation.id],
      message:
        `前置关系要求 ${formatNumber(lag)} 分钟最小滞后；流程仿真以加工时间表达占用，等待时间、日历与生效范围不是同一种约束。` +
        "禁止折入加工时间偷换语义：正式预测已阻断，请按业务依据人工重建滞后（如改设缓冲或调整工时）并另存独立模型。",
    });
  }

  // 分流 / AND 汇合行：按「不同前置/后继工序」计数，重复关系边不放大结构判定。
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  for (const relation of relations) {
    pushDistinct(successors, relation.predecessorOperationId, relation.successorOperationId);
    pushDistinct(predecessors, relation.successorOperationId, relation.predecessorOperationId);
  }
  for (const operation of plan.operations) {
    const prior = predecessors.get(operation.id);
    if (prior && prior.length > 1) {
      entries.push({
        structure: "and-join-convergence",
        verdict: "blocked",
        reasonCode: "multiple-predecessors",
        subjectIds: [operation.id, ...prior],
        message:
          `${operation.name} 有 ${prior.length} 个不同前置工序，构成 AND 汇合/装配齐套；` +
          "流程仿真每件产品只沿单一路径流动，无法由多入边机判齐套等待成立，无等价表达。" +
          "正式预测已阻断：请人工拆分或重建汇合逻辑并另存独立模型。",
      });
    }
    const next = successors.get(operation.id);
    if (next && next.length > 1) {
      entries.push({
        structure: "branch-split",
        verdict: "mapped-review",
        reasonCode: "multiple-successors",
        subjectIds: [operation.id, ...next],
        message:
          `${operation.name} 有 ${next.length} 个并行后续，已映射为分流占位路由（均分份额各 ${formatNumber(1 / next.length)}）；` +
          "BOP 前置关系不含路由份额，若原工艺是每件执行全部分支则此映射不等价。" +
          "请人工校正份额后另存独立模型方可正式预测。",
      });
    }
  }

  // 联合占用行：按工序聚合资源分配，白名单内 direct、白名单外 blocked。
  const assignmentsByOperation = new Map<string, PprOperationResourceAssignment[]>();
  for (const assignment of plan.resourceAssignments) {
    if (!operationIds.has(assignment.operationId)) continue;
    const bucket = assignmentsByOperation.get(assignment.operationId) ?? [];
    if (!bucket.some((item) => item.resourceId === assignment.resourceId)) bucket.push(assignment);
    assignmentsByOperation.set(assignment.operationId, bucket);
  }
  const resourceById = new Map(plan.resources.map((resource) => [resource.id, resource]));
  for (const operation of plan.operations) {
    const assignments = assignmentsByOperation.get(operation.id);
    if (!assignments || assignments.length < 2) continue;
    const subjectIds = [operation.id, ...assignments.map((assignment) => assignment.id)];
    const violation = jointOccupancyViolation(assignments, resourceById);
    if (violation === undefined) {
      entries.push({
        structure: "joint-equipment-worker",
        verdict: "direct",
        reasonCode: "joint-occupancy-whitelist",
        subjectIds,
        message:
          `${operation.name} 恰为 1 台设备/机器人 + 1 名人员且各占 1 单位，属联合占用白名单，` +
          "可等价映射为设备资源与人工资源联合占用（必须同时有可用容量才可派工）。",
      });
    } else {
      entries.push({
        structure: "multi-resource-atomic-lock",
        verdict: "blocked",
        reasonCode: "multiple-resources",
        subjectIds,
        message:
          `${operation.name} 的资源占用不在联合占用白名单：${violation}。` +
          "白名单外多资源原子锁在流程仿真无等价表达，正式预测已阻断：请分解工序或重建资源绑定。",
      });
    }
  }

  if (!entries.length) {
    entries.push({
      structure: "sequential-flow",
      verdict: "direct",
      reasonCode: "sequential-direct",
      subjectIds: plan.operations.map((operation) => operation.id),
      message: "全部工序单前置单后继、单一资源占用，按顺序直连映射；工时与顺序沿用 BOP 标准工时与前置网络。",
    });
  }

  const counts: ProcessAdmissionCounts = {
    total: entries.length,
    direct: entries.filter((entry) => entry.verdict === "direct").length,
    mappedReview: entries.filter((entry) => entry.verdict === "mapped-review").length,
    blocked: entries.filter((entry) => entry.verdict === "blocked").length,
  };
  const blockingReasonCodes: ProcessAdmissionReasonCode[] = [];
  for (const entry of entries) {
    if (entry.verdict !== "direct" && !blockingReasonCodes.includes(entry.reasonCode)) {
      blockingReasonCodes.push(entry.reasonCode);
    }
  }
  return {
    planId: plan.planId,
    versionId: plan.versionId,
    entries,
    counts,
    formalPredictionAllowed: blockingReasonCodes.length === 0,
    blockingReasonCodes,
  };
}

/**
 * 结构级 fail-closed 正式预测门：接受准入报告或直接接受 BOP 投影评估。
 * 允许时原样返回报告；阻断时抛 ProcessAdmissionBlockedError（携带全部理由码）。
 */
export function assertFormalPredictionAdmissible(input: ProcessAdmissionReport | ProcessAdmissionPlan): ProcessAdmissionReport {
  const report = "entries" in input ? input : evaluateProcessAdmission(input);
  if (report.formalPredictionAllowed) return report;
  throw new ProcessAdmissionBlockedError(report);
}

/** 白名单：恰 2 项资源——1 台 equipment/robot + 1 名 person，各占 1 单位。返回违规描述或 undefined。 */
function jointOccupancyViolation(
  assignments: PprOperationResourceAssignment[],
  resourceById: Map<string, PprResource>,
): string | undefined {
  if (assignments.length !== 2) return `${assignments.length} 项资源同时占用（白名单仅 1+1）`;
  const first = resourceById.get(assignments[0]!.resourceId);
  const second = resourceById.get(assignments[1]!.resourceId);
  if (!first || !second) {
    const missing = assignments.find((assignment) => !resourceById.has(assignment.resourceId))!;
    return `资源 ${missing.resourceId} 未在 BOP 资源清单登记，不能机判等价`;
  }
  const kinds = [first.kind, second.kind];
  const equipmentIndex = kinds.findIndex((kind) => kind === "equipment" || kind === "robot");
  const personIndex = kinds.indexOf("person");
  if (equipmentIndex === -1 || personIndex === -1 || equipmentIndex === personIndex) {
    return `资源类别组合为 ${kinds.join("+")}（白名单仅 设备/机器人 + 人员）`;
  }
  const equipment = [first, second][equipmentIndex]!;
  const person = [first, second][personIndex]!;
  const equipmentUnits = assignments[equipmentIndex]!.requiredCapacity ?? 1;
  const personUnits = assignments[personIndex]!.requiredCapacity ?? 1;
  if (equipmentUnits !== 1) return `设备 ${equipment.name} 占用 ${equipmentUnits} 单位（白名单要求各占 1 单位）`;
  if (personUnits !== 1) return `人员 ${person.name} 占用 ${personUnits} 单位（白名单要求各占 1 单位）`;
  return undefined;
}

function pushDistinct(map: Map<string, string[]>, key: string, value: string): void {
  const bucket = map.get(key);
  if (!bucket) {
    map.set(key, [value]);
    return;
  }
  if (!bucket.includes(value)) bucket.push(value);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
