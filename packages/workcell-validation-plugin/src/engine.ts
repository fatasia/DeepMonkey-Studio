import { createHash } from "node:crypto";
import type {
  Vector3Value,
  WorkcellAuditFinding,
  WorkcellAuditInput,
  WorkcellAuditObject,
  WorkcellAuditResult,
  WorkcellCollisionPair,
  WorkcellErgonomicsCheck,
  WorkcellObjectRole,
  WorkcellPlanningEvidence,
  WorkcellReachabilityResult,
  WorkcellRobotLoadCheck,
} from "@bim-studio/contracts";
import { analyzeHumanErgonomics } from "./ergonomicsScreening.js";
import { analyzeRobotLoadCapabilities } from "./loadScreening.js";
import { assessWorkcellPlanningEvidence, planningEvidenceMissingLabel } from "./planningEvidence.js";
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
  const clearanceThreshold = finiteOptionalRange(input.clearanceThreshold, 0, 100);
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
  const planningEvidence = assessWorkcellPlanningEvidence(
    { ...input, objects },
    Boolean(input.trajectories?.length) || collisionPairs.some((item) => item.required && !item.intersects),
  );
  appendPlanningEvidenceFinding(planningEvidence, findings);
  const reachability = buildReachability(objects, byId, findings);
  inspectToolBindings(objects, byId, findings);
  const loadChecks = analyzeRobotLoadCapabilities(objects);
  appendLoadFindings(loadChecks, byId, findings);
  const ergonomicsChecks = analyzeHumanErgonomics(input.ergonomicsProfiles ?? [], objects);
  appendErgonomicsFindings(ergonomicsChecks, findings);
  const trajectoryAudit = analyzeWorkcellTrajectories({ ...input, objects });
  if (trajectoryAudit) findings.push(...trajectoryAudit.findings);

  const evaluatedObjects = objects.length - incompleteObjectIds.length;
  const robots = objects.filter((item) => item.role === "robot");
  const configuredRobots = robots.filter((item) => item.robot?.links.length);
  const geometryCoverage = objects.length ? evaluatedObjects / objects.length : 0;
  const robotCoverage = robots.length ? configuredRobots.length / robots.length : 1;
  const trajectoryCoverage = trajectoryEvidenceCoverage(input, trajectoryAudit?.analysis);
  const loadCoverage = loadChecks.length
    ? loadChecks.reduce((total, item) => total + item.evidenceCoverage, 0) / loadChecks.length
    : 1;
  const workcellCoverage = clamp(
    trajectoryAudit
      ? geometryCoverage * 0.4 + robotCoverage * 0.2 + trajectoryCoverage * 0.2 + loadCoverage * 0.2
      : geometryCoverage * 0.55 + robotCoverage * 0.25 + loadCoverage * 0.2,
    0,
    1,
  );
  const ergonomicsCoverage = ergonomicsChecks.length
    ? ergonomicsChecks.reduce((total, item) => total + item.evidenceCoverage, 0) / ergonomicsChecks.length
    : 1;
  const domainEvidenceCoverage = ergonomicsChecks.length
    ? clamp(workcellCoverage * 0.75 + ergonomicsCoverage * 0.25, 0, 1)
    : workcellCoverage;
  const evidenceCoverage = Math.min(domainEvidenceCoverage, planningEvidence.evidenceCoverage);
  const status = resultStatus(findings, collisionPairs, evidenceCoverage, loadChecks, ergonomicsChecks, planningEvidence);
  const resultBase = {
    generatedBy: "workcell-validation-plugin" as const,
    status,
    sceneId: input.sceneId,
    summary: summary(status, findings, collisionPairs, reachability, loadChecks, ergonomicsChecks, planningEvidence, trajectoryAudit?.analysis),
    inventory: inventory(objects),
    findings,
    collisionPairs,
    reachability,
    loadChecks,
    planningEvidence,
    ergonomicsChecks,
    ...(trajectoryAudit ? { trajectoryAnalysis: trajectoryAudit.analysis } : {}),
    incompleteObjectIds,
    evidenceCoverage,
    validationDraft: {
      objective: "验证当前工位的空间冲突、机器人可达性、工具绑定与负载/TCP规划包络",
      acceptanceCriteria: [
        "不存在确定的 AABB 空间冲突",
        ...(clearanceThreshold !== undefined ? [`必要对象间隙不小于 ${clearanceThreshold.toFixed(2)} m`] : []),
        "机器人目标位于已配置关节链的可达包络内",
        "所有工具与目标绑定完整",
        ...(loadChecks.length ? ["机器人额定负载、工具与工件质量、TCP 及组合重心证据完整并位于规划包络内"] : []),
        ...(ergonomicsChecks.length ? ["人工作业的可达、工作高度、前伸与搬运策略筛查已留证且无越界"] : []),
        ...(trajectoryAudit ? [
          "分段线性 TCP 包围球的连续 AABB 广相位不存在潜在冲突",
          "所有已声明轨迹关节角与速度位于约束内",
          "多机器人轨迹在重叠时间段内满足声明间隙",
        ] : []),
      ],
      objectIds: unique([
        ...findings.flatMap((item) => item.objectIds),
        ...loadChecks.flatMap((item) => [item.robotId, ...(item.toolObjectId ? [item.toolObjectId] : [])]),
        ...ergonomicsChecks.flatMap((item) => [
          ...(item.operatorObjectId ? [item.operatorObjectId] : []),
          ...(item.workPointObjectId ? [item.workPointObjectId] : []),
        ]),
      ]),
    },
  };
  return { ...resultBase, evidenceFingerprint: fingerprint({ input: { ...input, objects }, result: resultBase }) };
}

