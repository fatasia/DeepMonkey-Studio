import type {
  IndustrialValidationStudyRecord,
  PlantLiteStudyRecord,
  ProjectRecord,
  SceneSnapshot,
  WorkcellRobotTrajectory,
  WorkcellTrajectoryAnalysis,
} from "@bim-studio/contracts";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";

const createdAt = "2026-08-30T00:00:00.000Z";
const identity = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};

export const industrialVisualQaProject: ProjectRecord = {
  id: "visual-qa",
  name: "电池模组示范工厂",
  description: "工业工作流视觉验收夹具",
  models: [],
  createdAt,
  updatedAt: createdAt,
};

export const industrialVisualQaScene: SceneSnapshot = {
  schemaVersion: 1,
  id: "workcell-qa",
  projectId: industrialVisualQaProject.id,
  name: "电池模组装配工位",
  camera: { position: { x: 10, y: 8, z: 10 }, target: { x: 0, y: 1, z: 0 }, mode: "orbit" },
  models: [{
    modelId: "robot-a",
    name: "装配机器人 A",
    visible: true,
    opacity: 1,
    transform: identity,
    rig: {
      bones: [],
      ik: [],
      robot: {
        enabled: true,
        baseBonePath: "root",
        toolObjectId: "fixture-01",
        targetObjectIds: ["target-01"],
        loadCapability: {
          ratedPayloadKg: 20,
          maximumLoadCenterDistanceMeters: .35,
          source: "author-confirmed",
          reference: "视觉验收规划参数",
        },
        toolLoad: {
          toolMassKg: 4.5,
          carriedPayloadKg: 8,
          tcpPositionMeters: { x: 0, y: 0, z: .22 },
          tcpOrientationEulerDeg: { x: 0, y: 90, z: 0 },
          combinedCenterOfMassMeters: { x: 0, y: 0, z: .19 },
          source: "author-confirmed",
          reference: "视觉验收规划参数",
        },
        joints: [
          { bonePath: "root/shoulder", name: "肩部", axis: "z", length: 1.2, minAngleDeg: -170, maxAngleDeg: 170 },
          { bonePath: "root/shoulder/elbow", name: "肘部", axis: "z", length: 1, minAngleDeg: -120, maxAngleDeg: 120 },
        ],
      },
    },
  }],
  primitives: [
    { modelId: "fixture-01", name: "模组夹具", kind: "box", color: "#537b83", visible: true, opacity: 1, transform: { ...identity, position: { x: 1.8, y: .45, z: 0 }, scale: { x: .7, y: .45, z: .9 } } },
    { modelId: "fence-01", name: "安全围栏", kind: "box", color: "#a77d3d", visible: true, opacity: .72, transform: { ...identity, position: { x: 2.8, y: 1, z: 0 }, scale: { x: .06, y: 1, z: 2.8 } } },
  ],
  annotations: [{ id: "target-01", name: "装配目标点", position: { x: 1.65, y: 1.1, z: 0 }, color: "#d4a84f", visible: true, locked: false }],
  measurements: [],
  createdAt,
  updatedAt: createdAt,
};

/** 只用于把验收页推进到第二步，不伪造机器人求解或控制运行结果。 */
export const completedWorkcellScreening: IndustrialValidationStudyRecord = {
  id: "workcell-screening-qa",
  projectId: industrialVisualQaProject.id,
  revision: 1,
  title: "工位快速验证：电池模组装配工位",
  sourceKind: "workcell-audit",
  studyType: "workcell-audit",
  sourceRefs: ["qa-screening-evidence"],
  sceneId: industrialVisualQaScene.id,
  objectIds: ["robot-a", "fixture-01", "target-01"],
  objective: "确认任务对象齐全后进入控制逻辑验证",
  acceptanceCriteria: ["任务对象可定位", "快速检查已留证"],
  status: "passed",
  latestResult: {
    status: "passed",
    scenarioId: `workcell-audit:${industrialVisualQaScene.id}`,
    evidenceFingerprint: "qa-screening-evidence",
    failureCount: 0,
    completedAt: createdAt,
  },
  createdAt,
  updatedAt: createdAt,
};

