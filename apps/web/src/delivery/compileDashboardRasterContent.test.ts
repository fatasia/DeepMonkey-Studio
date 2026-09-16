import { describe, expect, it, vi } from "vitest";
import { assertDashboardDocument, type DashboardDocument, type DashboardDataWidgetNode } from "@bim-studio/contracts";
import { sha256Bytes } from "@bim-studio/deep-engine/shader-package";
import { validateDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
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
    expect(doc.pages[0].nodes[0].frame[0]).toBe(50);
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
