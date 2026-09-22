import { createHash } from "node:crypto";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** Deployment-local measurements only. Callers still verify producer identity and frozen binds. */
export function createDashboardLayoutCaptureCache(identity, { maxEntries = 32, maxBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 32
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error("Invalid layout cache budget");
  const entries = new Map(); let bytes = 0;
  const producer = structuredClone(identity);
  const key = request => hash(JSON.stringify({ producer, ...request,
    fonts: request.fonts.map(({ bytes, ...font }) => ({ ...font, sha256: hash(bytes) })) }));
  return {
    get(request, signal) {
      signal?.throwIfAborted(); const id = key(request), entry = entries.get(id);
      signal?.throwIfAborted();
      if (!entry) return undefined;
      entries.delete(id); entries.set(id, entry); return structuredClone(entry.value);
    },
    put(request, value, signal) {
      signal?.throwIfAborted(); const id = key(request), stored = structuredClone(value);
      const cost = Buffer.byteLength(JSON.stringify(stored));
      if (cost > Math.min(maxBytes, 4 * 1024 * 1024)) return;
      if (entries.has(id)) { bytes -= entries.get(id).cost; entries.delete(id); }
      while (entries.size >= maxEntries || bytes + cost > maxBytes) {
        const oldest = entries.keys().next().value; bytes -= entries.get(oldest).cost; entries.delete(oldest);
      }
      signal?.throwIfAborted(); entries.set(id, { value: stored, cost }); bytes += cost;
    },
    stats: () => ({ entries: entries.size, bytes }),
  };
}
