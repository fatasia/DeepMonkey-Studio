/** Walk metadata, never numeric typed-array elements; one transfer per backing store. */
export function authorModelTransferBuffers(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>(), seen = new Set<object>(), pending: unknown[] = [value];
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== "object" || seen.has(next)) continue;
    seen.add(next);
    if (next instanceof ArrayBuffer) buffers.add(next);
    else if (ArrayBuffer.isView(next)) {
      if (next.buffer instanceof ArrayBuffer) buffers.add(next.buffer);
    } else pending.push(...Object.values(next));
  }
  return [...buffers];
}

/** Retain source ownership without one large synchronous slice on the author thread. */
export async function copyAuthorModelBytes(source: Uint8Array, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  const output = new Uint8Array(source.byteLength), chunk = 4 * 1024 * 1024;
  for (let offset = 0; offset < source.byteLength; offset += chunk) {
    output.set(source.subarray(offset, Math.min(source.byteLength, offset + chunk)), offset);
    if (offset + chunk < source.byteLength) await new Promise<void>(resolve => setTimeout(resolve, 0));
    signal.throwIfAborted();
  }
  return output;
}
