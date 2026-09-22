import { sha256Bytes } from "../shaderPackage/hash.js";
import { array, fields, integer, record, requireValue, revision, string } from "./primitives.js";
import type { DashboardVideoMediaV1 } from "./dashboardVideoTypes.js";

export const DASHBOARD_VIDEO_MEDIA_BYTES_LIMIT = 32 * 1024 * 1024;
const MP4_BRANDS = new Set(["isom", "iso2", "mp41", "mp42"]);

export function probeDashboardVideoMedia(bytes: Uint8Array, mime: string): "mp4-isobmff" {
  requireValue(mime === "video/mp4", "$.mime", "Only video/mp4 is accepted by the first offline media profile.");
  requireValue(bytes.byteLength >= 16 && bytes.byteLength <= DASHBOARD_VIDEO_MEDIA_BYTES_LIMIT, "$.bytes", "Video media exceeds its byte budget or is empty.");
  const boxLength = bytes[0]! * 0x1000000 + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!;
  const type = String.fromCharCode(...bytes.subarray(4, 8));
  const major = String.fromCharCode(...bytes.subarray(8, 12));
  requireValue(type === "ftyp" && boxLength >= 16 && boxLength <= bytes.byteLength && boxLength % 4 === 0,
    "$.bytes", "Video is not a bounded ISO BMFF file with a leading ftyp box.");
  let supportedBrand = MP4_BRANDS.has(major);
  for (let offset = 16; !supportedBrand && offset + 4 <= boxLength; offset += 4)
    supportedBrand = MP4_BRANDS.has(String.fromCharCode(...bytes.subarray(offset, offset + 4)));
  requireValue(supportedBrand, "$.bytes", "ISO BMFF file lacks the supported isom/iso2/mp41/mp42 brand profile.");
  return "mp4-isobmff";
}

export function validateDashboardVideoMedia(value: unknown, path: string): Map<string, DashboardVideoMediaV1> {
  const media = array(value, path, 32), byId = new Map<string, DashboardVideoMediaV1>();
  requireValue(media.length > 0, path, "Packaged video media must not be empty.");
  let total = 0;
  for (const [index, candidate] of media.entries()) {
    const itemPath = `${path}[${index}]`, item = record(candidate, itemPath);
    fields(item, ["id", "revision", "format", "mime", "byteLength", "sha256", "dataBase64"], [], itemPath);
    const id = string(item.id, `${itemPath}.id`), sha256 = string(item.sha256, `${itemPath}.sha256`);
    requireValue(id === `media.${sha256}` && /^[a-f0-9]{64}$/.test(sha256) && !byId.has(id), itemPath, "Invalid or duplicate content-addressed media identity.");
    requireValue(revision(item.revision, `${itemPath}.revision`) === 1, `${itemPath}.revision`, "Content-addressed video revision must be 1.");
    const mime = string(item.mime, `${itemPath}.mime`), format = string(item.format, `${itemPath}.format`);
    requireValue(format === "mp4-isobmff", `${itemPath}.format`, "Unsupported packaged video format.");
    const encoded = string(item.dataBase64, `${itemPath}.dataBase64`);
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0)); }
    catch { throw new Error(`${itemPath}.dataBase64: Invalid video base64.`); }
    requireValue(encoded === bytesToBase64(bytes), `${itemPath}.dataBase64`, "Video base64 must use canonical RFC 4648 encoding.");
    requireValue(integer(item.byteLength, 1, DASHBOARD_VIDEO_MEDIA_BYTES_LIMIT, `${itemPath}.byteLength`) === bytes.byteLength,
      `${itemPath}.byteLength`, "Video byte length differs from its payload.");
    requireValue(sha256Bytes(bytes) === sha256, `${itemPath}.sha256`, "Video byte hash mismatch.");
    requireValue(probeDashboardVideoMedia(bytes, mime) === format, itemPath, "Video format probe mismatch.");
    total += bytes.byteLength;
    requireValue(total <= DASHBOARD_VIDEO_MEDIA_BYTES_LIMIT, path, "Dashboard packaged video budget exceeded.");
    byId.set(id, item as unknown as DashboardVideoMediaV1);
  }
  return byId;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
