import { createHash } from "node:crypto";
import type {
  Vector3Value,
  WorkcellAuditFinding,
  WorkcellAuditInput,
  WorkcellAuditObject,
  WorkcellAuditResult,
  WorkcellCollisionPair,
  WorkcellObjectRole,
  WorkcellReachabilityResult,
} from "@bim-studio/contracts";
import { analyzeWorkcellTrajectories } from "./trajectoryEngine.js";

const ROLES: WorkcellObjectRole[] = ["robot", "tool", "target", "equipment", "obstacle", "unknown"];

/**
 * 只计算输入可以证明的 AABB、关节链包络和绑定问题。
 * 网格碰撞、完整路径规划和控制器可执行性不在该轻量内核的结论范围内。
 */
export function auditWorkcell(input: WorkcellAuditInput): WorkcellAuditResult {
  const objects = uniqueObjects(input.objects);
  const byId = new Map(objects.map((item) => [item.id, item]));
  const findings: WorkcellAuditFinding[] = [];
  const clearanceThreshold = finiteRange(input.clearanceThreshold ?? 0.25, 0, 100);
  const incompleteObjectIds = objects.filter((item) => !validBounds(item)).map((item) => item.id);
  if (incompleteObjectIds.length) {
    findings.push(
      finding(
        "bounds-missing",
        "data",
        "info",
        "部分对象缺少碰撞包围盒",
        `${incompleteObjectIds.length} 个对象只参与清单检查，不输出碰撞或间隙结论。`,
        incompleteObjectIds,
        "加载模型后重新执行工位体检",
      ),
    );
  }

  const collisionPairs = buildCollisionPairs(objects, clearanceThreshold, findings);
  const reachability = buildReachability(objects, byId, findings);
  inspectToolBindings(objects, byId, findings);
  const trajectoryAudit = analyzeWorkcellTrajectories({ ...input, objects });
  if (trajectoryAudit) findings.push(...trajectoryAudit.findings);

  const evaluatedObjects = objects.length - incompleteObjectIds.length;
  const robots = objects.filter((item) => item.role === "robot");
  const configuredRobots = robots.filter((item) => item.robot?.links.length);
  const geometryCoverage = objects.length ? evaluatedObjects / objects.length : 0;
  const robotCoverage = robots.length ? configuredRobots.length / robots.length : 1;
  const trajectoryCoverage = trajectoryEvidenceCoverage(input, trajectoryAudit?.analysis);
  const evidenceCoverage = clamp(
    trajectoryAudit
      ? geometryCoverage * 0.5 + robotCoverage * 0.25 + trajectoryCoverage * 0.25
      : geometryCoverage * 0.7 + robotCoverage * 0.3,
    0,
    1,
  );
  const status = resultStatus(findings, collisionPairs, evidenceCoverage);
  const resultBase = {
    generatedBy: "workcell-validation-plugin" as const,
    status,
    sceneId: input.sceneId,
    summary: summary(status, findings, collisionPairs, reachability, trajectoryAudit?.analysis),
    inventory: inventory(objects),
    findings,
    collisionPairs,
    reachability,
    ...(trajectoryAudit ? { trajectoryAnalysis: trajectoryAudit.analysis } : {}),
    incompleteObjectIds,
    evidenceCoverage,
    validationDraft: {
      objective: "验证当前工位的空间冲突、最小间隙、机器人可达性与工具绑定",
      acceptanceCriteria: [
        "不存在确定的 AABB 空间冲突",
        `必要对象间隙不小于 ${clearanceThreshold.toFixed(2)} m`,
        "机器人目标位于已配置关节链的可达包络内",
        "所有工具与目标绑定完整",
        ...(trajectoryAudit ? [
          "分段线性 TCP 包围球的连续 AABB 广相位不存在潜在冲突",
          "所有已声明轨迹关节角与速度位于约束内",
          "多机器人轨迹在重叠时间段内满足声明间隙",
        ] : []),
      ],
      objectIds: unique(findings.flatMap((item) => item.objectIds)),
    },
  };
  return { ...resultBase, evidenceFingerprint: fingerprint(resultBase) };
}

