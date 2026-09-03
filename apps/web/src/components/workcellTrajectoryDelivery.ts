import type {
  WorkcellRobotTrajectory,
  WorkcellTrajectoryAnalysis,
  WorkcellTrajectorySegmentCheck,
} from "@bim-studio/contracts";
import { createEvidenceFingerprint, EVIDENCE_FINGERPRINT_ALGORITHM } from "@bim-studio/studio-core";
import { buildWorkcellTrajectoryTracks } from "./workcellTrajectoryPlayback";
import { trajectoryEvidenceRelationshipIssue } from "./workcellTrajectoryDeliveryValidation";

export const WORKCELL_TRAJECTORY_DELIVERY_SCHEMA = "bim-studio.workcell-trajectory-delivery.v1" as const;

export interface WorkcellTrajectoryDeliveryReadiness {
  ready: boolean;
  compatibleTrajectoryIds: string[];
  missingTrajectoryIds: string[];
  ignoredInputTrajectoryIds: string[];
  waypointCount: number;
  reason?: string;
}

export interface WorkcellTrajectoryRiskInterval extends WorkcellTrajectorySegmentCheck {
  evidenceClass: "tcp-sphere-aabb-broad-phase";
}

export interface WorkcellTrajectoryDeliveryPackage {
  schema: typeof WORKCELL_TRAJECTORY_DELIVERY_SCHEMA;
  generatedBy: "Industrial Studio";
  generatedAt: string;
  packageId: string;
  units: {
    time: "second";
    position: "meter";
    pathLength: "meter";
    tcpSpeed: "meter-per-second";
    jointAngle: "degree";
    jointSpeed: "degree-per-second";
  };
  traceability: {
    fingerprintAlgorithm: typeof EVIDENCE_FINGERPRINT_ALGORITHM;
    trajectoryInputFingerprint: string;
    analysisFingerprint: string;
    packageFingerprint: string;
    includedTrajectoryIds: string[];
    ignoredInputTrajectoryIds: string[];
  };
  summary: {
    trajectoryCount: number;
    waypointCount: number;
    jointSampleCount: number;
    pathLengthMeters: number;
    scheduleSpanSec: number;
    maxConcurrentRobots: number;
    broadPhaseRiskIntervalCount: number;
    potentialObstacleAssociationCount: number;
    jointConstraintRiskCount: number;
    scheduleConflictCount: number;
    avoidanceCandidateCount: number;
    precisionStatus: WorkcellTrajectoryAnalysis["precisionStatus"];
  };
  trajectoryInputs: WorkcellRobotTrajectory[];
  evidence: WorkcellTrajectoryAnalysis & {
    broadPhaseRiskIntervals: WorkcellTrajectoryRiskInterval[];
  };
  capabilityBoundary: {
    purpose: "vendor-neutral-screening-evidence-handoff";
    controllerProgramGenerated: false;
    controllerCodeIncluded: false;
    dispatchable: false;
    tamperProofSignature: false;
    declaration: string;
    notIncluded: string[];
  };
}

export function inspectWorkcellTrajectoryDelivery(
  trajectories: readonly WorkcellRobotTrajectory[],
  analysis: WorkcellTrajectoryAnalysis,
): WorkcellTrajectoryDeliveryReadiness {
  const tracks = buildWorkcellTrajectoryTracks(trajectories, analysis);
  const compatibleIds = new Set(tracks.map((item) => item.id));
  const referencedIds = analysisTrajectoryIds(analysis);
  const missingTrajectoryIds = referencedIds.filter((id) => !compatibleIds.has(id));
  const ignoredInputTrajectoryIds = [...new Set(trajectories.map((item) => item.id))]
    .filter((id) => !compatibleIds.has(id));
  const waypointCount = tracks.reduce((total, item) => total + item.waypoints.length, 0);
  const finite = !containsNonFiniteNumber({ trajectories, analysis });
  const relationshipIssue = finite && !missingTrajectoryIds.length
    ? trajectoryEvidenceRelationshipIssue(trajectories, analysis)
    : undefined;
  const ready = referencedIds.length > 0 && tracks.length > 0 && missingTrajectoryIds.length === 0 && finite && !relationshipIssue;

  return {
    ready,
    compatibleTrajectoryIds: tracks.map((item) => item.id),
    missingTrajectoryIds,
    ignoredInputTrajectoryIds,
    waypointCount,
    ...(!finite
      ? { reason: "轨迹或分析包含非有限数值，不能生成可交换证据" }
      : missingTrajectoryIds.length
        ? { reason: `缺少与分析匹配的轨迹输入：${missingTrajectoryIds.join("、")}` }
        : relationshipIssue
          ? { reason: relationshipIssue }
        : !tracks.length
          ? { reason: "没有与本次节拍和路径证据相匹配的轨迹" }
          : {}),
  };
}