export const completedControlValidation: IndustrialValidationStudyRecord = {
  id: "control-validation-qa",
  projectId: industrialVisualQaProject.id,
  revision: 2,
  title: "控制逻辑验证：电池模组装配工位",
  sourceKind: "manual",
  studyType: "virtual-commissioning",
  sourceRefs: ["qa-control-evidence"],
  sceneId: industrialVisualQaScene.id,
  objectIds: ["robot-a"],
  objective: "验证启动、故障联锁、人工复位与告警结果",
  acceptanceCriteria: ["正常启动", "故障正确锁存", "复位后恢复"],
  status: "passed",
  latestResult: {
    status: "passed",
    scenarioId: `${industrialVisualQaScene.id}-golden-suite`,
    evidenceFingerprint: "qa-control-evidence",
    failureCount: 0,
    completedAt: createdAt,
  },
  createdAt,
  updatedAt: createdAt,
};

export const industrialVisualQaTrajectories: WorkcellRobotTrajectory[] = [
  {
    id: "path-a", name: "装配机器人 A 取放", robotId: "robot-a",
    waypoints: [
      { id: "home", timeSec: 1, position: { x: 0, y: 0, z: 0 }, jointAnglesDeg: [0] },
      { id: "pick", timeSec: 5, position: { x: 4, y: 2, z: 0 }, jointAnglesDeg: [190] },
    ],
  },
  {
    id: "path-b", name: "上料机器人 B", robotId: "robot-b",
    waypoints: [
      { id: "start", timeSec: 0, position: { x: 4, y: 0, z: 0 } },
      { id: "end", timeSec: 5, position: { x: 0, y: 2, z: 0 } },
    ],
  },
];

export const industrialVisualQaTrajectoryAnalysis: WorkcellTrajectoryAnalysis = {
  method: "piecewise-linear-tcp-sphere-aabb-v1",
  approximation: "conservative-broad-phase",
  declaration: "分段线性 TCP 包围球与扩张 AABB 广相位。",
  precisionStatus: "partial",
  jointChecks: [{
    trajectoryId: "path-a", waypointId: "pick", jointId: "J1", angleDeg: 190,
    positionStatus: "outside-limit", inboundSpeedDegPerSec: 47.5, speedStatus: "within-limit",
  }],
  segmentChecks: [
    { trajectoryId: "path-a", segmentId: "path-a:0-1", startTimeSec: 1, endTimeSec: 5, lengthMeters: Math.sqrt(20), potentialObstacleIds: ["fixture-01"] },
    { trajectoryId: "path-b", segmentId: "path-b:0-1", startTimeSec: 0, endTimeSec: 5, lengthMeters: Math.sqrt(20), potentialObstacleIds: [] },
  ],
  avoidanceCandidates: [],
  scheduleConflicts: [{
    trajectoryIds: ["path-a", "path-b"], robotIds: ["robot-a", "robot-b"], segmentIds: ["path-a:0-1", "path-b:0-1"],
    startTimeSec: 1, endTimeSec: 5, closestTimeSec: 2.784615384615385,
    minimumTcpDistanceMeters: .22188007849009167, requiredDistanceMeters: .3,
  }],
  cycle: {
    trajectories: [
      { trajectoryId: "path-a", robotId: "robot-a", durationSec: 4, pathLengthMeters: Math.sqrt(20), averageTcpSpeedMps: Math.sqrt(20) / 4 },
      { trajectoryId: "path-b", robotId: "robot-b", durationSec: 5, pathLengthMeters: Math.sqrt(20), averageTcpSpeedMps: Math.sqrt(20) / 5 },
    ],
    scheduleSpanSec: 5,
    maxConcurrentRobots: 2,
  },
};