function buildCollisionPairs(objects: WorkcellAuditObject[], clearanceThreshold: number, findings: WorkcellAuditFinding[]): WorkcellCollisionPair[] {
  const pairs: WorkcellCollisionPair[] = [];
  for (let leftIndex = 0; leftIndex < objects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < objects.length; rightIndex += 1) {
      const left = objects[leftIndex]!;
      const right = objects[rightIndex]!;
      if (!validBounds(left) || !validBounds(right) || shouldIgnorePair(left, right)) continue;
      const distance = boundsDistance(left.bounds!, right.bounds!);
      const intersects = distance <= 1e-6;
      const required = requiredCollisionPair(left.role, right.role);
      if (!required && !intersects) continue;
      pairs.push({ objectIds: [left.id, right.id], distance, intersects, required });
      if (intersects)
        findings.push(
          finding(
            `collision-${left.id}-${right.id}`,
            "collision",
            "error",
            "检测到空间冲突",
            `${left.name} 与 ${right.name} 的世界包围盒相交。`,
            [left.id, right.id],
            "在三维中定位并确认真实网格干涉",
          ),
        );
      else if (required && distance < clearanceThreshold)
        findings.push(
          finding(
            `clearance-${left.id}-${right.id}`,
            "clearance",
            "warning",
            "必要对象间隙不足",
            `${left.name} 与 ${right.name} 间隙 ${distance.toFixed(3)} m，低于 ${clearanceThreshold.toFixed(3)} m。`,
            [left.id, right.id],
            "调整布局或补充更精确的网格间隙校验",
          ),
        );
      if (pairs.length >= 1_000) return pairs;
    }
  }
  return pairs;
}

function buildReachability(objects: WorkcellAuditObject[], byId: Map<string, WorkcellAuditObject>, findings: WorkcellAuditFinding[]): WorkcellReachabilityResult[] {
  const targets = objects.filter((item) => item.role === "target");
  const results: WorkcellReachabilityResult[] = [];
  for (const robot of objects.filter((item) => item.role === "robot")) {
    const chain = robot.robot;
    if (!chain?.links.length) {
      findings.push(
        finding(
          `robot-chain-${robot.id}`,
          "data",
          "info",
          "机器人尚未配置关节链",
          `${robot.name} 只参与空间检查，暂不输出可达性结论。`,
          [robot.id],
          "在模型骨骼与 IK 中配置品牌无关的关节长度和限位",
        ),
      );
      continue;
    }
    const invalidLimits = chain.links.filter((link) => link.minAngleDeg >= link.maxAngleDeg);
    if (invalidLimits.length)
      findings.push(
        finding(`robot-limits-${robot.id}`, "data", "error", "机器人关节限位无效", invalidLimits.map((item) => item.name).join("、"), [robot.id], "修正关节最小角度与最大角度"),
      );
    const selectedTargets = chain.targetObjectIds?.length ? chain.targetObjectIds.map((id) => byId.get(id)).filter(isObject) : targets;
    if (!selectedTargets.length) {
      findings.push(
        finding(`robot-target-${robot.id}`, "binding", "info", "机器人没有验证目标点", `${robot.name} 已有链参数，但场景中没有目标对象。`, [robot.id], "创建目标点并绑定到机器人"),
      );
      continue;
    }
    const lengths = chain.links.map((item) => item.length);
    const maximumReach = sum(lengths);
    const longest = Math.max(...lengths);
    const minimumReach = Math.max(0, longest - (maximumReach - longest));
    for (const target of selectedTargets) {
      const distance = vectorDistance(chain.base, target.position);
      const status = distance > maximumReach ? "outside" : distance < minimumReach ? "inner-dead-zone" : "reachable";
      results.push({ robotId: robot.id, targetId: target.id, distance, minimumReach, maximumReach, status });
      if (status !== "reachable")
        findings.push(
          finding(
            `reach-${robot.id}-${target.id}`,
            "reachability",
            status === "outside" ? "error" : "warning",
            status === "outside" ? "目标超出机器人可达包络" : "目标位于机器人内侧盲区",
            `${target.name} 距基座 ${distance.toFixed(3)} m，可达范围 ${minimumReach.toFixed(3)}–${maximumReach.toFixed(3)} m。`,
            [robot.id, target.id],
            "调整目标或机器人位置，并使用 IK 做姿态复核",
          ),
        );
    }
  }
  return results;
}

function inspectToolBindings(objects: WorkcellAuditObject[], byId: Map<string, WorkcellAuditObject>, findings: WorkcellAuditFinding[]): void {
  const boundTools = new Set(objects.flatMap((item) => (item.robot?.toolObjectId ? [item.robot.toolObjectId] : [])));
  for (const robot of objects.filter((item) => item.role === "robot" && item.robot?.toolObjectId)) {
    const toolId = robot.robot!.toolObjectId!;
    if (!byId.has(toolId))
      findings.push(
        finding(`tool-missing-${robot.id}`, "binding", "error", "机器人绑定的工具不存在", `${robot.name} 引用了已删除或未加载的工具 ${toolId}。`, [robot.id], "重新选择末端工具"),
      );
  }
  const unbound = objects.filter((item) => item.role === "tool" && !boundTools.has(item.id));
  if (unbound.length)
    findings.push(
      finding(
        "tool-unbound",
        "binding",
        "warning",
        "存在未绑定工具",
        unbound.map((item) => item.name).join("、"),
        unbound.map((item) => item.id),
        "将工具绑定到对应机器人或改为普通设备",
      ),
    );
}

