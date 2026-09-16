import { createHash } from "node:crypto";

export const TEXT_RASTER_LIMITS = Object.freeze({ requestBytes: 90 * 1024 ** 2, fontBytes: 64 * 1024 ** 2,
  resultBytes: 32 * 1024 ** 2, pixelBytes: 16 * 1024 ** 2, executableBytes: 512 * 1024 ** 2 });
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (condition, message) => { if (!condition) throw new Error(`Invalid text raster wire: ${message}`); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const styles = ["normal", "italic", "oblique"];
function fields(value, keys) {
  check(value && typeof value === "object" && !Array.isArray(value), "expected object");
  check(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), "unexpected fields");
}
export function base64Bytes(value, limit) {
  check(typeof value === "string" && value.length <= 4 * Math.ceil(limit / 3)
    && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), "invalid base64");
  const bytes = Buffer.from(value, "base64");
  check(bytes.length <= limit && bytes.toString("base64") === value, "noncanonical or oversized base64");
  return bytes;
}
export function validateTextRasterRequest(value) {
  fields(value, ["schema", "schemaVersion", "locale", "fonts", "request"]);
  check(value.schema === "deep-engine.text-raster-request" && value.schemaVersion === 1, "request schema");
  check(typeof value.locale === "string" && value.locale.isWellFormed() && value.locale.length > 0 && Buffer.byteLength(value.locale) <= 64
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value.locale), "locale");
  check(Array.isArray(value.fonts) && value.fonts.length > 0 && value.fonts.length <= 32, "font count");
  const faces = new Set(); let bytes = 0;
  for (const font of value.fonts) {
    fields(font, ["sha256", "faceIndex", "dataBase64"]);
    check(hash(font.sha256) && integer(font.faceIndex, 0, 0xffffffff), "font identity");
    const data = base64Bytes(font.dataBase64, TEXT_RASTER_LIMITS.fontBytes - bytes); bytes += data.length;
    check(data.length > 0 && sha256(data) === font.sha256, "font hash");
    const id = `${font.sha256}:${font.faceIndex}`;
    check(!faces.has(id), "duplicate font face"); faces.add(id);
  }
  const request = value.request;
  fields(request, ["text", "font", "weight", "style", "align", "verticalAlign", "wrap", "fontSize", "lineHeight", "width", "height", "color"]);
  fields(request.font, ["sha256", "faceIndex"]);
  check(hash(request.font.sha256) && integer(request.font.faceIndex, 0, 0xffffffff)
    && faces.has(`${request.font.sha256}:${request.font.faceIndex}`), "unfrozen requested font");
  check(typeof request.text === "string" && request.text.isWellFormed() && Buffer.byteLength(request.text) <= 16384, "text encoding/budget");
  check(integer(request.weight, 1, 1000) && styles.includes(request.style), "font style");
  check(["left", "center", "right"].includes(request.align) && ["none", "word", "glyph", "word-or-glyph"].includes(request.wrap), "layout policy");
  check(["top", "center", "bottom"].includes(request.verticalAlign), "vertical alignment");
  check(Number.isFinite(request.fontSize) && request.fontSize >= 1 && request.fontSize <= 256
    && Number.isFinite(request.lineHeight) && request.lineHeight >= 1 && request.lineHeight <= 512, "text metrics");
  check(integer(request.width, 1, 2048) && integer(request.height, 1, 2048)
    && request.width * request.height * 4 <= TEXT_RASTER_LIMITS.pixelBytes, "raster dimensions");
  check(Array.isArray(request.color) && request.color.length === 4 && request.color.every(v => integer(v, 0, 255)), "color");
  return faces;
}
export function validateTextRasterResult(value, input, sourceSha256, faces) {
  fields(value, ["schema", "schemaVersion", "producer", "sourceSha256", "width", "height", "rgbaBase64", "pixelSha256",
    "format", "alphaMode", "glyphCount", "lineCount", "layoutWidth", "layoutHeight", "inkBounds", "clipped", "lines", "usedFaces"]);
  check(value.schema === "deep-engine.text-raster-result" && value.schemaVersion === 1
    && value.producer === "cosmic-text-0.19.0-frozen-v1", "result schema or producer");
  check(value.sourceSha256 === sourceSha256 && hash(value.pixelSha256), "result source identity");
  check(value.width === input.request.width && value.height === input.request.height, "result dimensions");
  check(value.format === "rgba8unorm-srgb" && value.alphaMode === "straight", "pixel format");
  const rgba = base64Bytes(value.rgbaBase64, TEXT_RASTER_LIMITS.pixelBytes);
  check(rgba.length === value.width * value.height * 4 && sha256(rgba) === value.pixelSha256, "pixel bytes/hash");
  check(integer(value.glyphCount, 0, 65536) && integer(value.lineCount, 0, 16384), "layout counts");
  const metric = n => Number.isFinite(n) && Math.abs(n) <= 16_777_216;
  check(metric(value.layoutWidth) && value.layoutWidth >= 0 && metric(value.layoutHeight) && value.layoutHeight >= 0
    && typeof value.clipped === "boolean", "layout metrics");
  if (value.inkBounds !== null) {
    check(Array.isArray(value.inkBounds) && value.inkBounds.length === 4 && value.inkBounds.every(n => integer(n, 0, 2048)), "ink bounds");
    const [left, top, right, bottom] = value.inkBounds;
    check(right > left && bottom > top && right <= value.width && bottom <= value.height, "ink extent");
  }
  check(Array.isArray(value.lines) && value.lines.length === value.lineCount, "line count");
  let previous = -1;
  for (const line of value.lines) {
    fields(line, ["lineIndex", "baseline", "top", "height", "width"]);
    check(integer(line.lineIndex, 0, 16384) && line.lineIndex >= previous
      && [line.baseline, line.top, line.height, line.width].every(metric) && line.top >= 0 && line.height > 0 && line.width >= 0, "line metrics");
    previous = line.lineIndex;
  }
  check(Array.isArray(value.usedFaces) && value.usedFaces.length <= faces.size, "used font count");
  const used = new Set(); let previousFace;
  for (const face of value.usedFaces) {
    fields(face, ["sha256", "faceIndex", "family", "postScriptName", "weight", "style"]);
    const id = `${face.sha256}:${face.faceIndex}`;
    check(hash(face.sha256) && integer(face.faceIndex, 0, 0xffffffff) && faces.has(id) && !used.has(id), "unfrozen/duplicate used font");
    check(!previousFace || face.sha256 > previousFace.sha256
      || face.sha256 === previousFace.sha256 && face.faceIndex > previousFace.faceIndex, "used font ordering");
    check(typeof face.family === "string" && face.family.isWellFormed() && face.family.length > 0 && Buffer.byteLength(face.family) <= 4096
      && typeof face.postScriptName === "string" && face.postScriptName.isWellFormed() && Buffer.byteLength(face.postScriptName) <= 4096
      && integer(face.weight, 1, 1000) && styles.includes(face.style), "used font metadata"); used.add(id);
    check(face.weight === input.request.weight && face.style === input.request.style, "used font weight/style differs from request");
    previousFace = face;
  }
  check(value.glyphCount === 0 || input.request.text.trim().length === 0 || used.size > 0, "missing used font evidence");
  return rgba;
}
