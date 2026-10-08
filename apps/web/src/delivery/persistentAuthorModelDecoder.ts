import { STOCK_MATERIAL_INSTANCE_OPTIONS, validateRenderPacketAsync } from "@bim-studio/deep-engine";
import type { AuthorModelDecoder, AuthorModelDecodeOptions } from "./authorModelDecode";
import { authorModelTransferBuffers } from "./authorModelTransfer";
import { createAuthorAssetStore, type AuthorAssetStore } from "./authorAssetStore";

// Bump whenever normalization/import semantics change. Source and every decode option are part of identity.
const SCHEMA = "author-decode-20261008-v1";
export async function authorAssetKey(bytes: Uint8Array, options: AuthorModelDecodeOptions): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return JSON.stringify([SCHEMA, hash, bytes.byteLength, options.resourcePrefix, options.maxDecodedBytes,
    options.textureBudgetBytes ?? null, options.liveDeformation === true,
    options.advancedMaterials === true, options.preserveTexCoords === true]);
}

/** Optional persistent preprocessing; storage denial/quota/corruption must never prevent importing. */
export function persistentAuthorModelDecoder(decode: AuthorModelDecoder,
  store: AuthorAssetStore | undefined = typeof indexedDB === "undefined" ? undefined : createAuthorAssetStore(indexedDB)): AuthorModelDecoder {
  return async (bytes, options, signal) => {
    signal.throwIfAborted();
    if (!store) return decode(bytes, options, signal);
    let key: string | undefined;
    try {
      key = await authorAssetKey(bytes, options);
      let cached = await store.get(key);
      if (!cached && options.liveDeformation === true) {
        const shared = await store.get(await authorAssetKey(bytes, { ...options, liveDeformation: false }));
        if (shared?.decoded.mode === "static" && shared.decoded.features.length === 0) cached = shared;
      }
      signal.throwIfAborted();
      if (cached) {
        if (!(cached.normalizedBytes instanceof Uint8Array) || !cached.normalizedBytes.byteLength
          || cached.normalizedBytes.byteLength > options.maxDecodedBytes
          || !["static", "live", "bind-pose"].includes(cached.decoded.mode)
          || !Array.isArray(cached.decoded.features)
          || cached.decoded.features.some(feature => !["animations", "skins", "morphTargets"].includes(feature)))
          throw new Error("Invalid cached asset");
        await validateRenderPacketAsync(cached.decoded.packet, STOCK_MATERIAL_INSTANCE_OPTIONS, signal);
        signal.throwIfAborted();
        return cached;
      }
    } catch {
      signal.throwIfAborted();
      if (key) await store.remove(key).catch(() => {});
    }
    const result = await decode(bytes, options, signal);
    signal.throwIfAborted();
    if (key) {
      if (result.decoded.mode === "static" && result.decoded.features.length === 0 && options.liveDeformation === true)
        key = await authorAssetKey(bytes, { ...options, liveDeformation: false });
      // Complete the IDB structured clone before the worker transfers/detaches result buffers.
      const size = authorModelTransferBuffers(result).reduce((sum, buffer) => sum + buffer.byteLength, 0);
      await store.put(key, result, size).catch(() => {});
    }
    signal.throwIfAborted();
    return result;
  };
}
