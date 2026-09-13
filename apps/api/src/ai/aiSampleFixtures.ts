import type { MaintenanceDeploymentRecord, MaintenanceModelPackage } from "@bim-studio/contracts";

export function maintenanceSample(projectId: string) {
  const timestamp = "2026-09-09T00:00:00.000Z";
  const model: MaintenanceModelPackage = {
    id: "sample-maintenance-v1", projectId, name: "设备温振样例", version: "1",
    algorithm: "linear", source: "imported", status: "candidate", benchmarkOnly: true,
    productionEligible: false, evaluationProtocol: "shadow", dataFingerprint: "builtin-temperature-vibration-v1",
    trainRows: 0, validationRows: 0, metrics: {},
    artifact: { engine: "native-json", modelKind: "failure-probability", features: ["temperature", "vibration"], means: [50, 2], stds: [5, 1], weights: [1, 1], bias: -2, decisionThreshold: 0.5 },
    gates: { minimumSamples: 30, minimumDataQuality: 0.9, maximumDriftSigma: 5, warningThreshold: 0.45, criticalThreshold: 0.7, scoreDirection: "high-risk" },
    createdAt: timestamp, updatedAt: timestamp,
  };
  const deployment: MaintenanceDeploymentRecord = {
    id: "sample-deployment-v1", projectId, name: "设备温振样例", modelId: model.id,
    equipmentId: "sample-drive", maintainableUnitId: "sample-bearing", objectIds: [], sourceId: "builtin-sample",
    featureMappings: {}, sampleIntervalSec: 60, windowSize: 30, enabled: false, status: "shadow",
    createdAt: timestamp, updatedAt: timestamp,
  };
  const rows = Array.from({ length: 30 }, (_, index) => ({ temperature: 50 + index / 29 * 10, vibration: 2 + index / 29 * 1.2 }));
  return { model, deployment, rows };
}

export const energySampleRows = [
  { timestamp: "2026-09-09T00:00:00Z", output: 100, energyKwh: 50 },
  { timestamp: "2026-09-09T01:00:00Z", output: 100, energyKwh: 51 },
  { timestamp: "2026-09-09T02:00:00Z", output: 100, energyKwh: 49 },
  { timestamp: "2026-09-09T03:00:00Z", output: 100, energyKwh: 80, idleMinutes: 20 },
];