const plantCi = { mean: 60, sampleStandardDeviation: 2, lower95: 58, upper95: 62, samples: 12 };
const energyCi = (mean: number) => ({ mean, sampleStandardDeviation: mean * .04, lower95: mean * .96, upper95: mean * 1.04, samples: 12 });
const plantEnergy = (unitKwh: number) => ({
  activeEnergyKwh: energyCi(unitKwh * 420),
  idleEnergyKwh: energyCi(unitKwh * 60),
  totalEnergyKwh: energyCi(unitKwh * 480),
  energyPerCompletedItemKwh: energyCi(unitKwh),
  electricityCost: energyCi(unitKwh * 408),
  electricityCostPerCompletedItem: energyCi(unitKwh * .85),
  carbonEmissionKg: energyCi(unitKwh * 278.4),
  carbonEmissionPerCompletedItemKg: energyCi(unitKwh * .58),
  peakDemandKw: energyCi(29),
  consumerEnergyKwh: {
    "station-a": energyCi(unitKwh * 300),
    "station-b-equipment": energyCi(unitKwh * 130),
    "agv-fleet": energyCi(unitKwh * 50),
  },
});
const plantModel = createAgvLinePlantLiteModel();
plantModel.resources ??= [];
plantModel.resources.push({
  id: "station-b-equipment",
  name: "终检设备",
  kind: "equipment",
  capacity: 1,
  failure: { timeToFailure: { kind: "exponential", mean: 180 }, repairTime: { kind: "deterministic", value: 8 } },
  power: { activePowerKw: 8, idlePowerKw: 1.2 },
});
const equipmentStation = plantModel.nodes.find((node) => node.id === "station-b");
if (equipmentStation?.kind === "station") {
  delete equipmentStation.power;
  equipmentStation.resourceId = "station-b-equipment";
}

export const industrialVisualQaPlantStudy: PlantLiteStudyRecord = {
  id: "plant-study-qa",
  projectId: industrialVisualQaProject.id,
  name: "电池模组产线基线",
  createdAt,
  templateId: "agv-line-v1",
  model: plantModel,
  modelFingerprint: "qa-plant-model",
  seed: "qa-fixed-seed",
  replications: 12,
  inputFingerprint: "qa-plant-input",
  trace: {
    engineId: "plant-lite-des",
    engineVersion: "1.0.0",
    replication: 0,
    seed: 314159,
    capturedItemCount: 2,
    omittedEventCount: 0,
    truncated: false,
    limits: { maxEvents: 2_000, maxItems: 100 },
    events: [
      { sequence: 0, atMinute: 0, type: "item-enter", itemId: "source:1", nodeId: "source" },
      { sequence: 1, atMinute: 0, type: "item-exit", itemId: "source:1", nodeId: "source" },
      { sequence: 2, atMinute: 0, type: "item-enter", itemId: "source:1", nodeId: "station-a" },
      { sequence: 3, atMinute: 0, type: "item-start", itemId: "source:1", nodeId: "station-a" },
      { sequence: 4, atMinute: 2, type: "item-complete", itemId: "source:1", nodeId: "station-a" },
      { sequence: 5, atMinute: 2, type: "item-exit", itemId: "source:1", nodeId: "station-a" },
      { sequence: 6, atMinute: 2, type: "item-enter", itemId: "source:1", nodeId: "queue-buffer" },
      { sequence: 7, atMinute: 2, type: "item-exit", itemId: "source:1", nodeId: "queue-buffer" },
      { sequence: 8, atMinute: 2, type: "item-enter", itemId: "source:1", nodeId: "transport" },
      { sequence: 9, atMinute: 2, type: "item-start", itemId: "source:1", nodeId: "transport" },
      { sequence: 10, atMinute: 3, type: "item-enter", itemId: "source:2", nodeId: "source" },
      { sequence: 11, atMinute: 4, type: "resource-failure", resourceId: "agv-fleet", unitIndex: 0, unavailableUnits: 1 },
      { sequence: 12, atMinute: 6, type: "resource-repair", resourceId: "agv-fleet", unitIndex: 0, unavailableUnits: 0 },
      { sequence: 13, atMinute: 7, type: "item-complete", itemId: "source:1", nodeId: "transport" },
      { sequence: 14, atMinute: 7, type: "item-exit", itemId: "source:1", nodeId: "transport" },
      { sequence: 15, atMinute: 7, type: "item-enter", itemId: "source:1", nodeId: "station-b" },
      { sequence: 16, atMinute: 7, type: "item-start", itemId: "source:1", nodeId: "station-b" },
      { sequence: 17, atMinute: 7.5, type: "resource-failure", resourceId: "station-b-equipment", unitIndex: 0, unavailableUnits: 1 },
      { sequence: 18, atMinute: 8.5, type: "resource-repair", resourceId: "station-b-equipment", unitIndex: 0, unavailableUnits: 0 },
      { sequence: 19, atMinute: 9, type: "item-complete", itemId: "source:1", nodeId: "station-b" },
      { sequence: 20, atMinute: 9, type: "item-exit", itemId: "source:1", nodeId: "station-b" },
      { sequence: 21, atMinute: 9, type: "item-enter", itemId: "source:1", nodeId: "sink" },
      { sequence: 22, atMinute: 9, type: "item-complete", itemId: "source:1", nodeId: "sink" },
    ],
  },
  outcome: {
    status: "completed",
    completedReplications: 12,
    throughputPerHour: plantCi,
    averageWip: { ...plantCi, mean: 3, lower95: 2.8, upper95: 3.2 },
    averageLeadTimeMinutes: { ...plantCi, mean: 5, lower95: 4.5, upper95: 5.5 },
    nodeMetrics95: {
      "station-a": {
        utilization: { ...plantCi, mean: .92 },
        averageQueueLength: { ...plantCi, mean: 4.2 },
        blockedMinutes: { ...plantCi, mean: 0 },
        starvedMinutes: { ...plantCi, mean: 1 },
      },
    },
    resourceUtilization95: {
      "agv-fleet": { ...plantCi, mean: .71, lower95: .67, upper95: .75 },
      "station-b-equipment": { ...plantCi, mean: .68, lower95: .64, upper95: .72 },
    },
    resourceFailedMinutes95: {
      "station-b-equipment": { ...plantCi, mean: 21, lower95: 15, upper95: 27 },
    },
    energy: plantEnergy(1.5),
    bottlenecks: [{ nodeId: "station-a", occurrences: 12, probability: 1 }],
  },
  execution: {
    engineId: "plant-lite-des",
    engineVersion: "1.0.0",
    inputFingerprint: "qa-plant-input",
    deterministic: true,
    limits: { durationMinutes: 480, maxEvents: 100_000, maxResources: 12 },
    trace: { replication: 0, maxEvents: 2_000, maxItems: 100 },
  },
};

