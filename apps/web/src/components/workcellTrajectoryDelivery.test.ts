import type { WorkcellRobotTrajectory, WorkcellTrajectoryAnalysis } from "@bim-studio/contracts";
import { createEvidenceFingerprint } from "@bim-studio/studio-core";
import { describe, expect, it } from "vitest";
import {
  buildWorkcellTrajectoryDelivery,
  inspectWorkcellTrajectoryDelivery,
  serializeWorkcellTrajectoryDelivery,
  workcellTrajectoryDeliveryCsv,
  workcellTrajectoryDeliveryFileStem,
} from "./workcellTrajectoryDelivery";

describe("workcell trajectory delivery", () => {
  it("builds a traceable vendor-neutral package from matched real inputs and evidence", () => {
    const trajectories = trajectoryFixtures();
    const analysis = analysisFixture();
    const first = buildWorkcellTrajectoryDelivery(trajectories, analysis, "2026-09-03T08:00:00.000Z");
    const second = buildWorkcellTrajectoryDelivery(trajectories, analysis, "2026-09-03T09:00:00.000Z");

    expect(first.schema).toBe("bim-studio.workcell-trajectory-delivery.v1");
    expect(first.generatedBy).toBe("Industrial Studio");
    expect(first.traceability.trajectoryInputFingerprint).toMatch(/^fnv1a64-canonical-v1:[a-f0-9]{16}$/);
    expect(first.traceability.analysisFingerprint).toMatch(/^fnv1a64-canonical-v1:[a-f0-9]{16}$/);
    expect(first.traceability.packageFingerprint).toBe(second.traceability.packageFingerprint);
    expect(first.packageId).toBe(second.packageId);
    expect(first.units).toEqual({
      time: "second",
      position: "meter",
      pathLength: "meter",
      tcpSpeed: "meter-per-second",
      jointAngle: "degree",
      jointSpeed: "degree-per-second",
    });
    expect(first.summary).toMatchObject({
      trajectoryCount: 2,
      waypointCount: 4,
      jointSampleCount: 2,
      pathLengthMeters: 4,
      scheduleSpanSec: 5,
      maxConcurrentRobots: 2,
      broadPhaseRiskIntervalCount: 1,
      potentialObstacleAssociationCount: 1,
      jointConstraintRiskCount: 1,
      scheduleConflictCount: 1,
      avoidanceCandidateCount: 1,
    });
    expect(first.evidence.broadPhaseRiskIntervals[0]).toMatchObject({
      trajectoryId: "path-a",
      segmentId: "path-a:0-1",
      startTimeSec: 0,
      endTimeSec: 4,
      potentialObstacleIds: ["guard"],
      evidenceClass: "tcp-sphere-aabb-broad-phase",
    });
    expect(first.evidence.scheduleConflicts[0]?.closestTimeSec).toBe(2);
    expect(first.trajectoryInputs[0]?.waypoints[1]?.jointAnglesDeg).toEqual([89.8]);
    expect(first.capabilityBoundary).toMatchObject({
      purpose: "vendor-neutral-screening-evidence-handoff",
      controllerProgramGenerated: false,
      controllerCodeIncluded: false,
      dispatchable: false,
      tamperProofSignature: false,
    });
    expect(first.capabilityBoundary.declaration).toContain("不是离线编程结果");
    expect(serializeWorkcellTrajectoryDelivery(first).endsWith("\n")).toBe(true);
    expect(workcellTrajectoryDeliveryFileStem(first)).toMatch(/^bim-studio-trajectory-evidence-[a-f0-9]{12}$/);
  });

  it("fingerprints the exact filtered payload rather than ignored source inputs", () => {
    const trajectories = trajectoryFixtures();
    const ignored: WorkcellRobotTrajectory = {
      id: "path-unused", name: "未纳入本次分析", robotId: "robot-unused",
      waypoints: [
        { id: "unused-start", timeSec: 0, position: { x: 0, y: 0, z: 0 } },
        { id: "unused-end", timeSec: 1, position: { x: 1, y: 0, z: 0 } },
      ],
    };
    const filtered = buildWorkcellTrajectoryDelivery(trajectories, analysisFixture());
    const withIgnoredInput = buildWorkcellTrajectoryDelivery([...trajectories, ignored], analysisFixture());

    expect(withIgnoredInput.traceability.ignoredInputTrajectoryIds).toEqual(["path-unused"]);
    expect(withIgnoredInput.traceability.trajectoryInputFingerprint)
      .toBe(createEvidenceFingerprint(withIgnoredInput.trajectoryInputs));
    expect(withIgnoredInput.traceability.trajectoryInputFingerprint)
      .toBe(filtered.traceability.trajectoryInputFingerprint);
    expect(withIgnoredInput.traceability.packageFingerprint)
      .toBe(filtered.traceability.packageFingerprint);
  });

  it("exports traceable pose and joint samples as spreadsheet-friendly CSV", () => {
    const delivery = buildWorkcellTrajectoryDelivery(trajectoryFixtures(), analysisFixture(), "2026-09-03T08:00:00.000Z");
    const csv = workcellTrajectoryDeliveryCsv(delivery);

    expect(csv.startsWith("\uFEFFpackage_id,package_fingerprint")).toBe(true);
    expect(csv).toContain("joint_1_deg");
    expect(csv).toContain('path-a,"机器人取放,候选",robot-a,end-a,4,2,0,0,author-confirmed,89.8');
    expect(csv).toContain("path-b,机器人协同候选,robot-b,end-b,5,-0.5,0.18,0,scene-transform,");
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(5);
  });

  it("neutralises spreadsheet formulas in text cells without changing negative numbers", () => {
    const delivery = buildWorkcellTrajectoryDelivery(trajectoryFixtures(), analysisFixture());
    delivery.packageId = "\tpackage-formula";
    delivery.trajectoryInputs[0]!.id = "=CMD";
    delivery.trajectoryInputs[0]!.name = "+SUM(A1:A2)";
    delivery.trajectoryInputs[0]!.robotId = "-robot-formula";
    delivery.trajectoryInputs[0]!.waypoints[0]!.id = "@formula";
    delivery.trajectoryInputs[0]!.waypoints[0]!.position.x = -7.5;

    const csv = workcellTrajectoryDeliveryCsv(delivery);
    expect(csv).toContain(`"'\tpackage-formula"`);
    expect(csv).toContain("'=CMD");
    expect(csv).toContain("'+SUM(A1:A2)");
    expect(csv).toContain("'-robot-formula");
    expect(csv).toContain("'@formula");
    expect(csv).toContain(",-7.5,");
  });

  it("refuses partial, stale or non-finite evidence instead of silently mixing runs", () => {
    const missing = inspectWorkcellTrajectoryDelivery([trajectoryFixtures()[0]!], analysisFixture());
    expect(missing).toMatchObject({ ready: false, missingTrajectoryIds: ["path-b"] });
    expect(() => buildWorkcellTrajectoryDelivery([trajectoryFixtures()[0]!], analysisFixture())).toThrow("path-b");

    const invalid = trajectoryFixtures();
    invalid[0]!.waypoints[1]!.position.x = Number.NaN;
    expect(inspectWorkcellTrajectoryDelivery(invalid, analysisFixture())).toMatchObject({
      ready: false,
      reason: "轨迹或分析包含非有限数值，不能生成可交换证据",
    });

    const stale = analysisFixture();
    stale.segmentChecks[0]!.segmentId = "path-a:stale";
    expect(inspectWorkcellTrajectoryDelivery(trajectoryFixtures(), stale)).toMatchObject({
      ready: false,
      reason: "轨迹段证据与关键帧不匹配：path-a/path-a:stale",
    });

    const staleCycle = analysisFixture();
    staleCycle.cycle.trajectories[0]!.averageTcpSpeedMps = 99;
    expect(inspectWorkcellTrajectoryDelivery(trajectoryFixtures(), staleCycle)).toMatchObject({
      ready: false,
      reason: "节拍证据与关键帧不匹配：path-a",
    });

    const incompleteSegments = analysisFixture();
    incompleteSegments.segmentChecks.pop();
    expect(inspectWorkcellTrajectoryDelivery(trajectoryFixtures(), incompleteSegments)).toMatchObject({
      ready: false,
      reason: "轨迹段证据不完整：path-b",
    });

    const staleJointAngle = analysisFixture();
    staleJointAngle.jointChecks[0]!.angleDeg = 80;
    expect(inspectWorkcellTrajectoryDelivery(trajectoryFixtures(), staleJointAngle)).toMatchObject({
      ready: false,
      reason: "关节角证据与关键帧不匹配：path-a/end-a/j1",
    });

    const staleJointSpeed = analysisFixture();
    staleJointSpeed.jointChecks[0]!.inboundSpeedDegPerSec = 9;
    expect(inspectWorkcellTrajectoryDelivery(trajectoryFixtures(), staleJointSpeed)).toMatchObject({
      ready: false,
      reason: "关节速度证据与关键帧不匹配：path-a/end-a/j1",
    });

    const staleClosestTime = analysisFixture();
    staleClosestTime.scheduleConflicts[0]!.closestTimeSec = 2.5;
    expect(inspectWorkcellTrajectoryDelivery(trajectoryFixtures(), staleClosestTime)).toMatchObject({
      ready: false,
      reason: "多机器人最近点证据与当前轨迹不匹配：path-a/path-b",
    });

    const staleMinimumDistance = analysisFixture();
    staleMinimumDistance.scheduleConflicts[0]!.minimumTcpDistanceMeters = .19;
    expect(inspectWorkcellTrajectoryDelivery(trajectoryFixtures(), staleMinimumDistance)).toMatchObject({
      ready: false,
      reason: "多机器人最近点证据与当前轨迹不匹配：path-a/path-b",
    });
  });
});

