import { expect, it, vi } from "vitest";
import { assertDashboardDocument } from "@bim-studio/contracts";
import { sha256Bytes } from "@bim-studio/deep-engine/shader-package";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import source from "../../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { compileDashboardRasterContent } from "./compileDashboardRasterContent";
import type { DashboardRasterCompileInput, DashboardRasterHost, DashboardTextRasterRequest, DashboardRasterResult } from "./dashboardRasterTypes";
import type { DashboardDataTextBox, DashboardFrozenData } from "./dashboardDataRasterTypes";
export function fixture() {
  const document: unknown = structuredClone(source); assertDashboardDocument(document);
  document.application.scripts = []; document.application.interactions = [];
  document.application.pages[0]!.nodes = [{ id: "kpi", kind: "data-widget", zIndex: 0,
    frame: { x: 20, y: 30, width: 160, height: 100 }, widget: { type: "value", title: "利用率", key: "kpi", unit: "%" } }];
  const bytes = new Uint8Array([1, 2]), hash = sha256Bytes(bytes);
  const metric = { value: 81.6666, samples: [] };
  const textBoxes: DashboardDataTextBox[] = (["title", "value", "unit"] as const).map((kind, index) => ({ role: { kind },
    rect: [17 + index * 20, 17, 20, 10], clip: null, wrap: "none", whiteSpace: "nowrap", fonts: ["font"], verticalAlign: "top", style: {
      fontSize: 10, fontWeight: 400, fontStyle: "normal", lineHeight: 10, color: [255, 255, 255, 255], align: "left" } }));
  const data: DashboardFrozenData = { source: { kind: "dataset", id: "frozen-source", revision: 1,
    contentSha256: runtimeContentSha256(metric) }, metric, layout: { textBoxes, backgrounds: [] } };
  const input: DashboardRasterCompileInput = { document, packageId: "kpi.frozen", packageVersion: "1.0.0", locale: "zh-CN",
    assets: { font: { bytes, sha256: hash, faceIndex: 0, mime: "font/ttf", identity: { id: "test-font", revision: 1 } } },
    nodeAssets: {}, data: { kpi: data } };
  // Pixel stub proves request/layout orchestration only; it is not font rendering evidence.
  const rasterizeText = vi.fn(async (request: DashboardTextRasterRequest): Promise<DashboardRasterResult> => {
    const rgba = new Uint8Array(request.width * request.height * 4).fill(255), sha256 = sha256Bytes(rgba);
    return { ...request, rgba, sha256, sourceSha256: hash, format: "rgba8unorm-srgb", alphaMode: "straight",
      producer: { id: "orchestration-test", version: "1" }, producerEvidence: { scope: "native-text-raster",
        sourceSha256: hash, executableSha256: hash, pixelSha256: sha256, producer: "orchestration-test" },
      usedFaces: [{ sha256: hash, faceIndex: 0, family: "Test", postScriptName: "Test", weight: 400, style: "normal" }], lines: [] };
  });
  const host: DashboardRasterHost = { rasterizeText, decodeImage: async () => { throw new Error("unexpected image"); } };
  return { input, host, rasterizeText, data, textBoxes };
}
export function content(result: Awaited<ReturnType<typeof compileDashboardRasterContent>>) {
  const layers = Object.values(result.package.payloads).filter((value: any) => value.schema === "deep-engine.deep2d-runtime") as any[];
  return { ...layers[0], quads: layers.flatMap(layer => layer.quads) };
}
