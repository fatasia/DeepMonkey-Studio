import {
  validateDashboardOfflineArchive,
  type DashboardOfflineArchiveV1,
  type ValidatedDashboardOfflineArchive,
} from "./dashboardOfflineArchive.js";

/** A small deterministic envelope: magic, manifest length, canonical manifest, then package bytes. */
const MAGIC = Uint8Array.of(0x44, 0x4d, 0x44, 0x41, 0x01, 0x00, 0x00, 0x00); // DMDA v1
const HEADER_BYTES = MAGIC.byteLength + 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const DASHBOARD_OFFLINE_ARCHIVE_MEDIA_TYPE = "application/vnd.deep-engine.dashboard-offline-archive;version=1";

/**
 * Produces the transport bytes for a C5 archive. The manifest stays readable
 * JSON, while the runtime package remains byte-for-byte identical to C4's
 * canonical artifact.
 */
export function serializeDashboardOfflineArchive(archive: DashboardOfflineArchiveV1): Uint8Array {
  const verified = validateDashboardOfflineArchive(archive);
  const manifest = canonicalBytes(verified.archive.manifest);
  if (manifest.byteLength > 0xffff_ffff) throw new Error("Dashboard offline archive manifest is too large");
  const bytes = new Uint8Array(HEADER_BYTES + manifest.byteLength + verified.archive.artifact.byteLength);
  bytes.set(MAGIC);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(MAGIC.byteLength, manifest.byteLength, false);
  bytes.set(manifest, HEADER_BYTES);
  bytes.set(verified.archive.artifact, HEADER_BYTES + manifest.byteLength);
  return bytes;
}

/**
 * Parses only the deterministic C5 envelope and then delegates every content
 * and provenance check to the archive contract.
 */
export function parseDashboardOfflineArchive(bytes: Uint8Array): ValidatedDashboardOfflineArchive {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_BYTES + 1) {
    throw new Error("Dashboard offline archive bytes are truncated");
  }
  if (!sameBytes(bytes.subarray(0, MAGIC.byteLength), MAGIC)) throw new Error("Unsupported dashboard offline archive byte format");
  const manifestLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.byteLength, false);
  const manifestEnd = HEADER_BYTES + manifestLength;
  if (manifestLength === 0 || manifestEnd >= bytes.byteLength) throw new Error("Dashboard offline archive byte lengths are invalid");
  let manifest: unknown;
  try {
    const text = decoder.decode(bytes.subarray(HEADER_BYTES, manifestEnd));
    manifest = JSON.parse(text);
    if (!sameBytes(encoder.encode(text), canonicalBytes(manifest))) {
      throw new Error("Dashboard offline archive manifest is not canonical");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Dashboard offline archive manifest is not canonical") throw error;
    throw new Error("Dashboard offline archive manifest is not valid UTF-8 JSON");
  }
  return validateDashboardOfflineArchive({ manifest: manifest as DashboardOfflineArchiveV1["manifest"], artifact: bytes.slice(manifestEnd) });
}

function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonical(value));
}

function canonical(value: unknown): string {
  return JSON.stringify(sort(value));
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
