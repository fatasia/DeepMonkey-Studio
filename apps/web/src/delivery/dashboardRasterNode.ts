import { DashboardDataUnavailable, rasterDataContent } from "./dashboardDataRaster";
import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import { runtimeContentSha256, type Deep2dRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { lowerDashboardWidget } from "./dashboardWidgetContent";
import { parseHexColor, DASHBOARD_CONTENT_INSET } from "./dashboardShapeContent";
import { assetIdentity, base64, rasterExtent, verifyRaster } from "./dashboardRasterValidation";
import type { DashboardRasterCompileInput, DashboardRasterEvidence, DashboardRasterHost,
  DashboardRasterResult, DashboardRasterTextStyle } from "./dashboardRasterTypes";

export async function rasterNode(node: DashboardDataWidgetNode, id: string, revision: number,
  input: DashboardRasterCompileInput, host: DashboardRasterHost) {
  const local = { ...node, frame: { ...node.frame, x: 0, y: 0 }, zIndex: 0 };
  const chrome = lowerDashboardWidget(local, id, revision);
  let content: Deep2dRuntimePackage = { schema: "deep-engine.deep2d-runtime", schemaVersion: 2,
    id, revision, composition: "z-ordered", displayList: { schemaVersion: 1, id: `${id}.paths`, revision,
      logicalWidth: node.frame.width, logicalHeight: node.frame.height, scaleFactor: 1,
      resources: chrome.resources, commands: chrome.commands }, atlases: [], quads: [] };
  const compiledFields = [...chrome.compiledFields];
  const reasons = ["Container shadow, border radius, background images and runtime behaviors are not compiled",
    ...chrome.reasons.filter(reason => reason.startsWith("容器背景"))];
  let contentCompiled = chrome.contentCompiled;
  let evidence: DashboardRasterEvidence[] = [];
  let layers: Array<{ content: Deep2dRuntimePackage; clip: readonly [number, number, number, number] | null }> | undefined;
  const inset = DASHBOARD_CONTENT_INSET, width = node.frame.width - inset * 2, height = node.frame.height - inset * 2;
  if (node.visible === false) reasons.push("Hidden node has no draw commands");
  else if (node.widget.type === "text" || node.widget.type === "image") {
    const text = node.widget.content || node.widget.title;
    if (node.widget.type === "text" && text.length === 0) {
      contentCompiled = true; compiledFields.push("widget.content", "widget.title");
    } else if (width <= 0 || height <= 0) reasons.push("Content box is empty");
    else if (node.widget.semanticBinding) reasons.push("Semantic binding requires a frozen resolved widget snapshot");
    else {
      const pixels = { width: Math.ceil(width), height: Math.ceil(height) };
      rasterExtent(pixels.width, pixels.height);
      const binding = input.nodeAssets[node.id];
      if (!binding) reasons.push("Frozen node resource binding is missing");
      else {
        let result: DashboardRasterResult | undefined;
        if (node.widget.type === "text") {
          if (!binding.textStyle || !binding.fonts?.length) reasons.push("Frozen font and computed text style are required");
          else {
            const fonts = binding.fonts.map(ref => {
              const font = input.assets[ref];
              if (!font || font.faceIndex === undefined) throw new Error("Frozen font reference is missing");
              return font;
            });
            let style: DashboardRasterTextStyle | undefined;
            try { style = textStyle(node, binding.textStyle); }
            catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
            if (style) {
            const source = { ...pixels, ...style, text, locale: input.locale,
              verticalAlign: "center" as const, wrap: "word-or-glyph" as const, fonts: fonts.map(assetIdentity) };
            const requestHash = runtimeContentSha256(source);
            result = verifyRaster(await host.rasterizeText(structuredClone({ ...source, requestHash, fonts })),
              requestHash, pixels.width, pixels.height, fonts);
            compiledFields.push("widget.content", "widget.title", "widget.textColor", "widget.fontSize",
              "widget.fontWeight", "widget.textAlign");
            }
          }
        } else {
          const asset = binding.image ? input.assets[binding.image] : undefined;
          if (!asset) reasons.push("Frozen image reference is missing");
          else {
            const fit = node.widget.imageFit ?? "cover";
            const requestHash = runtimeContentSha256({ ...pixels, fit, asset: assetIdentity(asset) });
            result = verifyRaster(await host.decodeImage(structuredClone({ ...pixels, fit, asset, requestHash })),
              requestHash, pixels.width, pixels.height);
            compiledFields.push("widget.imageFit", "widget.assetId", "widget.imageUrl");
          }
        }
        if (result) {
          const atlasId = `${id}.pixels`;
          content = { ...content, atlases: [{ id: atlasId, revision, kind: "image", format: "rgba8unorm-srgb",
            width: result.width, height: result.height, sampling: "linear", dataBase64: base64(result.rgba) }],
          quads: [{ id: `${id}.quad`, zOrder: 1, transform: [1, 0, 0, 1, 0, 0], atlasId,
            source: [0, 0, result.width, result.height], destination: [inset, inset,
              node.widget.type === "text" ? result.width : width, node.widget.type === "text" ? result.height : height], color: [1, 1, 1, 1] }] };
          if (node.widget.type === "text" && (width !== result.width || height !== result.height)) {
            const textId = `${id}.text`;
            layers = [{ content: { ...content, atlases: [], quads: [] }, clip: null },
              { content: { ...content, id: textId, displayList: { ...content.displayList, id: `${textId}.paths`,
                resources: [], commands: [] } }, clip: [inset, inset, width, height] }];
          }
          evidence = [{ nodeId: node.id, atlasId, requestHash: result.requestHash, sourceSha256: result.sourceSha256,
            pixelSha256: result.sha256, producer: result.producer,
            ...(result.producerEvidence ? { producerEvidence: result.producerEvidence } : {}), usedFaces: result.usedFaces ?? [],
            lines: result.lines ?? [], clipped: result.clipped ?? false }];
          contentCompiled = true;
        }
      }
    }
  } else if (node.widget.type === "value" || node.widget.type === "table") {
    try {
      const result = await rasterDataContent(node, content, input, host);
      layers = result.layers; content = layers[0]!.content; evidence = result.evidence; contentCompiled = true;
      compiledFields.push("widget.title", "widget.unit", "widget.report", "widget.analysis");
      reasons.push("Only the measured static data view is compiled; filtering, paging, sorting, row actions and export remain deferred",
        "Measured styles retain frozen Web locale/font metrics; cross-host CSS/OpenType equivalence is not asserted");
      if (node.widget.type === "table") reasons.push("CSV/Excel export toolbar buttons have a static appearance capture contract; the production widget is not yet wired into the measured table view",
        "CSV/Excel export download actions are not included in the measured table contract");
    } catch (error) {
      if (!(error instanceof DashboardDataUnavailable)) throw error;
      contentCompiled = false; reasons.push(error.message);
    }
  } else {
    reasons.push(...chrome.reasons);
    if (node.widget.type !== "shape") contentCompiled = false;
  }
  const fields = [...Object.keys(node).filter(key => key !== "widget"), ...Object.keys(node.widget).map(key => `widget.${key}`)];
  return { content, layers: layers ?? [{ content, clip: null }], evidence, report: { nodeId: node.id, contentCompiled,
    status: contentCompiled || chrome.commands.length ? "degraded" as const : "blocked" as const,
    compiledFields, deferredFields: fields.filter(key => !compiledFields.includes(key)), reasons } };
}
function textStyle(node: DashboardDataWidgetNode, inherited: DashboardRasterTextStyle): DashboardRasterTextStyle {
  const widget = node.widget;
  const rgba = widget.textColor ? parseHexColor(widget.textColor).map(v => Math.round(v * 255)) : inherited.color;
  const value = { ...inherited, fontSize: widget.fontSize ?? inherited.fontSize,
    fontWeight: widget.fontWeight ?? inherited.fontWeight, align: widget.textAlign ?? inherited.align,
    color: rgba as [number, number, number, number] };
  if (!Number.isFinite(value.fontSize) || value.fontSize <= 0 || !Number.isFinite(value.lineHeight) || value.lineHeight <= 0
    || !Number.isInteger(value.fontWeight) || value.fontWeight < 1 || value.fontWeight > 1000
    || !["normal", "italic", "oblique"].includes(value.fontStyle) || !["left", "center", "right"].includes(value.align)
    || value.color.length !== 4 || !value.color.every(v => Number.isInteger(v) && v >= 0 && v <= 255))
    throw new Error("Invalid frozen text style");
  return value;
}