function resultStatus(findings: WorkcellAuditFinding[], pairs: WorkcellCollisionPair[], coverage: number): WorkcellAuditResult["status"] {
  if (findings.some((item) => item.severity === "error")) return "failed";
  if (findings.some((item) => item.severity === "warning")) return "warning";
  if (coverage < 0.5 && pairs.length === 0) return "needs-data";
  return "passed";
}

function summary(
  status: WorkcellAuditResult["status"],
  findings: WorkcellAuditFinding[],
  pairs: WorkcellCollisionPair[],
  reachability: WorkcellReachabilityResult[],
  trajectory: WorkcellAuditResult["trajectoryAnalysis"],
): string {
  const collisions = pairs.filter((item) => item.intersects).length;
  const unreachable = reachability.filter((item) => item.status !== "reachable").length;
  if (status === "needs-data") return "已完成对象盘点，但几何或机器人参数不足，未输出空间与可达结论。";
  const trajectorySummary = trajectory
    ? `、${trajectory.segmentChecks.length} 段连续广相位、${trajectory.scheduleConflicts.length} 个多机器人时段冲突`
    : "";
  return `完成 ${pairs.length} 组必要空间关系与 ${reachability.length} 个机器人目标检查${trajectorySummary}；发现 ${collisions} 组冲突、${unreachable} 个不可达/盲区目标、${findings.length} 项待处理。`;
}

function trajectoryEvidenceCoverage(
  input: WorkcellAuditInput,
  analysis: WorkcellAuditResult["trajectoryAnalysis"],
): number {
  if (!input.trajectories?.length) return 1;
  if (!analysis) return 0;
  const expectedSegments = input.trajectories.reduce((total, item) => total + Math.max(0, item.waypoints.length - 1), 0);
  const segmentCoverage = expectedSegments ? analysis.segmentChecks.length / expectedSegments : 0;
  const jointCoverage = analysis.jointChecks.length
    ? analysis.jointChecks.filter((item) => item.positionStatus !== "needs-data").length / analysis.jointChecks.length
    : 0;
  const precisionCoverage = analysis.precisionStatus === "declared" ? 1 : analysis.precisionStatus === "partial" ? 0.6 : 0.3;
  return clamp(segmentCoverage * 0.5 + jointCoverage * 0.3 + precisionCoverage * 0.2, 0, 1);
}

function finding(
  id: string,
  category: WorkcellAuditFinding["category"],
  severity: WorkcellAuditFinding["severity"],
  title: string,
  detail: string,
  objectIds: string[],
  nextAction: string,
): WorkcellAuditFinding {
  return { id, category, severity, title, detail, objectIds: unique(objectIds), nextAction };
}

function inventory(objects: WorkcellAuditObject[]): Record<WorkcellObjectRole, number> {
  return Object.fromEntries(ROLES.map((role) => [role, objects.filter((item) => item.role === role).length])) as Record<WorkcellObjectRole, number>;
}

function validBounds(object: WorkcellAuditObject): boolean {
  const bounds = object.bounds;
  return Boolean(bounds && finiteVector(bounds.min) && finiteVector(bounds.max) && bounds.min.x <= bounds.max.x && bounds.min.y <= bounds.max.y && bounds.min.z <= bounds.max.z);
}

function boundsDistance(left: NonNullable<WorkcellAuditObject["bounds"]>, right: NonNullable<WorkcellAuditObject["bounds"]>): number {
  const gap = (leftMin: number, leftMax: number, rightMin: number, rightMax: number) => Math.max(0, rightMin - leftMax, leftMin - rightMax);
  return Math.hypot(
    gap(left.min.x, left.max.x, right.min.x, right.max.x),
    gap(left.min.y, left.max.y, right.min.y, right.max.y),
    gap(left.min.z, left.max.z, right.min.z, right.max.z),
  );
}

function shouldIgnorePair(left: WorkcellAuditObject, right: WorkcellAuditObject): boolean {
  if (left.role === "target" || right.role === "target") return true;
  return left.robot?.toolObjectId === right.id || right.robot?.toolObjectId === left.id;
}

function requiredCollisionPair(left: WorkcellObjectRole, right: WorkcellObjectRole): boolean {
  return left !== "unknown" && right !== "unknown" && (left === "robot" || right === "robot" || left === "tool" || right === "tool" || left === "obstacle" || right === "obstacle");
}

function vectorDistance(left: Vector3Value, right: Vector3Value): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
function finiteVector(value: Vector3Value): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}
function finiteRange(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? clamp(value, minimum, maximum) : minimum;
}
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
function uniqueObjects(values: WorkcellAuditObject[]): WorkcellAuditObject[] {
  return [...new Map(values.map((item) => [item.id, item])).values()].slice(0, 200);
}
function isObject(value: WorkcellAuditObject | undefined): value is WorkcellAuditObject {
  return Boolean(value);
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
