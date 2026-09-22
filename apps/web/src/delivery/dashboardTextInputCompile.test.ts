import { expect, it } from "vitest";
import { assertDashboardDocument, type DashboardDataWidgetNode } from "@bim-studio/contracts";
import { runtimeContentSha256, validateDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { sha256Bytes } from "@bim-studio/deep-engine/shader-package";
import source from "../../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { compileDashboardTextInput } from "./dashboardTextInputCompile";
import { compileDashboardRasterContent } from "./compileDashboardRasterContent";
import type { DashboardRasterCompileInput, DashboardRasterHost } from "./dashboardRasterTypes";

function fixture() {
  const document: unknown = structuredClone(source); assertDashboardDocument(document);
  document.application.scripts = []; document.application.interactions = [];
  const filter: DashboardDataWidgetNode = { id: "filter", kind: "data-widget", zIndex: 2,
    frame: { x: 0, y: 0, width: 180, height: 90 },
    widget: { type: "filter", title: "Region", key: "region", unit: "", filterMode: "text" } };
  const chart: DashboardDataWidgetNode = { id: "chart", kind: "data-widget", zIndex: 1,
    frame: { x: 200, y: 0, width: 640, height: 360 },
    widget: { type: "bar", title: "Output", key: "output", unit: "", field: "value",
      analysis: { dimensionField: "region", measureField: "value", aggregation: "sum" } } };
  document.application.pages = [document.application.pages[0]!]; document.application.pages[0]!.nodes = [filter, chart];
  const metric = { samples: [], rows: [{ region: "East", value: 3 }, { region: "West", value: 8 }, { region: "East", value: 4 }] };
  const bytes = new Uint8Array([1, 2, 3]);
  const input: DashboardRasterCompileInput = { document, packageId: "text-filter", packageVersion: "1.0.0", locale: "en-US",
    assets: { font: { bytes, sha256: sha256Bytes(bytes), mime: "font/ttf", identity: { id: "font", revision: 1 }, faceIndex: 0 } },
    nodeAssets: { filter: { fonts: ["font"], textStyle: { fontSize: 14, lineHeight: 20, fontWeight: 400, fontStyle: "normal", color: [255, 255, 255, 255], align: "left" } } },
    data: { chart: { source: { kind: "sample", id: "author", revision: 1, contentSha256: runtimeContentSha256(metric) }, metric } } };
  return { input, filter, chart };
}
const ids = new Map([["filter", `node.${"a".repeat(64)}`], ["chart", `node.${"b".repeat(64)}`]]);
it("freezes exact chart categories and font identities without rewriting author values", () => {
  const { input } = fixture();
  const result = compileDashboardTextInput(input, ids);
  expect(result.reason).toBeUndefined();
  expect(result.input?.bindings[0]?.rows).toEqual([["East", 7], ["West", 8]]);
  expect(result.input?.fonts[0]?.sha256).toBe(input.assets.font?.sha256);
});
it("keeps unsupported series, multiple filters and missing fonts blocked", () => {
  const { input, chart, filter } = fixture();
  chart.widget.analysis!.seriesField = "region";
  expect(compileDashboardTextInput(input, ids).input).toBeUndefined();
  delete chart.widget.analysis!.seriesField;
  input.document.application.pages[0]!.nodes.push({ ...filter, id: "second" });
  expect(compileDashboardTextInput(input, ids).input).toBeUndefined();
  input.document.application.pages[0]!.nodes.pop();
  expect(compileDashboardTextInput({ ...input, nodeAssets: {} }, ids).input).toBeUndefined();
});
it("links text input through the production dashboard compiler and package validator", async () => {
  const { input } = fixture();
  const host: DashboardRasterHost = { rasterizeText: async () => { throw new Error("no static text expected"); }, decodeImage: async () => { throw new Error("no image expected"); } };
  const compiled = await compileDashboardRasterContent(input, host);
  const dashboard = compiled.package.payloads[compiled.package.entrypoints.dashboard!] as any;
  expect(dashboard.textInput.kind).toBe("text-v1");
  expect(dashboard.pages[0].nodes.find((node: any) => node.id === dashboard.textInput.nodeId).hitId).toBe(dashboard.textInput.nodeId);
  expect(validateDeepRuntimePackage(compiled.package).valid).toBe(true);
});

it("publishes two independently keyed inputs through the production collection contract", async () => {
  const { input, filter } = fixture();
  const second = { ...structuredClone(filter), id: "filter-second", frame: { ...filter.frame, y: 100 },
    widget: { ...filter.widget, key: "region-second", filterField: "region" } };
  input.document.application.pages[0]!.nodes.push(second);
  const source = { ...input, nodeAssets: { ...input.nodeAssets, [second.id]: input.nodeAssets.filter! } };
  const host: DashboardRasterHost = { rasterizeText: async () => { throw new Error("no static text expected"); }, decodeImage: async () => { throw new Error("no image expected"); } };
  const result = await compileDashboardRasterContent(source, host);
  const dashboard = result.package.payloads[result.package.entrypoints.dashboard!] as any;
  expect(dashboard.textInput).toBeUndefined(); expect(dashboard.textInputs).toHaveLength(2);
  expect(dashboard.textInputs.map((input: any) => input.key)).toEqual(["region", "region-second"]);
  expect(validateDeepRuntimePackage(result.package).valid).toBe(true);
});
