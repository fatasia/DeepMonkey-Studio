import { createHash } from "node:crypto";
const hash = value => createHash("sha256").update(value).digest("hex");

/** Deployment-local, bounded cache of verified producer pixels, never compiler results. */
export function createDashboardTextRasterCache(nativeSha256, { maxBytes = 64 * 1024 * 1024, maxEntries = 128 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(nativeSha256) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 128) throw new Error("Invalid text cache identity or budget");
  const entries = new Map(); let bytes = 0;
  const key = request => hash(JSON.stringify({ nativeSha256, ...request,
    fonts: request.fonts.map(font => {
      if (!(font.bytes instanceof Uint8Array) || hash(font.bytes) !== font.sha256) throw new Error("Text cache frozen font hash mismatch");
      return { ...font, bytes: undefined };
    }) }));
  return Object.freeze({
    get(request, signal) {
      signal?.throwIfAborted();
      const id = key(request), entry = entries.get(id);
      signal?.throwIfAborted();
      if (!entry) return undefined;
      entries.delete(id); entries.set(id, entry);
      return structuredClone(entry.result);
    },
    put(request, result, signal) {
      signal?.throwIfAborted();
      const id = key(request);
      if (!(result.rgba instanceof Uint8Array) || result.width !== request.width || result.height !== request.height
        || result.rgba.byteLength !== result.width * result.height * 4 || hash(result.rgba) !== result.sha256
        || result.requestHash !== request.requestHash || result.producerEvidence?.executableSha256 !== nativeSha256
        || result.producerEvidence?.pixelSha256 !== result.sha256 || result.producerEvidence?.sourceSha256 !== result.sourceSha256)
        throw new Error("Text cache producer receipt or pixels mismatch");
      const stored = structuredClone(result);
      const cost = stored.rgba.byteLength + Buffer.byteLength(JSON.stringify({ ...stored, rgba: undefined }));
      if (cost > maxBytes) return;
      if (entries.has(id)) { bytes -= entries.get(id).cost; entries.delete(id); }
      while (entries.size >= maxEntries || bytes + cost > maxBytes) {
        const oldest = entries.keys().next().value; bytes -= entries.get(oldest).cost; entries.delete(oldest);
      }
      signal?.throwIfAborted(); entries.set(id, { result: stored, cost }); bytes += cost;
    },
    stats: () => ({ entries: entries.size, bytes, maxBytes, maxEntries }),
  });
}
