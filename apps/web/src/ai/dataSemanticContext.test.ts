import type { DataDatasetRecord } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { buildAskDataSemanticContext } from "./dataSemanticContext";

describe("buildAskDataSemanticContext", () => {
  it("maps only the small set of industrial roles and preserves unresolved fields", () => {
    const context = buildAskDataSemanticContext([dataset([
      { key: "recorded_at", label: "采集时间", type: "datetime" },
      { key: "device_id", label: "设备编号", type: "string" },
      { key: "temperature", label: "温度", type: "number", unit: "℃" },
      { key: "operator_note", label: "备注", type: "string" }
    ])]);

    expect(context.datasets[0]?.fields).toEqual([
      expect.objectContaining({ key: "recorded_at", role: "time" }),
      expect.objectContaining({ key: "device_id", role: "device" }),
      expect.objectContaining({ key: "temperature", role: "metric", unit: "℃" })
    ]);
    expect(context.datasets[0]?.unresolvedFields).toEqual(["operator_note"]);
    expect(context.decisionBoundary).toContain("未知字段不得执行");
  });

  it("does not create datasets or relations that are absent from the project", () => {
    const context = buildAskDataSemanticContext([]);
    expect(context.datasets).toEqual([]);
    expect(context.relationTypes).toHaveLength(4);
  });

  it("leaves an ambiguous composite field unresolved instead of guessing", () => {
    const context = buildAskDataSemanticContext([dataset([
      { key: "device_temperature", label: "设备温度", type: "number", unit: "℃" }
    ])]);
    expect(context.datasets[0]?.fields).toEqual([]);
    expect(context.datasets[0]?.unresolvedFields).toEqual(["device_temperature"]);
  });
});

function dataset(fields: DataDatasetRecord["fields"]): DataDatasetRecord {
  return {
    id: "metrics",
    projectId: "project",
    connectionId: "connection",
    name: "设备运行指标",
    refreshSeconds: 5,
    fields,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z"
  };
}
