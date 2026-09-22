import { sha256Bytes } from "@bim-studio/deep-engine/shader-package";
import { dashboardTextRasterScale } from "./dashboardRasterDensity";
import type { DashboardRasterCompileInput, DashboardRasterResult, FrozenRasterAsset } from "./dashboardRasterTypes";

const HASH = /^[a-f0-9]{64}$/;
export const RASTER_BYTES_LIMIT = 64 * 1024 * 1024;
export function snapshotRasterInput(input: DashboardRasterCompileInput): DashboardRasterCompileInput {
  dashboardTextRasterScale(input.textRasterScale);
  let bytes = 0;
  for (const asset of Object.values(input.assets)) {
    if (!(asset.bytes instanceof Uint8Array) || !asset.bytes.length)
      throw new Error("Frozen resource byte identity mismatch");
    bytes += asset.bytes.byteLength;
    if (bytes > RASTER_BYTES_LIMIT) throw new Error("Frozen resource byte budget exceeded");
  }
  // structuredClone(view) 会复制整个 backing buffer；只冻结实际引用的字节范围。
  const copy = structuredClone({ ...input, assets: {} }) as DashboardRasterCompileInput;
  const assets: Record<string, FrozenRasterAsset> = {};
  for (const [id, asset] of Object.entries(input.assets)) {
    assets[id] = { ...structuredClone({ ...asset, bytes: undefined }), bytes: new Uint8Array(asset.bytes) };
  }
  const snapshot = { ...copy, assets };
  for (const asset of Object.values(snapshot.assets)) {
    if (!(asset.bytes instanceof Uint8Array) || !asset.bytes.length || !HASH.test(asset.sha256)
      || sha256Bytes(asset.bytes) !== asset.sha256) throw new Error("Frozen resource byte identity mismatch");
    if (!asset.identity.id || !Number.isSafeInteger(asset.identity.revision) || asset.identity.revision < 0
      || !asset.mime) throw new Error("Invalid frozen resource identity");
    if (asset.faceIndex !== undefined && (!Number.isSafeInteger(asset.faceIndex) || asset.faceIndex < 0))
      throw new Error("Invalid frozen font face index");
  }
  if (!copy.locale) throw new Error("Frozen locale is required");
  const pageIds = new Set(copy.document.application.pages.map(page => page.id));
  for (const [pageId, binding] of Object.entries(copy.pageAssets ?? {})) {
    const image = snapshot.assets[binding.image];
    if (!pageIds.has(pageId) || !image || !image.mime.startsWith("image/") || image.faceIndex !== undefined)
      throw new Error("Invalid frozen page image binding");
  }
  return snapshot;
}
export function assetIdentity(asset: FrozenRasterAsset) {
  return { sha256: asset.sha256, bytes: asset.bytes.byteLength, mime: asset.mime,
    identity: asset.identity, ...(asset.faceIndex === undefined ? {} : { faceIndex: asset.faceIndex }) };
}
export function rasterExtent(width: number, height: number): void {
  if (![width, height].every(v => Number.isSafeInteger(v) && v >= 1 && v <= 8192)
    || width * height * 4 > RASTER_BYTES_LIMIT) throw new Error("Invalid raster extent or byte budget");
}
export function verifyRaster(result: DashboardRasterResult, requestHash: string, width: number, height: number,
  fonts?: readonly FrozenRasterAsset[]): DashboardRasterResult {
  rasterExtent(width, height);
  if (result.width !== width || result.height !== height || !(result.rgba instanceof Uint8Array)
    || result.rgba.byteLength !== width * height * 4)
    throw new Error("Raster result dimensions, request or pixel identity mismatch");
  const copy = { ...structuredClone({ ...result, rgba: undefined }), rgba: new Uint8Array(result.rgba) };
  rasterExtent(copy.width, copy.height);
  if (copy.width !== width || copy.height !== height || copy.requestHash !== requestHash
    || !(copy.rgba instanceof Uint8Array) || copy.rgba.byteLength !== width * height * 4
    || !HASH.test(copy.sha256) || sha256Bytes(copy.rgba) !== copy.sha256)
    throw new Error("Raster result dimensions, request or pixel identity mismatch");
  if (copy.format !== "rgba8unorm-srgb" || copy.alphaMode !== "straight"
    || !HASH.test(copy.sourceSha256) || !copy.producer.id || !copy.producer.version)
    throw new Error("Raster producer evidence is incomplete");
  if (copy.producerEvidence && (copy.producerEvidence.scope !== "native-text-raster"
    || copy.producerEvidence.sourceSha256 !== copy.sourceSha256 || copy.producerEvidence.pixelSha256 !== copy.sha256
    || !HASH.test(copy.producerEvidence.executableSha256) || !copy.producerEvidence.producer))
    throw new Error("Native executable evidence mismatch");
  if (fonts) {
    if (!copy.producerEvidence) throw new Error("Native text producer evidence is required");
    if (!Array.isArray(copy.usedFaces) || !Array.isArray(copy.lines)) throw new Error("Font/layout evidence is required");
    for (const face of copy.usedFaces) {
      if (!fonts.some(font => font.sha256 === face.sha256 && font.faceIndex === face.faceIndex)
        || !face.family || !face.postScriptName || !Number.isInteger(face.weight) || face.weight < 1 || face.weight > 1000
        || !["normal", "italic", "oblique"].includes(face.style)) throw new Error("Unexpected raster font face");
    }
    for (const line of copy.lines) {
      if (!Number.isSafeInteger(line.lineIndex) || line.lineIndex < 0
        || ![line.baseline, line.top, line.height, line.width].every(Number.isFinite)
        || line.height < 0 || line.width < 0) throw new Error("Invalid measured text line");
    }
    if (copy.rgba.some((value, index) => index % 4 === 3 && value > 0) && copy.usedFaces.length === 0)
      throw new Error("Visible text pixels require actual font evidence");
  }
  return copy;
}
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