function buildCollisionPairs(objects: WorkcellAuditObject[], clearanceThreshold: number | undefined, findings: WorkcellAuditFinding[]): WorkcellCollisionPair[] {
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
      else if (required && clearanceThreshold !== undefined && distance < clearanceThreshold)
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

function appendLoadFindings(
  checks: WorkcellRobotLoadCheck[],
  byId: Map<string, WorkcellAuditObject>,
  findings: WorkcellAuditFinding[],
): void {
  for (const check of checks) {
    const robotName = byId.get(check.robotId)?.name ?? check.robotId;
    const objectIds = [check.robotId, ...(check.toolObjectId ? [check.toolObjectId] : [])];
    if (check.status === "exceeds-planning-envelope") {
      const violations = [
        ...(check.violations.includes("payload")
          ? [`总负载 ${formatMeasurement(check.totalLoadKg, "kg")} 超过额定 ${formatMeasurement(check.ratedPayloadKg, "kg")}`]
          : []),
        ...(check.violations.includes("load-center")
          ? [`组合重心 ${formatMeasurement(check.loadCenterDistanceMeters, "m")} 超过规划上限 ${formatMeasurement(check.maximumLoadCenterDistanceMeters, "m")}`]
          : []),
      ];
      findings.push(finding(
        `robot-load-exceeded-${check.robotId}`,
        "load",
        "error",
        "机器人负载超出规划包络",
        `${robotName}：${violations.join("；")}。`,
        objectIds,
        "调整机器人、工具或工件配置，并按厂商负载曲线复核腕部力矩与惯量",
      ));
      continue;
    }
    if (check.status === "needs-data") {
      findings.push(finding(
        `robot-load-needs-data-${check.robotId}`,
        "load",
        "info",
        "负载与 TCP 规划证据不完整",
        `${robotName} 缺少：${check.missingFields.map(loadFieldLabel).join("、")}。未输出负载能力通过结论。`,
        objectIds,
        "补充机器人额定负载、工具/工件质量、TCP 和组合重心参数",
      ));
    }
  }
}

function resultStatus(
  findings: WorkcellAuditFinding[],
  pairs: WorkcellCollisionPair[],
  coverage: number,
  loadChecks: WorkcellRobotLoadCheck[],
  ergonomicsChecks: WorkcellErgonomicsCheck[],
  planningEvidence: WorkcellPlanningEvidence,
): WorkcellAuditResult["status"] {
  if (findings.some((item) => item.severity === "error")) return "failed";
  if (planningEvidence.status === "needs-data" || loadChecks.some((item) => item.status === "needs-data") || ergonomicsChecks.some((item) => item.status === "needs-data")) return "needs-data";
  if (findings.some((item) => item.severity === "warning")) return "warning";
  if (coverage < 0.5 && pairs.length === 0) return "needs-data";
  return "passed";
}

function summary(
  status: WorkcellAuditResult["status"],
  findings: WorkcellAuditFinding[],
  pairs: WorkcellCollisionPair[],
  reachability: WorkcellReachabilityResult[],
  loadChecks: WorkcellRobotLoadCheck[],
  ergonomicsChecks: WorkcellErgonomicsCheck[],
  planningEvidence: WorkcellPlanningEvidence,
  trajectory: WorkcellAuditResult["trajectoryAnalysis"],
): string {
  const collisions = pairs.filter((item) => item.intersects).length;
  const unreachable = reachability.filter((item) => item.status !== "reachable").length;
  const pendingLoads = loadChecks.filter((item) => item.status === "needs-data").length;
  const pendingHumanTasks = ergonomicsChecks.filter((item) => item.status === "needs-data").length;
  if (status === "needs-data") {
    const pending = [
      ...(planningEvidence.status === "needs-data" ? [`规划基准缺少${planningEvidence.missingFields.map(planningEvidenceMissingLabel).join("、")}`] : []),
      ...(pendingLoads ? [`${pendingLoads} 台机器人缺少负载/TCP规划证据`] : []),
      ...(pendingHumanTasks ? [`${pendingHumanTasks} 个人工作业缺少工效筛查证据`] : []),
    ];
    return pending.length
      ? `已完成对象盘点，但${pending.join("，")}；未输出对应能力通过结论。`
      : "已完成对象盘点，但几何或机器人参数不足，未输出空间与可达结论。";
  }
  const trajectorySummary = trajectory
    ? `、${trajectory.segmentChecks.length} 段连续广相位、${trajectory.scheduleConflicts.length} 个多机器人时段冲突`
    : "";
  const exceededLoads = loadChecks.filter((item) => item.status === "exceeds-planning-envelope").length;
  const loadSummary = loadChecks.length ? `、${loadChecks.length} 台负载/TCP规划筛查` : "";
  const humanSummary = ergonomicsChecks.length ? `、${ergonomicsChecks.length} 个人工作业筛查` : "";
  const humanFailures = ergonomicsChecks.filter((item) => item.status === "fail").length;
  return `完成 ${pairs.length} 组必要空间关系、${reachability.length} 个机器人目标检查${loadSummary}${humanSummary}${trajectorySummary}；发现 ${collisions} 组冲突、${unreachable} 个不可达/盲区目标、${exceededLoads} 台负载越界、${humanFailures} 个人工作业越界、${findings.length} 项待处理。`;
}

function appendPlanningEvidenceFinding(evidence: WorkcellPlanningEvidence, findings: WorkcellAuditFinding[]): void {
  if (evidence.status === "confirmed") return;
  findings.push(finding(
    "planning-evidence-needs-data",
    "data",
    "info",
    evidence.missingFields.includes("planning-confirmation") ? "规划起步值尚未确认" : "规划基准证据不完整",
    `${evidence.declaration} 缺少：${evidence.missingFields.map(planningEvidenceMissingLabel).join("、")}。`,
    [],
    "在验证参数中补齐并确认本次安全间隙、候选轨迹速度与 TCP 包络半径",
  ));
}

function appendErgonomicsFindings(checks: WorkcellErgonomicsCheck[], findings: WorkcellAuditFinding[]): void {
  for (const check of checks) {
    const objectIds = [
      ...(check.operatorObjectId ? [check.operatorObjectId] : []),
      ...(check.workPointObjectId ? [check.workPointObjectId] : []),
    ];
    if (check.status === "fail" || check.status === "warn") {
      const risks = check.rules.filter((item) => item.status === "fail" || item.status === "warn");
      findings.push(finding(
        `ergonomics-${check.status}-${check.profileId}`,
        "ergonomics",
        check.status === "fail" ? "error" : "warning",
        check.status === "fail" ? "人工作业超出规划筛查阈值" : "人工作业接近规划筛查阈值",
        `${check.profileName}：${risks.map((item) => item.detail).join("；")}`,
        objectIds,
        check.recommendations.join("；"),
      ));
      continue;
    }
    if (check.status === "needs-data") {
      findings.push(finding(
        `ergonomics-needs-data-${check.profileId}`,
        "ergonomics",
        "info",
        "人工作业筛查证据不完整",
        `${check.profileName} 缺少：${check.missingFields.map(ergonomicsFieldLabel).join("、")}。`,
        objectIds,
        "补齐人体尺寸、作业点、搬运暴露与项目筛查策略",
      ));
    }
  }
}

function ergonomicsFieldLabel(value: WorkcellErgonomicsCheck["missingFields"][number]): string {
  return ({
    "operator-binding": "人员对象", "anthropometry-method": "人体录入方式", "anthropometry-percentile": "身高百分位",
    stature: "身高", "shoulder-height": "肩高", "elbow-height": "肘高", "functional-reach": "功能可达距离",
    "anthropometry-source": "人体数据来源", "anthropometry-reference": "人体数据引用", "work-point": "作业点",
    "load-mass": "单次负荷", repetitions: "搬运频次", duration: "连续时长", "task-source": "任务数据来源",
    "task-reference": "任务数据引用", "maximum-load": "负荷限值", "maximum-repetitions": "频次限值",
    "maximum-duration": "时长限值", "height-tolerance": "工作高度容差", "warning-utilization": "预警比例",
    "policy-source": "策略来源", "policy-reference": "策略引用",
  })[value];
}

function loadFieldLabel(value: WorkcellRobotLoadCheck["missingFields"][number]): string {
  return ({
    "tool-binding": "末端工具绑定",
    "rated-payload": "额定负载",
    "rated-load-center": "组合重心距离上限",
    "capability-source": "额定能力来源",
    "tool-mass": "工具质量",
    "carried-payload": "工件质量",
    "tcp-position": "TCP 位置",
    "tcp-orientation": "TCP 姿态",
    "combined-center-of-mass": "组合重心",
    "tool-load-source": "工具负载来源",
  })[value];
}

function formatMeasurement(value: number | undefined, unit: string): string {
  return value === undefined ? "待补充" : `${Number(value.toFixed(3))} ${unit}`;
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
function finiteOptionalRange(value: number | undefined, minimum: number, maximum: number): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
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
