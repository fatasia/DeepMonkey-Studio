import { describe, expect, it } from "vitest";
import type { MaintenanceDeploymentRecord, MaintenanceModelPackage } from "@bim-studio/contracts";
import { analyzeEnergy, buildMaintenanceAssessment, evaluateMaintenanceShadow, prepareMaintenanceWindow, runLogisticsExperiment, scoreNativeArtifact } from "./operationsEngine.js";

const model: MaintenanceModelPackage = {
  id: "model-1",
  projectId: "project-1",
  name: "test",
  version: "1",
  algorithm: "linear",
  source: "imported",
  status: "candidate",
  benchmarkOnly: true,
  productionEligible: false,
  evaluationProtocol: "shadow",
  dataFingerprint: "test",
  trainRows: 100,
  validationRows: 40,
  metrics: {},
  artifact: {
    engine: "native-json",
    modelKind: "failure-probability",
    features: ["temperature", "vibration"],
    means: [50, 2],
    stds: [5, 1],
    weights: [1, 1],
    bias: -2,
    decisionThreshold: 0.5,
  },
  gates: { minimumSamples: 3, minimumDataQuality: 0.9, maximumDriftSigma: 5, warningThreshold: 0.45, criticalThreshold: 0.7, scoreDirection: "high-risk" },
  createdAt: "2026-08-26T00:00:00Z",
  updatedAt: "2026-08-26T00:00:00Z",
};
const deployment: MaintenanceDeploymentRecord = {
  id: "deployment-1",
  projectId: "project-1",
  name: "test",
  modelId: model.id,
  equipmentId: "line-1",
  maintainableUnitId: "drive-1",
  objectIds: [],
  sourceId: "telemetry",
  featureMappings: {},
  sampleIntervalSec: 60,
  windowSize: 3,
  enabled: true,
  status: "shadow",
  createdAt: "2026-08-26T00:00:00Z",
  updatedAt: "2026-08-26T00:00:00Z",
};

describe("operations engine", () => {
  it("scores a maintenance window and keeps a benchmark model in shadow", () => {
    const rows = [
      { temperature: 50, vibration: 2 },
      { temperature: 51, vibration: 2.1 },
      { temperature: 60, vibration: 3.2 },
    ];
    const window = prepareMaintenanceWindow(model, deployment, rows);
    const assessment = buildMaintenanceAssessment({ projectId: model.projectId, model, deployment, window, score: scoreNativeArtifact(model.artifact, rows[2]!) });
    expect(assessment.decisionStatus).toBe("shadow");
    expect(assessment.riskLevel).toBe("critical");
    expect(assessment.topContributors[0]?.feature).toBe("temperature");
  });

  it("calculates shadow metrics and gates false alarms", () => {
    const result = evaluateMaintenanceShadow({
      projectId: "project-1",
      modelId: "model-1",
      threshold: 0.5,
      labelColumn: "fault",
      rows: Array.from({ length: 40 }, (_, index) => ({ fault: index >= 30 ? 1 : 0 })),
      scores: Array.from({ length: 40 }, (_, index) => (index >= 30 ? 0.9 : 0.1)),
    });
    expect(result).toMatchObject({ truePositive: 10, falsePositive: 0, precision: 1, recall: 1, passed: true });
  });

  it("identifies a logistics transport bottleneck and energy deviation", () => {
    const logistics = runLogisticsExperiment("project-1", {
      name: "test",
      durationHours: 8,
      agvCount: 1,
      cycleTimeSec: 600,
      chargingMinutesPerHour: 10,
      congestionFactor: 0.3,
      demandPerHour: 100,
      bufferCapacity: 100,
    });
    expect(logistics.bottleneck).toBe("transport");
    expect(logistics.execution).toMatchObject({
      engineId: "factory-flow-analytic",
      engineVersion: "1.0.0",
      inputFingerprint: logistics.fingerprint,
      deterministic: true,
    });
    const energy = analyzeEnergy("project-1", [
      { timestamp: "1", output: 100, energyKwh: 50 },
      { timestamp: "2", output: 100, energyKwh: 51 },
      { timestamp: "3", output: 100, energyKwh: 49 },
      { timestamp: "4", output: 100, energyKwh: 80, idleMinutes: 20 },
    ]);
    expect(energy.severity).toBe("critical");
    expect(energy.recommendations.join(" ")).toContain("空转");
  });
});
