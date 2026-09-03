import { renderToStaticMarkup } from "react-dom/server";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  PlantLiteCalibrationResult,
  PlantLiteRealDataCalibration,
  suggestPlantLiteCalibrationMapping,
} from "./PlantLiteRealDataCalibration";
import type { PlantLiteCalibrationEvidence } from "./plantLiteCalibrationEvidence";

describe("PlantLiteRealDataCalibration", () => {
  it("keeps the workflow compact and states that calibration never rewrites the model", () => {
    const html = renderToStaticMarkup(<PlantLiteRealDataCalibration
      study={{ id: "study-1" } as PlantLiteStudyRecord}
      datasets={[]}
      loadPreview={vi.fn()}
    />);
    expect(html).toContain("现场数据校准");
    expect(html).toContain("用数据中心样本校核，不自动调参");
    expect(html).toContain("数据中心暂无数据集");
    expect(html).not.toContain("自动拟合");
  });

  it("renders measured values, errors, sample counts, source fingerprint, and four-state outcomes", () => {
    const evidence = {
      status: "conditional",
      study: { id: "study-1", inputFingerprint: "sha256:input", modelFingerprint: "sha256:model" },
      source: {
        datasetId: "dataset-1", datasetName: "MES 班次实绩", connectionId: "connection-1",
        datasetUpdatedAt: "2026-09-03T00:00:00.000Z", previewDurationMs: 12, previewRowCount: 20,
        windowRowCount: 12, snapshotFingerprint: "fnv1a64-canonical-v1:1234567890abcdef",
        fingerprintAlgorithm: "fnv1a64-canonical-v1",
      },
      mapping: {
        timestampField: "at",
        throughputPerHour: { field: "throughput", unit: "item-per-hour", tolerancePercent: 5 },
        averageWip: { field: "wip", unit: "item", tolerancePercent: 10 },
        averageLeadTimeMinutes: { field: "lead", unit: "minute", tolerancePercent: 10 },
      },
      window: { startInclusive: "2026-09-03T00:00:00.000Z", endInclusive: "2026-09-03T08:00:00.000Z", minimumSamples: 3 },
      metrics: [
        metric("throughputPerHour", "item-per-hour", "conditional", 53, 60, 13.2),
        metric("averageWip", "item", "passed", 10, 10, 0),
        metric("averageLeadTimeMinutes", "minute", "failed", 20, 30, 50),
      ],
      issues: [],
      evidenceFingerprint: "fnv1a64-canonical-v1:abcdef1234567890",
      declaration: "现场数据仅用于验证本次仿真结果；未自动修改模型参数。",
    } satisfies PlantLiteCalibrationEvidence;
    const html = renderToStaticMarkup(<PlantLiteCalibrationResult evidence={evidence} />);
    expect(html).toContain("有条件");
    expect(html).toContain("实测 53 件/时");
    expect(html).toContain("误差 13.2% / 5%");
    expect(html).toContain("n=12");
    expect(html).toContain("fnv1a64-canonical-v1:1234567890abcdef");
    expect(html).toContain("fnv1a64-canonical-v1:abcdef1234567890");
    expect(html).toContain("证据追溯");
    expect(html).toContain("失败");
    expect(html).toContain("未自动修改模型参数");
  });

  it("suggests only typed calibration fields and never reuses one metric column", () => {
    const mapping = suggestPlantLiteCalibrationMapping([
      { key: "recorded_at", label: "采集时间", type: "datetime" },
      { key: "hourly_output", label: "小时产量", type: "number", unit: "件/时" },
      { key: "wip_avg", label: "平均在制品", type: "number", unit: "件" },
      { key: "lead_time_min", label: "交付周期", type: "number", unit: "min" },
      { key: "device_id", label: "设备", type: "string" },
    ]);

    expect(mapping.timestampField).toBe("recorded_at");
    expect(mapping.throughputPerHour.field).toBe("hourly_output");
    expect(mapping.averageWip.field).toBe("wip_avg");
    expect(mapping.averageLeadTimeMinutes.field).toBe("lead_time_min");
    expect(new Set([
      mapping.throughputPerHour.field,
      mapping.averageWip.field,
      mapping.averageLeadTimeMinutes.field,
    ]).size).toBe(3);
  });

  it("does not guess metrics from unrelated numeric telemetry", () => {
    const mapping = suggestPlantLiteCalibrationMapping([
      { key: "recorded_at", label: "采集时间", type: "datetime" },
      { key: "temperature", label: "温度", type: "number", unit: "°C" },
      { key: "pressure", label: "压力", type: "number", unit: "kPa" },
      { key: "speed", label: "转速", type: "number", unit: "rpm" },
    ]);

    expect(mapping.timestampField).toBe("recorded_at");
    expect(mapping.throughputPerHour.field).toBe("");
    expect(mapping.averageWip.field).toBe("");
    expect(mapping.averageLeadTimeMinutes.field).toBe("");
  });
});

function metric(
  key: "throughputPerHour" | "averageWip" | "averageLeadTimeMinutes",
  unit: "item-per-hour" | "item" | "minute",
  status: "passed" | "conditional" | "failed",
  measuredMean: number,
  simulatedMean: number,
  relativeErrorPercent: number,
) {
  return {
    key,
    field: key,
    sourceUnit: unit,
    canonicalUnit: unit,
    tolerancePercent: key === "throughputPerHour" ? 5 : 10,
    sampleCount: 12,
    rejectedSampleCount: 0,
    measuredMean,
    simulatedMean,
    simulated95: { lower: simulatedMean - 2, upper: simulatedMean + 2, samples: 12 },
    absoluteError: Math.abs(measuredMean - simulatedMean),
    relativeErrorPercent,
    status,
    reason: "测试证据",
  } as const;
}
