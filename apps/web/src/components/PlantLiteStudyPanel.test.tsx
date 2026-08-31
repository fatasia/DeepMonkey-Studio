import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { PlantLiteStudyPanel } from "./PlantLiteStudyPanel";

function record(overrides: Partial<PlantLiteStudyRecord> = {}): PlantLiteStudyRecord {
  const ci = { mean: 60, sampleStandardDeviation: 2, lower95: 58, upper95: 62, samples: 12 };
  return {
    id: "study-1", projectId: "project-1", name: "AGV 基线", createdAt: "2026-08-31T08:00:00.000Z",
    templateId: "agv-line-v1", agvCount: 4, bufferCapacity: 10, seed: "fixed", replications: 12, inputFingerprint: "input-1",
    outcome: { status: "completed", completedReplications: 12, throughputPerHour: ci, averageWip: { ...ci, mean: 3 }, averageLeadTimeMinutes: { ...ci, mean: 5 }, resourceUtilization95: { "agv-fleet": ci }, bottlenecks: [{ nodeId: "station-a", occurrences: 12, probability: 1 }] },
    execution: { engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "input-1", deterministic: true, limits: { durationMinutes: 480, maxEvents: 100000, maxResources: 12 } },
    ...overrides,
  };
}

describe("PlantLiteStudyPanel", () => {
  it("keeps the template first-run state focused", () => {
    const html = renderToStaticMarkup(<PlantLiteStudyPanel results={[]} busy={false} onReproduce={() => undefined} />);
    expect(html).toContain("AGV 两工位产线已经就绪");
    expect(html).not.toContain("对比基线");
  });

  it("shows confidence intervals and exact reproduction evidence", () => {
    const baseline = record();
    const html = renderToStaticMarkup(<PlantLiteStudyPanel results={[record({ id: "study-2", reproductionOf: baseline.id }), baseline]} busy={false} onReproduce={() => undefined} />);
    expect(html).toContain("95% CI");
    expect(html).toContain("复现校验通过");
    expect(html).toContain("精确复现基线");
  });

  it("does not overstate exact reproduction when a non-throughput metric differs", () => {
    const baseline = record();
    const changedWip = { ...baseline.outcome.averageWip, mean: 3.5 };
    const candidate = record({
      id: "study-2",
      reproductionOf: baseline.id,
      outcome: { ...baseline.outcome, averageWip: changedWip },
    });

    const html = renderToStaticMarkup(
      <PlantLiteStudyPanel results={[candidate, baseline]} busy={false} onReproduce={() => undefined} />,
    );
    expect(html).not.toContain("复现校验通过");
    expect(html).toContain("吞吐均值对比");
  });
});