export const industrialVisualQaPlantStudies: PlantLiteStudyRecord[] = [
  createPlantSweepCandidate("plant-study-qa-3", "3 个并行工位", 3, 72, 3.7, 4.1),
  createPlantSweepCandidate("plant-study-qa-2", "2 个并行工位", 2, 67, 3.4, 4.4),
  industrialVisualQaPlantStudy,
];

function createPlantSweepCandidate(
  id: string,
  candidateLabel: string,
  stationCapacity: number,
  throughput: number,
  averageWip: number,
  leadTimeMinutes: number,
): PlantLiteStudyRecord {
  const model = structuredClone(plantModel);
  const station = model.nodes.find((node) => node.id === "station-a" && node.kind === "station");
  if (station?.kind === "station") station.capacity = stationCapacity;
  return {
    ...structuredClone(industrialVisualQaPlantStudy),
    id,
    name: `装配工位 · ${candidateLabel}`,
    model,
    modelFingerprint: `qa-plant-model-${stationCapacity}`,
    inputFingerprint: `qa-plant-input-${stationCapacity}`,
    comparison: {
      groupId: `bottleneck-sweep:${industrialVisualQaPlantStudy.id}`,
      baselineStudyId: industrialVisualQaPlantStudy.id,
      parameterLabel: "并行工位数",
      candidateLabel,
    },
    outcome: {
      ...structuredClone(industrialVisualQaPlantStudy.outcome),
      throughputPerHour: { ...plantCi, mean: throughput, lower95: throughput - 2, upper95: throughput + 2 },
      averageWip: { ...plantCi, mean: averageWip, lower95: averageWip - .3, upper95: averageWip + .3 },
      averageLeadTimeMinutes: { ...plantCi, mean: leadTimeMinutes, lower95: leadTimeMinutes - .3, upper95: leadTimeMinutes + .3 },
      energy: plantEnergy(stationCapacity === 2 ? 1.36 : 1.31),
    },
    execution: {
      ...industrialVisualQaPlantStudy.execution,
      inputFingerprint: `qa-plant-input-${stationCapacity}`,
    },
  };
}