export function buildWorkcellTrajectoryDelivery(
  trajectories: readonly WorkcellRobotTrajectory[],
  analysis: WorkcellTrajectoryAnalysis,
  generatedAt = new Date().toISOString(),
): WorkcellTrajectoryDeliveryPackage {
  const readiness = inspectWorkcellTrajectoryDelivery(trajectories, analysis);
  if (!readiness.ready) throw new Error(readiness.reason ?? "当前轨迹证据不能生成交付包");
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("轨迹交付包生成时间无效");

  const includedIds = new Set(readiness.compatibleTrajectoryIds);
  const trajectoryInputs = uniqueTrajectories(trajectories)
    .filter((item) => includedIds.has(item.id))
    .map(cloneTrajectory);
  const evidence = structuredClone(analysis) as WorkcellTrajectoryDeliveryPackage["evidence"];
  evidence.broadPhaseRiskIntervals = analysis.segmentChecks
    .filter((item) => item.potentialObstacleIds.length > 0)
    .map((item) => ({ ...structuredClone(item), evidenceClass: "tcp-sphere-aabb-broad-phase" as const }));
  // The primary fingerprint must be reproducible from the exact payload being handed off.
  // Ignored source inputs remain visible through ignoredInputTrajectoryIds, but do not alter
  // the identity of an otherwise identical delivery package.
  const trajectoryInputFingerprint = createEvidenceFingerprint(trajectoryInputs);
  const analysisFingerprint = createEvidenceFingerprint(analysis);
  const packageFingerprint = createEvidenceFingerprint({
    schema: WORKCELL_TRAJECTORY_DELIVERY_SCHEMA,
    trajectoryInputs,
    evidence,
    capability: "vendor-neutral-screening-evidence-handoff",
  });

  return {
    schema: WORKCELL_TRAJECTORY_DELIVERY_SCHEMA,
    generatedBy: "Industrial Studio",
    generatedAt: new Date(generatedAt).toISOString(),
    packageId: `trajectory-evidence:${packageFingerprint.slice(-16)}`,
    units: {
      time: "second",
      position: "meter",
      pathLength: "meter",
      tcpSpeed: "meter-per-second",
      jointAngle: "degree",
      jointSpeed: "degree-per-second",
    },
    traceability: {
      fingerprintAlgorithm: EVIDENCE_FINGERPRINT_ALGORITHM,
      trajectoryInputFingerprint,
      analysisFingerprint,
      packageFingerprint,
      includedTrajectoryIds: readiness.compatibleTrajectoryIds,
      ignoredInputTrajectoryIds: readiness.ignoredInputTrajectoryIds,
    },
    summary: summarize(trajectoryInputs, analysis, evidence.broadPhaseRiskIntervals),
    trajectoryInputs,
    evidence,
    capabilityBoundary: {
      purpose: "vendor-neutral-screening-evidence-handoff",
      controllerProgramGenerated: false,
      controllerCodeIncluded: false,
      dispatchable: false,
      tamperProofSignature: false,
      declaration: "该文件交付本次供应商中立的轨迹输入与快速初筛证据，不是离线编程结果、控制器程序或安全验收结论。",
      notIncluded: [
        "控制器专用程序、指令语法、工具坐标系与下发配置",
        "完整逆运动学、奇异点、负载惯量和动力学校核",
        "机器人连杆、工具、工件与电缆的网格级连续扫掠碰撞",
        "真实控制器加减速、jerk、转角圆滑、IO 等待与节拍仿真",
        "安全 PLC、围栏门、急停、区域扫描和现场低速试运行验收",
      ],
    },
  };
}

