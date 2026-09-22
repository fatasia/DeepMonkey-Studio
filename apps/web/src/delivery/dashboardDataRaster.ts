import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import { runtimeContentSha256, type Deep2dRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { sha256Bytes } from "@bim-studio/deep-engine/shader-package";
import { compositeDashboardButtonGroup } from "./dashboardButtonGroup";
import { assetIdentity, base64, rasterExtent, verifyRaster } from "./dashboardRasterValidation";
import { dataPresentation, dataRoleKey } from "./dashboardDataPresentation";
import { dashboardDataPaint } from "./dashboardDataPaint";
import type { DashboardDataTextBox } from "./dashboardDataRasterTypes";
import type { DashboardRasterCompileInput, DashboardRasterEvidence, DashboardRasterHost } from "./dashboardRasterTypes";

export class DashboardDataUnavailable extends Error {}

/**
 * Validates a frozen data view and prepares the exact text requests used by
 * rasterDataContent. Table compilation uses this pass to prewarm its unique
 * text batch without allocating any pixels or mutating runtime content.
 */
export function prepareDashboardDataRaster(node: DashboardDataWidgetNode, input: DashboardRasterCompileInput) {
  const data = input.data?.[node.id];
  const scale: 1 | 2 = input.textRasterScale === undefined || input.textRasterScale === 1 ? 1 : input.textRasterScale;
  if (scale !== 1 && scale !== 2) throw new DashboardDataUnavailable("Text raster scale must be 1 or 2");
  if (!data || !("layout" in data) || node.widget.semanticBinding)
    throw new DashboardDataUnavailable("Frozen resolved metric and measured Web layout are required");
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
    rasterExtent(width * scale, height * scale);
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
  const requests = boxes.map(({ box, text, source }) => {
    if (!source) return undefined;
    const fonts = box.fonts.map(ref => {
      const font = input.assets[ref];
      if (!font || font.faceIndex === undefined) throw new DashboardDataUnavailable("Missing measured text font");
      return font;
    });
    if (!fonts.length) throw new DashboardDataUnavailable("Measured text font is required");
    const request = { ...box.style, fontSize: box.style.fontSize * scale, lineHeight: box.style.lineHeight * scale,
      text, locale: input.locale, width: Math.ceil(box.rect[2]) * scale, height: Math.ceil(box.rect[3]) * scale,
      verticalAlign: box.verticalAlign, wrap: box.wrap };
    return { ...request, fonts, requestHash: runtimeContentSha256({ ...request, fonts: fonts.map(assetIdentity) }) };
  });
  if (requests.reduce((sum, request) => sum + (request ? request.width * request.height * 4 : 0), 0) > 64 * 1024 * 1024)
    throw new DashboardDataUnavailable("Data atlas byte budget exceeded");
  return { data, scale, paint, boxes, requests };
}

export async function rasterDataContent(node: DashboardDataWidgetNode, content: Deep2dRuntimePackage,
  input: DashboardRasterCompileInput, host: DashboardRasterHost) {
  const { data, scale, paint, boxes, requests } = prepareDashboardDataRaster(node, input);
  await host.prewarmText?.(requests.filter((request): request is NonNullable<typeof request> => request !== undefined));
  const layers: Array<{ content: Deep2dRuntimePackage; clip: DashboardDataTextBox["clip"] }> = [{
    content, clip: null }];
  const nextLayer = (clip: DashboardDataTextBox["clip"]) => {
    const previous = layers.length > 1 ? layers.at(-1) : undefined;
    if (previous && JSON.stringify(previous.clip) === JSON.stringify(clip)) return previous;
    const id = `layer.${runtimeContentSha256([content.id, layers.length])}`;
    const layer = { clip, content: { ...content, id, schemaVersion: 2, composition: "z-ordered",
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
    const { box, key, source, clip } = boxes[entry.index]!;
    if (!source) continue;
    const request = requests[entry.index]!;
    const { fonts, width, height, requestHash } = request;
    totalBytes += width * height * 4;
    if (totalBytes > 64 * 1024 * 1024) throw new DashboardDataUnavailable("Data atlas byte budget exceeded");
    const result = verifyRaster(await host.rasterizeText(structuredClone(request)),
      requestHash, width, height, fonts);
    const group = box.buttonGroup;
    const pixels = group ? compositeDashboardButtonGroup({ ...group, rect: [group.rect[0] * scale, group.rect[1] * scale,
      group.rect[2] * scale, group.rect[3] * scale], radius: group.radius * scale, borderWidth: group.borderWidth * scale },
      { rect: [box.rect[0] * scale, box.rect[1] * scale, box.rect[2] * scale, box.rect[3] * scale], width, height, rgba: result.rgba },
      { width: Math.ceil(group.rect[2]) * scale, height: Math.ceil(group.rect[3]) * scale }) : result;
    if (group) { totalBytes += pixels.rgba.byteLength; if (totalBytes > 64 * 1024 * 1024) throw new DashboardDataUnavailable("Data atlas byte budget exceeded"); }
    const pixelSha256 = group ? sha256Bytes(pixels.rgba) : result.sha256;
    const destination = [group?.rect[0] ?? box.rect[0], group?.rect[1] ?? box.rect[1], pixels.width / scale, pixels.height / scale] as const;
    const measuredClip = group ? box.clip : clip;
    const effectiveClip = measuredClip && !(destination[0] >= measuredClip[0] && destination[1] >= measuredClip[1]
      && destination[0] + destination[2] <= measuredClip[0] + measuredClip[2]
      && destination[1] + destination[3] <= measuredClip[1] + measuredClip[3]) ? measuredClip : null;
    const layer = nextLayer(effectiveClip);
    const atlases = [...layer.content.atlases], quads = [...layer.content.quads];
    const id = `raster.${runtimeContentSha256([content.id, key])}`;
    atlases.push({ id, revision: content.revision, kind: "image", format: "rgba8unorm-srgb", width: pixels.width, height: pixels.height,
      sampling: "linear", dataBase64: base64(pixels.rgba) });
    quads.push({ id: `${id}.quad`, atlasId: id, zOrder: paintIndex, transform: [1, 0, 0, 1, 0, 0],
      source: [0, 0, pixels.width, pixels.height], destination, color: [1, 1, 1, 1] });
    layer.content = { ...layer.content, atlases, quads };
    evidence.push({ nodeId: node.id, atlasId: id, textRasterScale: scale, requestHash, sourceSha256: result.sourceSha256, pixelSha256,
      ...(group ? { composition: { id: "dashboard-button-group-v1" as const, sourcePixelSha256: result.sha256,
        outputPixelSha256: pixelSha256, sourceRgbaBase64: base64(result.rgba), sourceWidth: width, sourceHeight: height,
        recipe: { group, textRect: box.rect, role: box.role },
        recipeSha256: runtimeContentSha256({ group, textRect: box.rect, role: box.role }) } } : {}),
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
  if (box.buttonGroup && box.role.kind !== "previous" && box.role.kind !== "next" && box.role.kind !== "tool")
    throw new DashboardDataUnavailable("Isolated button groups require a pagination or export tool role");
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
