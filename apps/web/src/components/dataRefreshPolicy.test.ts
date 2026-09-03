import type { DashboardDataWidgetConfig, DataDatasetRecord, DataPipelineDefinition } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { buildDashboardDataProductRefreshPlans, derivePipelineRefreshSeconds, normalizeDataRefreshSeconds } from "./dataRefreshPolicy";

const timestamp = "2026-09-03T00:00:00.000Z";
const dataset = (id: string, refreshSeconds: number): DataDatasetRecord => ({
  id,
  projectId: "project-1",
  connectionId: "connection-1",
  name: id,
  refreshSeconds,
  fields: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});
const pipeline = (id: string, sourceIds: readonly string[]): DataPipelineDefinition => ({
  id,
  projectId: "project-1",
  name: id,
  nodes: sourceIds.map((datasetId, index) => ({ id: `source-${index}`, type: "source", name: datasetId, datasetId, position: { x: 0, y: index * 80 } })),
  edges: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});
const widget = (patch: Partial<DashboardDataWidgetConfig>): DashboardDataWidgetConfig => ({ title: "指标", key: "value", unit: "", type: "value", ...patch });

describe("data refresh policy", () => {
  it("preserves manual refresh and clamps only positive schedules", () => {
    expect(normalizeDataRefreshSeconds(0)).toBe(0);
    expect(normalizeDataRefreshSeconds(1)).toBe(2);
    expect(normalizeDataRefreshSeconds(Number.NaN)).toBe(5);
  });

  it("derives a pipeline from the fastest scheduled source and keeps all-manual pipelines manual", () => {
    const datasets = [dataset("manual", 0), dataset("slow", 30), dataset("fast", 6)];
    expect(derivePipelineRefreshSeconds(pipeline("mixed", ["manual", "slow", "fast"]), datasets)).toBe(6);
    expect(derivePipelineRefreshSeconds(pipeline("manual-only", ["manual"]), datasets)).toBe(0);
  });

  it("creates one independent schedule per referenced data product", () => {
    const datasets = [dataset("manual", 0), dataset("fast", 3), dataset("slow", 20)];
    const pipelines = [pipeline("summary", ["slow"])];
    expect(
      buildDashboardDataProductRefreshPlans(
        [widget({ datasetId: "manual" }), widget({ datasetId: "fast" }), widget({ datasetId: "fast" }), widget({ pipelineId: "summary" })],
        datasets,
        pipelines,
      ),
    ).toEqual([
      { key: "dataset:manual", kind: "dataset", id: "manual", refreshSeconds: 0 },
      { key: "dataset:fast", kind: "dataset", id: "fast", refreshSeconds: 3 },
      { key: "pipeline:summary", kind: "pipeline", id: "summary", refreshSeconds: 20 },
    ]);
  });
});
