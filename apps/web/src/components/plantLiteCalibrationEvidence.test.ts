import type { DataDatasetPreview, DataDatasetRecord, PlantLiteStudyRecord } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import {
  buildPlantLiteCalibrationEvidence,
  plantLiteCalibrationWindowBounds,
  type PlantLiteCalibrationMapping,
} from "./plantLiteCalibrationEvidence";

const dataset: DataDatasetRecord = {
  id: "dataset-line-actuals",
  projectId: "project-1",
  connectionId: "connection-mes",
  name: "MES 班次实绩",
  sourceKey: "line_shift_metrics",
  refreshSeconds: 60,
  fields: [
    { key: "recorded_at", label: "采样时间", type: "datetime" },
    { key: "throughput_per_min", label: "分钟产出", type: "number", unit: "件/分钟" },
    { key: "wip", label: "平均在制", type: "number", unit: "件" },
    { key: "lead_hours", label: "平均交付周期", type: "number", unit: "小时" },
  ],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-03T01:00:00.000Z",
};

const mapping: PlantLiteCalibrationMapping = {
  timestampField: "recorded_at",
  throughputPerHour: { field: "throughput_per_min", unit: "item-per-minute", tolerancePercent: 10 },
  averageWip: { field: "wip", unit: "item", tolerancePercent: 10 },
  averageLeadTimeMinutes: { field: "lead_hours", unit: "hour", tolerancePercent: 10 },
};