export function serializeWorkcellTrajectoryDelivery(value: WorkcellTrajectoryDeliveryPackage): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function workcellTrajectoryDeliveryCsv(value: WorkcellTrajectoryDeliveryPackage): string {
  const jointCount = value.trajectoryInputs.reduce((maximum, trajectory) => Math.max(
    maximum,
    ...trajectory.waypoints.map((waypoint) => waypoint.jointAnglesDeg?.length ?? 0),
  ), 0);
  const jointHeaders = Array.from({ length: jointCount }, (_, index) => `joint_${index + 1}_deg`);
  const header = [
    "package_id", "package_fingerprint", "trajectory_id", "trajectory_name", "robot_id",
    "waypoint_id", "time_sec", "x_m", "y_m", "z_m", "precision_source", ...jointHeaders,
  ];
  const rows = value.trajectoryInputs.flatMap((trajectory) => trajectory.waypoints.map((waypoint) => [
    value.packageId,
    value.traceability.packageFingerprint,
    trajectory.id,
    trajectory.name,
    trajectory.robotId,
    waypoint.id,
    waypoint.timeSec,
    waypoint.position.x,
    waypoint.position.y,
    waypoint.position.z,
    trajectory.precision?.source ?? "",
    ...Array.from({ length: jointCount }, (_, index) => waypoint.jointAnglesDeg?.[index] ?? ""),
  ]));
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function workcellTrajectoryDeliveryFileStem(value: WorkcellTrajectoryDeliveryPackage): string {
  return `bim-studio-trajectory-evidence-${value.traceability.packageFingerprint.slice(-12)}`;
}

function summarize(
  trajectories: readonly WorkcellRobotTrajectory[],
  analysis: WorkcellTrajectoryAnalysis,
  riskIntervals: readonly WorkcellTrajectoryRiskInterval[],
): WorkcellTrajectoryDeliveryPackage["summary"] {
  return {
    trajectoryCount: trajectories.length,
    waypointCount: trajectories.reduce((total, item) => total + item.waypoints.length, 0),
    jointSampleCount: trajectories.reduce((total, item) => total + item.waypoints.reduce((count, waypoint) => count + (waypoint.jointAnglesDeg?.length ?? 0), 0), 0),
    pathLengthMeters: analysis.cycle.trajectories.reduce((total, item) => total + item.pathLengthMeters, 0),
    scheduleSpanSec: analysis.cycle.scheduleSpanSec,
    maxConcurrentRobots: analysis.cycle.maxConcurrentRobots,
    broadPhaseRiskIntervalCount: riskIntervals.length,
    potentialObstacleAssociationCount: riskIntervals.reduce((total, item) => total + item.potentialObstacleIds.length, 0),
    jointConstraintRiskCount: analysis.jointChecks.filter(isJointRisk).length,
    scheduleConflictCount: analysis.scheduleConflicts.length,
    avoidanceCandidateCount: analysis.avoidanceCandidates.filter((item) => item.status === "candidate-found").length,
    precisionStatus: analysis.precisionStatus,
  };
}

function analysisTrajectoryIds(analysis: WorkcellTrajectoryAnalysis): string[] {
  return [...new Set([
    ...analysis.cycle.trajectories.map((item) => item.trajectoryId),
    ...analysis.jointChecks.map((item) => item.trajectoryId),
    ...analysis.segmentChecks.map((item) => item.trajectoryId),
    ...analysis.avoidanceCandidates.map((item) => item.trajectoryId),
    ...analysis.scheduleConflicts.flatMap((item) => item.trajectoryIds),
  ].filter(Boolean))];
}
function uniqueTrajectories(values: readonly WorkcellRobotTrajectory[]): WorkcellRobotTrajectory[] {
  return [...new Map(values.map((item) => [item.id, item])).values()];
}
function cloneTrajectory(value: WorkcellRobotTrajectory): WorkcellRobotTrajectory {
  return structuredClone(value);
}
function isJointRisk(item: WorkcellTrajectoryAnalysis["jointChecks"][number]): boolean {
  return item.positionStatus === "outside-limit" || item.positionStatus === "tolerance-overlap"
    || item.speedStatus === "outside-limit" || item.speedStatus === "tolerance-overlap";
}
function csvCell(value: string | number): string {
  // Spreadsheet applications may evaluate string cells beginning with these characters.
  // Preserve actual numeric negatives while neutralising user-authored text values.
  const text = typeof value === "string" && /^[=+\-@\t]/.test(value) ? `'${value}` : String(value);
  return /[\t",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function containsNonFiniteNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFiniteNumber);
  if (value && typeof value === "object") return Object.values(value).some(containsNonFiniteNumber);
  return false;
}
