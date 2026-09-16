import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import { runtimeContentSha256, type Deep2dRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { assetIdentity, base64, rasterExtent, verifyRaster } from "./dashboardRasterValidation";
import { dataPresentation, dataRoleKey } from "./dashboardDataPresentation";
import { dashboardDataPaint } from "./dashboardDataPaint";
import type { DashboardDataTextBox } from "./dashboardDataRasterTypes";
import type { DashboardRasterCompileInput, DashboardRasterEvidence, DashboardRasterHost } from "./dashboardRasterTypes";

export class DashboardDataUnavailable extends Error {}

export async function rasterDataContent(node: DashboardDataWidgetNode, content: Deep2dRuntimePackage,
  input: DashboardRasterCompileInput, host: DashboardRasterHost) {
  const data = input.data?.[node.id];
  if (!data || !("layout" in data) || node.widget.semanticBinding) throw new DashboardDataUnavailable("Frozen resolved metric and measured Web layout are required");
  if (node.widget.type === "table" && node.widget.report?.freezeFirstColumn && !data.layout.paint)
    throw new DashboardDataUnavailable("Sticky table cells require ordered background/text composition");
  let paint;
  try { paint = dashboardDataPaint(data.layout); }
  catch (error) { throw new DashboardDataUnavailable(error instanceof Error ? error.message : String(error)); }
  const texts = dataPresentation(node.widget, data, input.locale), seen = new Set<string>();
  if (data.layout.textBoxes.length > 512) throw new DashboardDataUnavailable("Data text atlas budget exceeded");
  const boxes = data.layout.textBoxes.map(box => {
    const key = dataRoleKey(box.role), value = texts.get(key);
    if (!value || seen.has(key)) throw new DashboardDataUnavailable("Duplicate or unexpected measured text role");
    seen.add(key); const source = cropBox(box); validateStyle(box);
    if (/[\t\u00ad]/.test(value.text)) throw new DashboardDataUnavailable("CSS tabs and soft hyphens require a separate text pass");
    if ((box.whiteSpace === "normal" || box.whiteSpace === "nowrap") && /[\t\r\n\f]| {2,}|^ | $/.test(value.text))
      throw new DashboardDataUnavailable("CSS whitespace collapsing requires a separate text pass");
    const width = Math.ceil(box.rect[2]), height = Math.ceil(box.rect[3]);
    const clip = width === box.rect[2] && height === box.rect[3] ? box.clip : intersectBox(box.rect, box.clip);
    return { box, key, text: value.text, source, clip };
  });
  if (seen.size !== texts.size) throw new DashboardDataUnavailable("Measured Web text layout is incomplete");
  for (const background of data.layout.backgrounds) {
    rect(background.rect, true);
    if (background.rect[2] === 0 || background.rect[3] === 0) continue;
    if (background.color.length !== 4 || background.color.some(v => !Number.isFinite(v) || v < 0 || v > 1))
      throw new DashboardDataUnavailable("Invalid measured background color");
  }
  const layers: Array<{ content: Deep2dRuntimePackage; clip: DashboardDataTextBox["clip"] }> = [{
    content, clip: null }];
  const nextLayer = (clip: DashboardDataTextBox["clip"]) => {
    const previous = layers.length > 1 ? layers.at(-1) : undefined;
    if (previous && JSON.stringify(previous.clip) === JSON.stringify(clip)) return previous;
    const id = `layer.${runtimeContentSha256([content.id, layers.length])}`;
    const layer = { clip, content: { ...content, id,
      displayList: { ...content.displayList, id: `${id}.paths`, resources: [], commands: [] },
      atlases: [], quads: [] } as Deep2dRuntimePackage };
    layers.push(layer);
    return layer;
  };
  const evidence: DashboardRasterEvidence[] = [];
  let totalBytes = 0;
  for (const [paintIndex, entry] of paint.entries()) {
    if (entry.kind === "background") {
      const background = data.layout.backgrounds[entry.index]!;
      const [x, y, width, height] = background.rect;
      if (width === 0 || height === 0) continue;
      const layer = !data.layout.paint && layers.length === 1 ? layers[0]! : nextLayer(null);
      const id = `${content.id}.bg.${entry.index}`;
      layer.content = { ...layer.content, displayList: { ...layer.content.displayList,
        resources: [...layer.content.displayList.resources, { kind: "path", id, revision: content.revision,
          verbs: [{ op: "move", x, y }, { op: "line", x: x + width, y },
            { op: "line", x: x + width, y: y + height }, { op: "line", x, y: y + height }, { op: "close" }] }],
        commands: [...layer.content.displayList.commands, { kind: "path", id: `${id}.draw`, pathId: id,
          zOrder: paintIndex, transform: [1, 0, 0, 1, 0, 0], fill: background.color }] } };
      continue;
    }
    const { box, key, text, source, clip } = boxes[entry.index]!;
    if (!source) continue;
    const fonts = box.fonts.map(ref => { const font = input.assets[ref];
      if (!font || font.faceIndex === undefined) throw new DashboardDataUnavailable("Missing measured text font"); return font; });
    if (!fonts.length) throw new DashboardDataUnavailable("Measured text font is required");
    const width = Math.ceil(box.rect[2]), height = Math.ceil(box.rect[3]);
    totalBytes += width * height * 4;
    if (totalBytes > 64 * 1024 * 1024) throw new DashboardDataUnavailable("Data atlas byte budget exceeded");
    const requestHash = runtimeContentSha256({ text, role: box.role, box, metricHash: data.source.contentSha256,
      locale: input.locale, fonts: fonts.map(assetIdentity) });
    const result = verifyRaster(await host.rasterizeText(structuredClone({ ...box.style, requestHash, text,
      locale: input.locale, width, height, verticalAlign: box.verticalAlign, wrap: box.wrap, fonts })),
      requestHash, width, height, fonts);
    const layer = nextLayer(clip);
    const atlases = [...layer.content.atlases], quads = [...layer.content.quads];
    const id = `raster.${key}`;
    atlases.push({ id, revision: content.revision, kind: "image", format: "rgba8unorm-srgb", width, height,
      sampling: "linear", dataBase64: base64(result.rgba) });
    quads.push({ id: `${id}.quad`, atlasId: id, zOrder: paintIndex, transform: [1, 0, 0, 1, 0, 0],
      source: [0, 0, width, height], destination: [box.rect[0], box.rect[1], width, height], color: [1, 1, 1, 1] });
    layer.content = { ...layer.content, atlases, quads };
    evidence.push({ nodeId: node.id, atlasId: id, requestHash, sourceSha256: result.sourceSha256, pixelSha256: result.sha256,
      producer: result.producer, ...(result.producerEvidence ? { producerEvidence: result.producerEvidence } : {}),
      usedFaces: result.usedFaces ?? [], lines: result.lines ?? [], clipped: result.clipped ?? false });
  }
  return { layers, evidence };
}
function intersectBox(box: DashboardDataTextBox["rect"], clip: DashboardDataTextBox["clip"]): DashboardDataTextBox["rect"] {
  if (!clip) return box;
  const x = Math.max(box[0], clip[0]), y = Math.max(box[1], clip[1]);
  return [x, y, Math.max(0, Math.min(box[0] + box[2], clip[0] + clip[2]) - x),
    Math.max(0, Math.min(box[1] + box[3], clip[1] + clip[3]) - y)];
}
function rect(value: readonly number[], empty = false): void {
  if (value.length !== 4 || !value.every(v => Number.isFinite(v) && Math.abs(v) <= 16_777_216)
    || (empty ? value[2]! < 0 || value[3]! < 0 : value[2]! <= 0 || value[3]! <= 0))
    throw new DashboardDataUnavailable("Invalid measured rectangle");
}
function cropBox(box: DashboardDataTextBox) {
  rect(box.rect); if (box.clip) rect(box.clip, true);
  const [x, y, w, h] = box.rect; rasterExtent(Math.ceil(w), Math.ceil(h));
  const clip = box.clip ?? box.rect;
  return Math.min(x + w, clip[0] + clip[2]) > Math.max(x, clip[0])
    && Math.min(y + h, clip[1] + clip[3]) > Math.max(y, clip[1]);
}
function validateStyle(box: DashboardDataTextBox): void {
  const style = box.style;
  if (!Number.isFinite(style.fontSize) || style.fontSize <= 0 || !Number.isFinite(style.lineHeight) || style.lineHeight <= 0
    || !Number.isInteger(style.fontWeight) || style.fontWeight < 1 || style.fontWeight > 1000
    || !["normal", "italic", "oblique"].includes(style.fontStyle) || !["left", "center", "right"].includes(style.align)
    || !["top", "center", "bottom"].includes(box.verticalAlign)
    || !["normal", "nowrap", "pre", "pre-wrap"].includes(box.whiteSpace)
    || !(["normal", "pre-wrap"].includes(box.whiteSpace) ? ["word", "word-or-glyph"] : ["none"]).includes(box.wrap)
    || style.color.length !== 4 || !style.color.every(v => Number.isInteger(v) && v >= 0 && v <= 255))
    throw new DashboardDataUnavailable("Invalid measured text style");
}
