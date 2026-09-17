import { describe, expect, it, vi } from "vitest";
import { assertDashboardDocument, type DashboardDocument, type DashboardDataWidgetNode } from "@bim-studio/contracts";
import { sha256Bytes } from "@bim-studio/deep-engine/shader-package";
import { runtimeContentSha256, validateDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import source from "../../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { compileDashboardRasterContent } from "./compileDashboardRasterContent";
import type { DashboardRasterCompileInput, DashboardRasterHost, DashboardTextRasterRequest, DashboardRasterResult } from "./dashboardRasterTypes";

function fixture(type: "text" | "image" | "value" | "shape" = "text"): DashboardRasterCompileInput {
  const document: unknown = structuredClone(source); assertDashboardDocument(document);
  document.application.scripts = []; document.application.interactions = [];
  const node: DashboardDataWidgetNode = { id: "sample", kind: "data-widget", zIndex: 7,
    frame: { x: 50, y: 60, width: 36, height: 36 },
    widget: { type, title: "标题", content: "", key: "sample", unit: "%", color: "#123456", borderWidth: 0 } };
  document.application.pages[0]!.nodes = [node];
  const bytes = new Uint8Array([1, 2, 3]);
  return { document: document as DashboardDocument, packageId: "test.dashboard", packageVersion: "1.0.0", locale: "zh-CN",
    assets: { font: { bytes, sha256: sha256Bytes(bytes), mime: "font/ttf", identity: { id: "licensed-font", revision: 1 }, faceIndex: 0 } },
    nodeAssets: { sample: { fonts: ["font"], image: "font", textStyle: { fontSize: 12, fontWeight: 400,
      fontStyle: "normal", lineHeight: 14, color: [1, 2, 3, 255], align: "left" } } } };
}
// Deliberate orchestration stub: these 2x2 pixels are not evidence of actual font shaping.
function host() {
  const calls: DashboardTextRasterRequest[] = [];
  const render = (request: { requestHash: string; width: number; height: number }): DashboardRasterResult => {
    const rgba = new Uint8Array(request.width * request.height * 4).fill(255);
    return { ...request, rgba, sha256: sha256Bytes(rgba), sourceSha256: "a".repeat(64),
      producer: { id: "orchestration-test-only", version: "1" }, format: "rgba8unorm-srgb", alphaMode: "straight" };
  };
  const adapter: DashboardRasterHost = { rasterizeText: vi.fn(async (request: DashboardTextRasterRequest): Promise<DashboardRasterResult> => { calls.push(request);
    const pixels = render(request);
    return { ...pixels, producerEvidence: { scope: "native-text-raster", sourceSha256: pixels.sourceSha256,
      pixelSha256: pixels.sha256, executableSha256: "b".repeat(64), producer: "orchestration-test-only" }, usedFaces: [{ sha256: request.fonts[0]!.sha256, faceIndex: 0, family: "Test",
      postScriptName: "Test", weight: 400, style: "normal" }], lines: [{ lineIndex: 0, baseline: 1, top: 0, height: 1, width: 2 }] };
  }), decodeImage: vi.fn(async request => render(request)) };
  return { adapter, calls };
}
function payload(result: Awaited<ReturnType<typeof compileDashboardRasterContent>>) {
  return Object.values(result.package.payloads).find((value: any) => value.schema === "deep-engine.deep2d-runtime") as any;
}
describe("frozen dashboard raster orchestration", () => {
  it("binds page image ownership into compilation identity and rejects invalid references", async () => {
    const input = fixture("shape"), pageId = input.document.application.pages[0]!.id;
    const { bytes, sha256, identity } = input.assets.font!;
    const asset = { bytes, sha256, identity, mime: "image/png" };
    const base = { ...input, assets: { image: asset }, nodeAssets: {} };
    const original = await compileDashboardRasterContent(base, host().adapter);
    const bound = await compileDashboardRasterContent({ ...base, pageAssets: { [pageId]: { image: "image" } } }, host().adapter);
    expect(bound.sourceSemanticHash).not.toBe(original.sourceSemanticHash);
    expect(bound.compileGraphHash).not.toBe(original.compileGraphHash);
    for (const pageAssets of [{ missing: { image: "image" } }, { [pageId]: { image: "missing" } }]) {
      await expect(compileDashboardRasterContent({ ...base, pageAssets }, host().adapter)).rejects.toThrow("page image binding");
    }
    await expect(compileDashboardRasterContent({ ...input, pageAssets: { [pageId]: { image: "font" } } }, host().adapter))
      .rejects.toThrow("page image binding");
  });
  it("keeps a non-first published entry page when compiling all pages", async () => {
    const input = fixture("shape"), second = structuredClone(input.document.application.pages[0]!);
    second.id = "second-page"; second.nodes[0]!.id = "second-shape";
    input.document.application.pages.push(second);
    const result = await compileDashboardRasterContent({ ...input,
      document: { ...input.document, entryPageId: second.id } }, host().adapter);
    const dashboard = result.package.payloads[result.package.entrypoints.dashboard!] as any;
    expect(dashboard.pages).toHaveLength(2);
    expect(dashboard.entryPageId).toBe(dashboard.pages[1].id);
    expect(result.nodeBindings.map(binding => binding.pageId)).toEqual([input.document.application.pages[0]!.id, second.id]);
    expect(validateDeepRuntimePackage(result.package).valid).toBe(true);
  });
  it("compiles the Web page background color beneath every authored node", async () => {
    const input = fixture();
    input.document.application.pages[0]!.appearance = {
      backgroundColor: "#80808080", backgroundImageUrl: "/frozen/background.png", backgroundImageFit: "cover",
    };
    const result = await compileDashboardRasterContent(input, host().adapter);
    const dashboard = result.package.payloads[result.package.entrypoints.dashboard!] as any;
    const page = dashboard.pages[0];
    expect(page.nodes[0]).toMatchObject({ zOrder: 0, frame: [0, 0, page.width, page.height], chart: null });
    expect(page.nodes[1].zOrder).toBe(1);
    const background = result.package.payloads[page.nodes[0].deep2d] as any;
    expect(background.displayList.commands[0]).toMatchObject({
      kind: "path", fill: [0.21586050011389926, 0.21586050011389926, 0.21586050011389926, 128 / 255],
    });
    expect(result.deferredPageFields[0]!.fields).not.toContain("appearance.backgroundColor");
    expect(result.deferredPageFields[0]!.fields).toContain("appearance.backgroundImageUrl");
    expect(result.compileGraphHash).not.toBe(runtimeContentSha256({ sourceSemanticHash: result.sourceSemanticHash,
      pass: "dashboard-frozen-raster-v3", producerEvidence: result.producerEvidence }));
    expect(validateDeepRuntimePackage(result.package).valid).toBe(true);
  });

  it("keeps non-hex page color explicit instead of inventing Native pixels", async () => {
    const input = fixture();
    input.document.application.pages[0]!.appearance = { backgroundColor: "var(--surface-1)" };
    const result = await compileDashboardRasterContent(input, host().adapter);
    const dashboard = result.package.payloads[result.package.entrypoints.dashboard!] as any;
    expect(dashboard.pages[0].nodes).toHaveLength(1);
    expect(result.deferredPageFields[0]!.fields).toContain("appearance.backgroundColor");
  });

  it("uses actual title fallback, local pixels, stable layout and a valid C1 package", async () => {
    const input = fixture(), runtime = host();
    const result = await compileDashboardRasterContent(input, runtime.adapter);
    expect(runtime.calls[0]).toMatchObject({ text: "标题", verticalAlign: "center", width: 2, height: 2 });
    expect(result.publicationReady).toBe(false);
    expect(result.nodeBindings[0]).toMatchObject({ nodeId: "sample", runtimeNodeId: expect.stringMatching(/^node\.[a-f0-9]{64}$/) });
    expect(validateDeepRuntimePackage(result.package).valid).toBe(true);
    expect(payload(result).displayList.commands[0].transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(payload(result).quads[0].destination).toEqual([17, 17, 2, 2]);
    expect(result.capabilityReport.contentCompiled).toBe(1);
    expect(result.producerEvidence[0]!.usedFaces[0]!.faceIndex).toBe(0);
    expect((await compileDashboardRasterContent(input, host().adapter)).targetArtifactHash).toBe(result.targetArtifactHash);
  });
  it("uses image fit and verifies complete pixels", async () => {
    const runtime = host(), result = await compileDashboardRasterContent(fixture("image"), runtime.adapter);
    expect(runtime.adapter.decodeImage).toHaveBeenCalledWith(expect.objectContaining({ fit: "cover", width: 2, height: 2 }));
    expect(payload(result).atlases[0].dataBase64).toBe("/////////////////////w==");
  });
  it("rejects untrusted source bytes before invoking a producer", async () => {
    const input = fixture(), runtime = host(); input.assets.font!.bytes[0] = 9;
    await expect(compileDashboardRasterContent(input, runtime.adapter)).rejects.toThrow(/identity/);
    expect(runtime.adapter.rasterizeText).not.toHaveBeenCalled();
  });
  it.each(["sha256", "requestHash", "width"])("rejects invalid producer %s", async key => {
    const runtime = host(), original = runtime.adapter.rasterizeText;
    runtime.adapter.rasterizeText = async request => ({ ...await original(request), [key]: key === "width" ? 3 : "b".repeat(64) });
    await expect(compileDashboardRasterContent(fixture(), runtime.adapter)).rejects.toThrow(/mismatch/);
  });
  it("rejects a substituted font face", async () => {
    const runtime = host(), original = runtime.adapter.rasterizeText;
    runtime.adapter.rasterizeText = async request => { const value = await original(request);
      return { ...value, usedFaces: value.usedFaces!.map(face => ({ ...face, faceIndex: 1 })) }; };
    await expect(compileDashboardRasterContent(fixture(), runtime.adapter)).rejects.toThrow(/font face/);
  });
  it("snapshots source and producer input across asynchronous work", async () => {
    const input = fixture(), runtime = host(), original = runtime.adapter.rasterizeText;
    runtime.adapter.rasterizeText = async request => {
      input.document.application.pages[0]!.nodes[0]!.frame.x = 999;
      input.assets.font!.bytes[0] = 9; request.fonts[0]!.bytes[0] = 8;
      return original(request);
    };
    const result = await compileDashboardRasterContent(input, runtime.adapter);
    const doc = result.package.payloads[result.package.entrypoints.dashboard!] as any;
    const authored = doc.pages[0].nodes.find((node: any) => node.id === result.nodeBindings[0]!.runtimeNodeId);
    expect(authored.frame[0]).toBe(50);
  });
  it("keeps unresolved inherited style and empty text explicit", async () => {
    const input = fixture(), runtime = host();
    const node = input.document.application.pages[0]!.nodes[0]! as DashboardDataWidgetNode;
    node.widget.textColor = "var(--text)";
    const unresolved = await compileDashboardRasterContent(input, runtime.adapter);
    expect(unresolved.capabilityReport.contentCompiled).toBe(0);
    expect(runtime.adapter.rasterizeText).not.toHaveBeenCalled();
    node.widget.content = ""; node.widget.title = "";
    expect((await compileDashboardRasterContent(input, runtime.adapter)).capabilityReport.contentCompiled).toBe(1);
    expect(runtime.adapter.rasterizeText).not.toHaveBeenCalled();
  });
  it("does not invent values or schedule hidden pixels", async () => {
    const runtime = host(), value = await compileDashboardRasterContent(fixture("value"), runtime.adapter);
    expect(value.capabilityReport.contentCompiled).toBe(0); expect(payload(value).quads).toHaveLength(0);
    const input = fixture(); input.document.application.pages[0]!.nodes[0]!.visible = false;
    expect(payload(await compileDashboardRasterContent(input, runtime.adapter)).displayList.commands).toHaveLength(0);
    expect(runtime.adapter.rasterizeText).not.toHaveBeenCalled();
  });
});
