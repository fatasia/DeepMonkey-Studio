import { GltfImportError } from "@bim-studio/deep-engine/gltf";
import { normalizeStudioWasmModel } from "../viewer/normalizeStudioModel";
import { decodeAuthorModel, isAuthorModelNormalizationFailure } from "./authorModelDecode";
import { inProcessImageDecoder } from "./inProcessImageDecoder";
import { authorModelTransferBuffers } from "./authorModelTransfer";
import type { AuthorModelWorkerRequest, AuthorModelWorkerReply, AuthorModelFailure } from "./authorModelWorkerClient";
import { persistentAuthorModelDecoder } from "./persistentAuthorModelDecoder";

const decode = persistentAuthorModelDecoder((bytes, options, signal) =>
  decodeAuthorModel(bytes, options, signal, normalizeStudioWasmModel, inProcessImageDecoder));

const scope = globalThis as unknown as {
  onmessage: ((event: { data: AuthorModelWorkerRequest }) => void) | null;
  postMessage(reply: AuthorModelWorkerReply, transfer?: ArrayBuffer[]): void;
};
scope.onmessage = async ({ data }) => {
  try {
    const result = await decode(data.bytes, data.options, new AbortController().signal);
    scope.postMessage({ id: data.id, result }, authorModelTransferBuffers(result));
  } catch (reason) {
    const error: AuthorModelFailure = { message: reason instanceof Error ? reason.message : String(reason),
      ...(isAuthorModelNormalizationFailure(reason) ? { normalization: true } : {}),
      ...(reason instanceof GltfImportError ? { gltf: { code: reason.code, path: reason.path,
        ...(reason.feature === undefined ? {} : { feature: reason.feature }) } } : {}) };
    scope.postMessage({ id: data.id, error });
  }
};