function trajectoryFixtures(): WorkcellRobotTrajectory[] {
  return [
    {
      id: "path-a", name: "机器人取放,候选", robotId: "robot-a", tcpRadius: .1,
      precision: { source: "author-confirmed", positionToleranceMeters: .002, timeToleranceSeconds: .01, jointToleranceDeg: .2 },
      waypoints: [
        { id: "start-a", timeSec: 0, position: { x: 0, y: 0, z: 0 }, jointAnglesDeg: [49.8] },
        { id: "end-a", timeSec: 4, position: { x: 2, y: 0, z: 0 }, jointAnglesDeg: [89.8] },
      ],
    },
    {
      id: "path-b", name: "机器人协同候选", robotId: "robot-b", tcpRadius: .1,
      precision: { source: "scene-transform" },
      waypoints: [
        { id: "start-b", timeSec: 1, position: { x: 1.5, y: .18, z: 0 } },
        { id: "end-b", timeSec: 5, position: { x: -.5, y: .18, z: 0 } },
      ],
    },
  ];
}

function analysisFixture(): WorkcellTrajectoryAnalysis {
  return {
    method: "piecewise-linear-tcp-sphere-aabb-v1",
    approximation: "conservative-broad-phase",
    declaration: "保守广相位证据，不是网格精确碰撞。",
    precisionStatus: "partial",
    jointChecks: [{
      trajectoryId: "path-a", waypointId: "end-a", jointId: "j1", angleDeg: 89.8,
      positionStatus: "tolerance-overlap", inboundSpeedDegPerSec: 10, speedStatus: "within-limit",
    }],
    segmentChecks: [
      { trajectoryId: "path-a", segmentId: "path-a:0-1", startTimeSec: 0, endTimeSec: 4, lengthMeters: 2, potentialObstacleIds: ["guard"] },
      { trajectoryId: "path-b", segmentId: "path-b:0-1", startTimeSec: 1, endTimeSec: 5, lengthMeters: 2, potentialObstacleIds: [] },
    ],
    avoidanceCandidates: [{ trajectoryId: "path-a", segmentId: "path-a:0-1", obstacleId: "guard", status: "candidate-found", waypoints: [], declaration: "待网格级复核" }],
    scheduleConflicts: [{
      trajectoryIds: ["path-a", "path-b"], robotIds: ["robot-a", "robot-b"],
      segmentIds: ["path-a:0-1", "path-b:0-1"], startTimeSec: 1, endTimeSec: 4.01,
      closestTimeSec: 2, minimumTcpDistanceMeters: .18, requiredDistanceMeters: .2,
    }],
    cycle: {
      trajectories: [
        { trajectoryId: "path-a", robotId: "robot-a", durationSec: 4, pathLengthMeters: 2, averageTcpSpeedMps: .5 },
        { trajectoryId: "path-b", robotId: "robot-b", durationSec: 4, pathLengthMeters: 2, averageTcpSpeedMps: .5 },
      ],
      scheduleSpanSec: 5,
      maxConcurrentRobots: 2,
    },
  };
}
