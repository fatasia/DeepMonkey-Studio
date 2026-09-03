import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { diagnosePlantLiteBottleneck } from "./plantLiteBottleneckDiagnosis";

describe("Plant Lite bottleneck diagnosis", () => {
  it("does not recommend adding upstream capacity when downstream blocking dominates", () => {
    const result = study({ blocked: 80, starved: 2, utilization: .72 });
    const diagnosis = diagnosePlantLiteBottleneck(result)!;
    expect(diagnosis.classification).toBe("downstream-blocked");
    expect(diagnosis.evidence).toContain("阻塞 80 分钟");
    expect(diagnosis.action).toContain("避免直接给当前节点加产能");
  });

  it("distinguishes upstream starvation from an actual process-capacity candidate", () => {
    expect(diagnosePlantLiteBottleneck(study({ blocked: 1, starved: 55, utilization: .4 }))?.classification).toBe("upstream-starved");
    expect(diagnosePlantLiteBottleneck(study({ blocked: 1, starved: 2, utilization: .95 }))?.classification).toBe("process-capacity");
  });
});

function study(values: { blocked: number; starved: number; utilization: number }): PlantLiteStudyRecord {
  const interval = (mean: number) => ({ mean, lower95: mean, upper95: mean, sampleStandardDeviation: 0, samples: 12 });
  return {
    id: "study", projectId: "project", createdAt: "2026-09-03T00:00:00.000Z", name: "line", templateId: "agv-line-v1",
    seed: 1, replications: 12, inputFingerprint: "input",
    model: {
      id: "line", name: "line", edges: [], resources: [],
      nodes: [{ id: "station", name: "装配工位", kind: "station", processingTime: { kind: "deterministic", value: 1 }, capacity: 1 }],
    },
    outcome: {
      status: "completed", completedReplications: 12,
      throughputPerHour: interval(60), averageWip: interval(2), averageLeadTimeMinutes: interval(3),
      nodeMetrics95: { station: { utilization: interval(values.utilization), averageQueueLength: interval(1), blockedMinutes: interval(values.blocked), starvedMinutes: interval(values.starved) } },
      resourceUtilization95: {}, bottlenecks: [{ nodeId: "station", occurrences: 12, probability: 1 }],
    },
    execution: { engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "input", deterministic: true, limits: { durationMinutes: 480, warmupMinutes: 0, maxEvents: 100_000, maxResources: 100 } },
  };
}
