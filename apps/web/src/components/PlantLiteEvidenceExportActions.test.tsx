import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlantLiteEvidenceExportActions } from "./PlantLiteEvidenceExportActions";

describe("PlantLiteEvidenceExportActions", () => {
  it("presents both compact exports and the selected baseline lineage", () => {
    const html = renderToStaticMarkup(<PlantLiteEvidenceExportActions study={study()} baseline={study({ id: "base", name: "量产基线" })} />);
    expect(html).toContain("工程证据包");
    expect(html).toContain("证据包 JSON");
    expect(html).toContain("指标 CSV");
    expect(html).toContain("含基线谱系 · 量产基线");
    expect(html).toContain("模型、统计与有界轨迹已就绪");
    expect(html).toContain("UTF-8 BOM");
  });

  it("keeps legacy export available while naming missing evidence", () => {
    const legacy = study();
    delete legacy.model;
    delete legacy.outcome.nodeMetrics95;
    delete legacy.trace;
    const html = renderToStaticMarkup(<PlantLiteEvidenceExportActions study={legacy} />);
    expect(html).toContain("旧记录可导出");
    expect(html).toContain("模型快照、节点区间、代表性轨迹");
    expect(html).toContain("未选择基线，仅导出当前 Study 谱系");
    expect(html).not.toContain("disabled");
  });
});

function study(overrides: Partial<PlantLiteStudyRecord> = {}): PlantLiteStudyRecord {
  const interval = { mean: 10, sampleStandardDeviation: 1, lower95: 9, upper95: 11, samples: 5 };
  return {
    id: "study", projectId: "project", name: "候选方案", createdAt: "2026-09-03T00:00:00Z",
    templateId: "agv-line-v1", modelFingerprint: "model", seed: "seed", replications: 5, inputFingerprint: "input",
    model: {
      id: "line", name: "line", nodes: [
        { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
        { id: "sink", name: "成品", kind: "sink" },
      ],
      edges: [{ id: "flow", from: "source", to: "sink" }],
    },
    trace: {
      engineId: "plant-lite-des", engineVersion: "1.0.0", replication: 0, seed: 1,
      events: [], capturedItemCount: 0, omittedEventCount: 0, truncated: false, limits: { maxEvents: 10, maxItems: 10 },
    },
    outcome: {
      status: "completed", completedReplications: 5, throughputPerHour: interval, averageWip: interval,
      averageLeadTimeMinutes: interval, nodeMetrics95: {}, resourceUtilization95: {}, bottlenecks: [],
    },
    execution: {
      engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "input", deterministic: true,
      limits: { durationMinutes: 60, maxEvents: 1000, maxResources: 10 },
      trace: { replication: 0, maxEvents: 10, maxItems: 10 },
    },
    ...overrides,
  };
}