describe("Plant Lite real-data calibration evidence", () => {
  it("maps explicit units, limits rows to the selected window, and returns auditable evidence", () => {
    const preview = createPreview([
      row("2026-09-02T07:00:00.000Z", 99, 99, 99),
      row("2026-09-02T08:00:00.000Z", 1, 10, .5),
      row("2026-09-02T09:00:00.000Z", 1.02, 9.5, .48),
      row("2026-09-02T10:00:00.000Z", .98, 10.5, .52),
    ]);
    const evidence = buildPlantLiteCalibrationEvidence({
      study: createStudy(), dataset, preview, mapping,
      window: { startInclusive: "2026-09-02T08:00:00.000Z", endInclusive: "2026-09-02T10:00:00.000Z" },
      minimumSamples: 3,
    });

    expect(evidence.status).toBe("passed");
    expect(evidence.source).toMatchObject({
      datasetId: dataset.id,
      datasetUpdatedAt: dataset.updatedAt,
      previewRowCount: 4,
      windowRowCount: 3,
      fingerprintAlgorithm: "fnv1a64-canonical-v1",
    });
    expect(evidence.metrics.map((metric) => [metric.key, metric.measuredMean, metric.sampleCount])).toEqual([
      ["throughputPerHour", 60, 3],
      ["averageWip", 10, 3],
      ["averageLeadTimeMinutes", 30, 3],
    ]);
    expect(evidence.evidenceFingerprint).toMatch(/^fnv1a64-canonical-v1:[a-f0-9]{16}$/);
    expect(evidence.declaration).toContain("未自动修改模型参数");
  });

  it("uses a conditional status only when the model interval overlaps the measured tolerance band", () => {
    const conditional = buildPlantLiteCalibrationEvidence({
      study: createStudy(), dataset,
      preview: createPreview([row("2026-09-02T08:00:00Z", 53 / 60, 10, .5), row("2026-09-02T09:00:00Z", 53 / 60, 10, .5), row("2026-09-02T10:00:00Z", 53 / 60, 10, .5)]),
      mapping: { ...mapping, throughputPerHour: { ...mapping.throughputPerHour, tolerancePercent: 5 } },
      window: { startInclusive: "2026-09-02T08:00:00Z", endInclusive: "2026-09-02T10:00:00Z" },
    });

    expect(conditional.status).toBe("conditional");
    expect(conditional.metrics[0]).toMatchObject({ status: "conditional", measuredMean: 53, simulatedMean: 60 });
    expect(conditional.metrics[0]?.relativeErrorPercent).toBeCloseTo(13.2075, 3);
  });

  it("fails when a completed model interval cannot meet the measured tolerance band", () => {
    const failed = buildPlantLiteCalibrationEvidence({
      study: createStudy(), dataset,
      preview: createPreview([row("2026-09-02T08:00:00Z", 40 / 60, 10, .5), row("2026-09-02T09:00:00Z", 40 / 60, 10, .5), row("2026-09-02T10:00:00Z", 40 / 60, 10, .5)]),
      mapping: { ...mapping, throughputPerHour: { ...mapping.throughputPerHour, tolerancePercent: 5 } },
      window: { startInclusive: "2026-09-02T08:00:00Z", endInclusive: "2026-09-02T10:00:00Z" },
    });

    expect(failed.status).toBe("failed");
    expect(failed.metrics[0]?.reason).toContain("不重叠");
  });

  it("reports stale previews and insufficient samples without inventing calibration", () => {
    const preview = createPreview([row("2026-09-02T08:00:00Z", 1, 10, .5), row("2026-09-02T09:00:00Z", 1, 10, .5)]);
    preview.dataset = { ...preview.dataset, updatedAt: "2026-09-02T00:00:00.000Z" };
    const insufficient = buildPlantLiteCalibrationEvidence({
      study: createStudy(), dataset, preview, mapping,
      window: { startInclusive: "2026-09-02T08:00:00Z", endInclusive: "2026-09-02T09:00:00Z" },
      minimumSamples: 3,
    });

    expect(insufficient.status).toBe("insufficient-data");
    expect(insufficient.issues).toEqual(["数据集定义已更新，请重新读取最新样本"]);
    expect(insufficient.metrics.every((metric) => metric.status === "insufficient-data")).toBe(true);
    expect(insufficient.study.inputFingerprint).toBe("sha256:study-input");
  });

  it("derives timestamp bounds and changes the snapshot fingerprint when mapped evidence changes", () => {
    const preview = createPreview([row("2026-09-02T10:00:00Z", 1, 10, .5), row("2026-09-02T08:00:00Z", 1, 10, .5), row("bad", 1, 10, .5)]);
    const window = plantLiteCalibrationWindowBounds(preview, "recorded_at");
    expect(window).toEqual({ startInclusive: "2026-09-02T08:00:00.000Z", endInclusive: "2026-09-02T10:00:00.000Z" });
    const first = buildPlantLiteCalibrationEvidence({ study: createStudy(), dataset, preview, mapping, window: window! });
    const changed = createPreview(preview.rows.map((value) => ({ ...value })));
    changed.rows[0]!.wip = 11;
    const second = buildPlantLiteCalibrationEvidence({ study: createStudy(), dataset, preview: changed, mapping, window: window! });
    expect(first.source.snapshotFingerprint).not.toBe(second.source.snapshotFingerprint);
  });
});

function row(recordedAt: string, throughputPerMin: number, wip: number, leadHours: number) {
  return { recorded_at: recordedAt, throughput_per_min: throughputPerMin, wip, lead_hours: leadHours };
}

function createPreview(rows: Array<Record<string, unknown>>): DataDatasetPreview {
  return { dataset: structuredClone(dataset), fields: structuredClone(dataset.fields), rows, durationMs: 24 };
}

function createStudy(): PlantLiteStudyRecord {
  const interval = (mean: number, lower95: number, upper95: number) => ({ mean, lower95, upper95, sampleStandardDeviation: 2, samples: 12 });
  return {
    id: "study-1", projectId: "project-1", name: "两工位基线", createdAt: "2026-09-03T02:00:00.000Z",
    templateId: "agv-line-v1", modelFingerprint: "sha256:model", seed: "fixed", replications: 12,
    inputFingerprint: "sha256:study-input",
    outcome: {
      status: "completed", completedReplications: 12,
      throughputPerHour: interval(60, 55, 65), averageWip: interval(10, 9.2, 10.8),
      averageLeadTimeMinutes: interval(30, 28, 32), resourceUtilization95: {}, bottlenecks: [],
    },
    execution: {
      engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "sha256:study-input", deterministic: true,
      limits: { durationMinutes: 480, maxEvents: 100_000, maxResources: 100 },
    },
  };
}
