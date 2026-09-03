import type { DataDatasetRecord, DataPipelineDefinition } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DashboardDataRefreshSummary } from "./DashboardDataRefreshSummary";

const timestamp = "2026-09-03T00:00:00.000Z";
const datasets: DataDatasetRecord[] = [
  { id: "telemetry", projectId: "project-1", connectionId: "connection-1", name: "遥测", refreshSeconds: 12, fields: [], createdAt: timestamp, updatedAt: timestamp },
  { id: "manual", projectId: "project-1", connectionId: "connection-1", name: "台账", refreshSeconds: 0, fields: [], createdAt: timestamp, updatedAt: timestamp },
];
const pipelines: DataPipelineDefinition[] = [
  {
    id: "health",
    projectId: "project-1",
    name: "健康度",
    nodes: [{ id: "source", type: "source", name: "遥测", datasetId: "telemetry", position: { x: 0, y: 0 } }],
    edges: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  },
];

describe("DashboardDataRefreshSummary", () => {
  it("shows a pipeline's inherited cadence and the Data Center entry", () => {
    const html = renderToStaticMarkup(
      <DashboardDataRefreshSummary locale="zh-CN" kind="pipeline" productId="health" datasets={datasets} pipelines={pipelines} onOpenData={vi.fn()} />,
    );
    expect(html).toContain("定时更新 · 每 12 秒");
    expect(html).toContain("继承自源数据集");
    expect(html).toContain("数据中心");
  });

  it("labels a zero-second dataset as manual", () => {
    const html = renderToStaticMarkup(
      <DashboardDataRefreshSummary locale="zh-CN" kind="dataset" productId="manual" datasets={datasets} pipelines={pipelines} onOpenData={vi.fn()} />,
    );
    expect(html).toContain("手动更新");
    expect(html).not.toContain("每 0 秒");
  });
});
