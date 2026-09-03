import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { PlantLiteEquipmentEvidence } from "./PlantLiteEquipmentEvidence";

describe("PlantLiteEquipmentEvidence", () => {
  it("shows measured utilization and downtime intervals for station equipment", () => {
    const result = fixture();
    const html = renderToStaticMarkup(<PlantLiteEquipmentEvidence result={result} />);
    expect(html).toContain("设备可靠性");
    expect(html).toContain("装配设备");
    expect(html).toContain("74.0% 计划利用率");
    expect(html).toContain("计划利用率 95% CI 70.0%–78.0%");
    expect(html).toContain("故障损失 18.0 台·分 · 95% CI 12.0–24.0");
  });

  it("does not add an empty result block when the model has no station equipment", () => {
    const result = fixture();
    result.model!.resources = result.model!.resources!.filter((resource) => resource.kind !== "equipment");
    expect(renderToStaticMarkup(<PlantLiteEquipmentEvidence result={result} />)).toBe("");
  });
});

function fixture(): PlantLiteStudyRecord {
  const model = createAgvLinePlantLiteModel();
  model.resources!.push({ id: "assembly-equipment", name: "装配设备", kind: "equipment", capacity: 2, power: { activePowerKw: 18, idlePowerKw: 2.2 } });
  const station = model.nodes.find((node) => node.id === "station-a");
  if (!station || station.kind !== "station") throw new Error("missing fixture station");
  delete station.power;
  station.resourceId = "assembly-equipment";
  const interval = (mean: number, lower95: number, upper95: number) => ({ mean, lower95, upper95, sampleStandardDeviation: 0.1, samples: 12 });
  return {
    id: "study", projectId: "project", name: "设备可靠性", createdAt: "2026-09-03T00:00:00Z", templateId: "agv-line-v1",
    model, seed: "fixed", replications: 12, inputFingerprint: "input",
    outcome: {
      status: "completed", completedReplications: 12,
      throughputPerHour: interval(40, 39, 41), averageWip: interval(3, 2, 4), averageLeadTimeMinutes: interval(5, 4, 6),
      resourceUtilization95: { "assembly-equipment": interval(.74, .7, .78) },
      resourceFailedMinutes95: { "assembly-equipment": interval(18, 12, 24) }, bottlenecks: [],
    },
    execution: { engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "input", deterministic: true, limits: { durationMinutes: 480, maxEvents: 100_000, maxResources: 100 } },
  };
}
