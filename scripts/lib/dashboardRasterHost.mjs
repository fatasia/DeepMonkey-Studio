import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import sharp from "sharp";
import { rasterizeNativeText, rasterizeNativeTextBatch } from "./nativeTextRasterizer.mjs";
import { decodePageBackgroundPixels } from "./dashboardPageBackgroundRaster.mjs";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const MAX_BYTES = 64 * 1024 * 1024;
function frozenBytes(asset) {
  if (!(asset.bytes instanceof Uint8Array) || !asset.bytes.length || asset.bytes.byteLength > MAX_BYTES)
    throw new Error("Frozen raster resource hash or byte budget mismatch");
  const bytes = Buffer.from(asset.bytes);
  if (!bytes.length || bytes.length > MAX_BYTES || sha256(bytes) !== asset.sha256)
    throw new Error("Frozen raster resource hash or byte budget mismatch");
  return bytes;
}
function snapshot(input, signal, text) {
  signal?.throwIfAborted(); extent(input);
  const assets = text ? input.fonts : [input.asset];
  if (!Array.isArray(assets) || !assets.length) throw new Error("Frozen primary font is required");
  let total = 0;
  for (const asset of assets) {
    if (!(asset?.bytes instanceof Uint8Array) || !asset.bytes.length)
      throw new Error("Frozen raster resource hash or byte budget mismatch");
    total += asset.bytes.byteLength;
    if (total > MAX_BYTES) throw new Error("Frozen raster resource hash or byte budget mismatch");
  }
  const copy = structuredClone({ ...input, fonts: undefined, asset: undefined });
  const frozen = assets.map(asset => ({ ...structuredClone({ ...asset, bytes: undefined }), bytes: frozenBytes(asset) }));
  return text ? { ...copy, fonts: frozen } : { ...copy, asset: frozen[0] };
}
function extent(request) {
  if (![request.width, request.height].every(v => Number.isSafeInteger(v) && v > 0 && v <= 8192)
    || request.width * request.height * 4 > MAX_BYTES) throw new Error("Invalid raster extent");
}
function verifyCachedFonts(input) {
  if (!Array.isArray(input.fonts) || !input.fonts.length) throw new Error("Frozen primary font is required");
  let total = 0;
  for (const font of input.fonts) {
    if (!(font?.bytes instanceof Uint8Array) || !font.bytes.length
      || (total += font.bytes.byteLength) > MAX_BYTES || sha256(font.bytes) !== font.sha256)
      throw new Error("Frozen raster resource hash or byte budget mismatch");
  }
}
/** Only immutable byte inputs enter these producers; no URL resolution or publication authorization. */
export function createDashboardRasterHost({ nativeExecutable, signal, textCache = undefined }) {
  const host = {
    traceCompilation(value) {
      if (process.env.DASHBOARD_COMPILER_RESOURCE_TRACE) writeFileSync(process.env.DASHBOARD_COMPILER_RESOURCE_TRACE, JSON.stringify(value));
    },
    async rasterizeText(input) {
      signal?.throwIfAborted(); extent(input);
      verifyCachedFonts(input);
      // Cache hits need no second font copy after synchronous byte validation.
      const hit = textCache?.get(input, signal);
      if (hit) return hit;
      const request = snapshot(input, signal, true);
      if (!request.fonts.length) throw new Error("Frozen primary font is required");
      const cached = textCache?.get(request, signal);
      if (cached) return cached;
      const started = performance.now();
      const output = textOutput(request, await rasterizeNativeText({ nativeExecutable, request: textWire(request), signal }));
      signal?.throwIfAborted(); textCache?.put(request, output, signal);
      if (process.env.DASHBOARD_COMPILER_TRACE === "1") console.info("text raster", request.text, Math.round(performance.now() - started));
      return output;
    },
    decodeImage: request => rasterizeFrozenImage(request, signal),
    decodePageBackground: request => rasterizeFrozenPageBackground(request, signal),
  };
  return { ...host, async prewarmText(requests) {
    if (!textCache) return;
    const unique = [...new Map(requests.map(request => [request.requestHash, request])).values()];
    const groups = new Map();
    for (const request of unique) {
      const key = JSON.stringify({ locale: request.locale, fonts: request.fonts.map(font => ({ ...font, bytes: undefined })) });
      const group = groups.get(key) ?? []; group.push(request); groups.set(key, group);
    }
    // One font group at a time keeps the aggregate frozen-font working set bounded.
    for (const group of groups.values()) {
      const pending = []; let fonts;
      for (const input of group) {
        signal?.throwIfAborted(); extent(input); verifyCachedFonts(input);
        if (textCache.get(input, signal)) continue;
        const request = snapshot(input, signal, true);
        if (textCache.get(request, signal)) continue;
        fonts ??= request.fonts;
        pending.push({ ...request, fonts });
      }
      if (!pending.length) continue;
      const first = textWire(pending[0]);
      const requests = pending.map((request, index) => index ? textWire(request, first.fonts) : first);
      const started = performance.now();
      const produced = await rasterizeNativeTextBatch({ nativeExecutable, requests, signal });
      if (process.env.DASHBOARD_COMPILER_TRACE === "1") console.info("text batch", pending.length, Math.round(performance.now() - started));
      signal?.throwIfAborted();
      for (const [index, result] of produced.entries()) textCache.put(pending[index], textOutput(pending[index], result), signal);
    }
  } };
}
function textWire(request, sharedFonts) {
  const fonts = sharedFonts ?? request.fonts.map(font => ({ sha256: font.sha256, faceIndex: font.faceIndex,
    dataBase64: font.bytes.toString("base64") }));
  return { schema: "deep-engine.text-raster-request", schemaVersion: 1, locale: request.locale, fonts,
    request: { text: request.text, font: { sha256: fonts[0].sha256, faceIndex: fonts[0].faceIndex },
      weight: request.fontWeight, style: request.fontStyle, align: request.align,
      verticalAlign: request.verticalAlign, wrap: request.wrap, fontSize: request.fontSize,
      lineHeight: request.lineHeight, width: request.width, height: request.height, color: request.color } };
}
function textOutput(request, { result, rgba, evidence }) {
  return { width: result.width, height: result.height, rgba: new Uint8Array(rgba), sha256: result.pixelSha256,
    requestHash: request.requestHash, sourceSha256: result.sourceSha256,
    producer: { id: "cosmic-text", version: "0.19.0-frozen-v1" },
    producerEvidence: { scope: "native-text-raster", sourceSha256: evidence.sourceSha256,
      executableSha256: evidence.executableSha256, pixelSha256: evidence.pixelSha256, producer: evidence.producer },
    format: result.format, alphaMode: result.alphaMode, usedFaces: result.usedFaces, lines: result.lines, clipped: result.clipped };
}
export async function rasterizeFrozenPageBackground(input, signal) {
  const request = snapshot(input, signal, false);
  const data = await decodePageBackgroundPixels(request, signal);
  signal?.throwIfAborted();
  const sourceSha256 = sha256(Buffer.from(JSON.stringify({ source: request.asset.sha256,
    width: request.width, height: request.height, background: request.background,
    orientation: "exif", colorspace: "srgb", alphaMode: "straight" })));
  return { width: request.width, height: request.height, rgba: new Uint8Array(data), sha256: sha256(data),
    requestHash: request.requestHash, sourceSha256, producer: { id: "sharp-page-background", version: sharp.versions.sharp },
    format: "rgba8unorm-srgb", alphaMode: "straight" };
}
export async function rasterizeFrozenImage(input, signal) {
  const request = snapshot(input, signal, false);
  signal?.throwIfAborted();
  if (!["cover", "contain", "fill"].includes(request.fit)) throw new Error("Unsupported image fit");
  const bytes = request.asset.bytes;
  const metadata = await sharp(bytes, { limitInputPixels: MAX_BYTES / 4, failOn: "warning" }).metadata();
  if ((metadata.pages ?? 1) !== 1) throw new Error("Animated/multipage images require a separate producer");
  signal?.throwIfAborted();
  const { data, info } = await sharp(bytes, { limitInputPixels: MAX_BYTES / 4, failOn: "warning" })
    .rotate().resize(request.width, request.height, { fit: request.fit, position: "centre",
      background: { r: 0, g: 0, b: 0, alpha: 0 } }).toColourspace("srgb").ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  signal?.throwIfAborted();
  if (info.width !== request.width || info.height !== request.height || info.channels !== 4
    || data.length !== request.width * request.height * 4) throw new Error("Image raster extent mismatch");
  const sourceSha256 = sha256(Buffer.from(JSON.stringify({ source: request.asset.sha256,
    width: request.width, height: request.height, fit: request.fit, orientation: "exif", colorspace: "srgb", alphaMode: "straight" })));
  return { width: info.width, height: info.height, rgba: new Uint8Array(data), sha256: sha256(data),
    requestHash: request.requestHash, sourceSha256, producer: { id: "sharp", version: sharp.versions.sharp },
    format: "rgba8unorm-srgb", alphaMode: "straight" };
}
