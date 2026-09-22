import { expect, it } from "vitest";
import { assertDashboardDocument, type DashboardDataWidgetNode } from "@bim-studio/contracts";
import { sha256Bytes } from "@bim-studio/deep-engine/shader-package";
import { runtimeContentSha256, validateDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import source from "../../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { compileDashboardRasterContent } from "./compileDashboardRasterContent";
import type { DashboardRasterCompileInput, DashboardRasterHost } from "./dashboardRasterTypes";

function fixture(count = 25) {
  const document: unknown = structuredClone(source); assertDashboardDocument(document);
  const filter: DashboardDataWidgetNode = { id: "filter", kind: "data-widget", zIndex: 2, frame: { x: 20, y: 20, width: 200, height: 90 },
    widget: { type: "filter", key: "region", title: "Region", unit: "", options: Array.from({ length: count }, (_, i) => `R${i}`) } };
  const chart: DashboardDataWidgetNode = { id: "chart", kind: "data-widget", zIndex: 1, frame: { x: 260, y: 20, width: 640, height: 360 },
    widget: { type: "bar", key: "value", title: "Value", unit: "", field: "value", analysis: { dimensionField: "region", measureField: "value", aggregation: "sum" } } };
  document.application.pages = [document.application.pages[0]!]; document.application.pages[0]!.nodes = [filter, chart];
  const bytes = new Uint8Array([1, 2, 3]), metric = { samples: [], rows: [{ region: "R0", value: 3 }] };
  const input: DashboardRasterCompileInput = { document, packageId: "select.fixture", packageVersion: "1.0.0", locale: "zh-CN",
    assets: { font: { bytes, sha256: sha256Bytes(bytes), mime: "font/ttf", identity: { id: "test-font", revision: 1 }, faceIndex: 0 } },
    nodeAssets: { filter: { fonts: ["font"], textStyle: { fontSize: 12, fontWeight: 400, fontStyle: "normal", lineHeight: 14, color: [255, 255, 255, 255], align: "left" } } },
    data: { chart: { source: { kind: "sample", id: "sample", revision: 1, contentSha256: runtimeContentSha256(metric) }, metric } } };
  const requests: string[] = [];
  // 编译编排证据，不作为真实字体或Native窗口画面证据。
  const host: DashboardRasterHost = { decodeImage: async () => { throw new Error("unused"); }, rasterizeText: async request => {
    requests.push(request.text);
    const rgba = new Uint8Array(request.width * request.height * 4), sha256 = sha256Bytes(rgba);
    const long = request.text.length > 12;
    return { ...request, rgba, sha256, sourceSha256: "a".repeat(64), format: "rgba8unorm-srgb", alphaMode: "straight",
      producer: { id: "orchestration-test", version: "1" }, producerEvidence: { scope: "native-text-raster", sourceSha256: "a".repeat(64), pixelSha256: sha256, executableSha256: "b".repeat(64), producer: "orchestration-test" },
      usedFaces: [{ sha256: request.fonts[0]!.sha256, faceIndex: 0, family: "Test", postScriptName: "Test", weight: 400, style: "normal" }],
      lines: Array.from({ length: long ? 2 : 1 }, (_, i) => ({ lineIndex: i, baseline: i * 14 + 10, top: i * 14, height: 14, width: 20 })), clipped: long && request.height < 100 };
  } };
  return { input, filter, host, requests };
}
it("production compiler keeps all 25 option identities and emits the new bounded select profile", async () => {
  const f = fixture(), result = await compileDashboardRasterContent(f.input, f.host);
  expect(validateDeepRuntimePackage(result.package).valid).toBe(true);
  const doc = result.package.payloads[result.package.entrypoints.dashboard!] as any;
  expect(doc.filter.presentation).toEqual({ kind: "select-v1", rowHeight: 32, visibleRows: 8 });
  expect(doc.filter.options).toHaveLength(25);
  const node = doc.pages[0].nodes.find((node: any) => node.id === doc.filter.nodeId);
  const content = result.package.payloads[node.deep2d] as any;
  expect(content.quads.map((quad: any) => quad.zOrder)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  expect(content.quads.every((quad: any) => quad.destination[1] === 17)).toBe(true);
});
it("long labels keep exact values, compile measured ellipsis and a full-label tooltip", async () => {
  const f = fixture(2); f.filter.widget.options![1] = "Long label which must retain its exact authored value";
  const result = await compileDashboardRasterContent(f.input, f.host);
  expect(validateDeepRuntimePackage(result.package).valid).toBe(true);
  const doc = result.package.payloads[result.package.entrypoints.dashboard!] as any;
  expect(doc.filter.options[1].value).toBe(f.filter.widget.options![1]);
  const node = doc.pages[0].nodes.find((node: any) => node.id === doc.filter.nodeId);
  expect((result.package.payloads[node.deep2d] as any).quads.some((q: any) => q.zOrder === 1002)).toBe(true);
  expect(f.requests.some(text => text.endsWith("…"))).toBe(true);
});
it("unsupported budgets remain blocked and cannot display an overlapping option pool", async () => {
  const f = fixture(257), result = await compileDashboardRasterContent(f.input, f.host);
  const doc = result.package.payloads[result.package.entrypoints.dashboard!] as any;
  expect(doc.filter).toBeUndefined();
  const report = result.capabilityReport.objects.find((item: any) => item.nodeId === "filter");
  expect(report?.contentCompiled).toBe(false);
});

it("compiles text plus a different-dimension select with original aggregate values", async () => {
  const f = fixture(2);
  f.filter.widget.key = "kind"; f.filter.widget.options = ["all", "A"];
  const text = { ...structuredClone(f.filter), id: "text", frame: { ...f.filter.frame, y: 120 },
    widget: { ...f.filter.widget, key: "region", filterMode: "text" as const } };
  f.input.document.application.pages[0]!.nodes.push(text);
  f.input = { ...f.input, nodeAssets: { ...f.input.nodeAssets, text: f.input.nodeAssets.filter! } };
  const metric = { samples: [], rows: [{ region: "R0", kind: "A", value: 3 }, { region: "R0", kind: "B", value: 4 }, { region: "R1", kind: "B", value: 9 }] };
  f.input = { ...f.input, data: { chart: { source: { kind: "sample", id: "sample", revision: 1, contentSha256: runtimeContentSha256(metric) }, metric } } };
  const result = await compileDashboardRasterContent(f.input, f.host);
  const doc = result.package.payloads[result.package.entrypoints.dashboard!] as any;
  expect(doc.textInput.bindings[0].rows).toEqual([["R0", 7], ["R1", 9]]);
  expect(doc.filter.options[1].updates[0].datasets[0].rows).toEqual([["R0", 3]]);
  expect(validateDeepRuntimePackage(result.package).valid).toBe(true);
  expect(result.capabilityReport.objects.filter(item => ["filter", "text"].includes(item.nodeId)).every(item => item.contentCompiled)).toBe(true);
});

it("does not mark an unsupported filter compiled just because a text input is supported", async () => {
  const f = fixture(2);
  const second = { ...structuredClone(f.filter), id: "other", widget: { ...f.filter.widget, key: "other" } };
  const text = { ...structuredClone(f.filter), id: "text", frame: { ...f.filter.frame, y: 120 },
    widget: { ...f.filter.widget, key: "region-text", filterField: "region", filterMode: "text" as const } };
  f.input.document.application.pages[0]!.nodes.push(second, text);
  f.input = { ...f.input, nodeAssets: { ...f.input.nodeAssets, other: f.input.nodeAssets.filter!, text: f.input.nodeAssets.filter! } };
  const result = await compileDashboardRasterContent(f.input, f.host);
  expect(result.capabilityReport.objects.filter(item => ["filter", "other"].includes(item.nodeId)).every(item => item.status === "blocked")).toBe(true);
  expect(result.capabilityReport.objects.find(item => item.nodeId === "text")?.contentCompiled).toBe(true);
});
