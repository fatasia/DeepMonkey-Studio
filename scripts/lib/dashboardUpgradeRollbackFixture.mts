import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DashboardDataWidgetNode } from "../../packages/contracts/src/index.ts";
import { assertDashboardDocument } from "../../packages/contracts/src/index.ts";
import type { createApiServer } from "../../apps/api/src/serverOptions.js";

export interface ChainVersion {
  readonly id: string;
  readonly packageVersion: string;
  readonly banner: string;
  readonly barRows: readonly (readonly [string, number])[];
  readonly kpiRows: readonly (readonly [string, number])[];
  readonly pageBackground?: string;
}

export const V2: ChainVersion = {
  id: "v2", packageVersion: "1.0.1", banner: "冷热电联供园区运行总览·检修二版",
  barRows: [["华东", 91], ["华北", 37], ["华南", 24]], kpiRows: [["华东", 91], ["华北", 37]],
  pageBackground: "#0e2f45",
};

export const V3: ChainVersion = {
  id: "v3", packageVersion: "1.0.2", banner: "冷热电联供园区运行总览·检修三版",
  barRows: [["华东", 24], ["华北", 58], ["华南", 91]], kpiRows: [["华东", 24], ["华北", 58]],
  pageBackground: "#3a1230",
};

function chainNodes(version: ChainVersion): DashboardDataWidgetNode[] {
  const panel = { backgroundColor: "#172126", backgroundOpacity: 0.86 };
  const barRows = version.barRows.map(([region, value]) => ({ region, value }));
  const kpiRows = version.kpiRows.map(([region, value]) => ({ region, value }));
  return [
    { id: "mc-text", kind: "data-widget", zIndex: 0, frame: { x: 20, y: 16, width: 920, height: 72 },
      widget: { type: "text", title: version.banner, content: version.banner,
        key: "banner.title", unit: "", fontSize: 22, textColor: "#eef2f4", textAlign: "left" } },
    { id: "mc-kpi", kind: "data-widget", zIndex: 1, frame: { x: 20, y: 100, width: 224, height: 132 },
      widget: { type: "value", title: "总有功功率", key: "kpi.power", unit: "MW", field: "value", fontSize: 20,
        ...panel, analysis: { measureField: "value", aggregation: "maximum" },
        sampleData: { sourceId: "mc-kpi-samples", rows: kpiRows } } },
    { id: "mc-filter", kind: "data-widget", zIndex: 2, frame: { x: 20, y: 244, width: 224, height: 286 },
      widget: { type: "filter", title: "区域筛选", key: "filter.region", unit: "",
        options: ["全部区域", "华东", "华北", "华南"], filterMode: "select", filterField: "region", ...panel } },
    { id: "mc-bar", kind: "data-widget", zIndex: 3, frame: { x: 256, y: 100, width: 440, height: 430 },
      widget: { type: "bar", title: "分区域出力", key: "bar.output", unit: "MW", field: "value", fontSize: 18,
        analysis: { dimensionField: "region", measureField: "value", aggregation: "sum" },
        sampleData: { sourceId: "mc-bar-samples", rows: barRows } } },
    { id: "mc-table", kind: "data-widget", zIndex: 4, frame: { x: 708, y: 100, width: 232, height: 430 },
      widget: { type: "table", title: "机组运行表", key: "table.rows", unit: "", ...panel,
        report: { mode: "detail", rowField: "机组", valueFields: ["出力(MW)", "状态"], aggregation: "none",
          showRowNumbers: true, stripedRows: true },
        analysis: { dimensionField: "机组", measureField: "出力(MW)", aggregation: "none" },
        sampleData: { sourceId: "mc-table-samples", rows: [
          { "机组": "1号燃机", "出力(MW)": 42.5, "状态": "运行" }, { "机组": "2号燃机", "出力(MW)": 38.2, "状态": "运行" },
          { "机组": "储能", "出力(MW)": 12, "状态": "充电" }, { "机组": "余热锅炉", "出力(MW)": 0, "状态": "检修" }] } } },
  ];
}

export async function buildVersionDocument(version: ChainVersion, projectId: string) {
  const document: unknown = JSON.parse(await readFile(
    new URL("../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json", import.meta.url), "utf8"));
  assertDashboardDocument(document);
  document.application.metadata.id = `upgrade-chain-${version.id}-${randomUUID()}`;
  document.application.metadata.projectId = projectId;
  document.application.metadata.name = `升级回滚链 ${version.id}`;
  document.application.scripts = []; document.application.interactions = []; document.application.scenes = [];
  const page = document.application.pages[0]!;
  page.width = 960; page.height = 540;
  if (version.pageBackground) page.appearance = { backgroundColor: version.pageBackground };
  page.nodes = chainNodes(version);
  document.application.pages = [page];
  assertDashboardDocument(document);
  return document;
}

/** Real loopback HTTP session with per-request cancellation for upgrade-chain fault injection. */
export async function acceptanceHttp(app: ReturnType<typeof createApiServer>) {
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const call = async ({ method, url, payload, signal }: {
    method: string; url: string; payload?: unknown; signal?: AbortSignal }) => {
    if (!url.startsWith("/api/") || url.startsWith("//")) throw new Error("Acceptance request must stay on its local API");
    const response = await fetch(`${origin}${url}`, { method,
      ...(payload === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
      signal: signal ?? AbortSignal.timeout(120_000), redirect: "error" });
    const rawPayload = Buffer.from(await response.arrayBuffer());
    return { statusCode: response.status, headers: Object.fromEntries(response.headers), rawPayload,
      body: rawPayload.toString("utf8"), json: () => JSON.parse(rawPayload.toString("utf8")) };
  };
  return { origin, call, close: () => app.close() };
}
