import { decodeDeformablePacketGlb, type DeformablePacketGlb, type GltfImageDecoder } from "@bim-studio/deep-engine/gltf";
import { capImageDimension, glbEmbeddedImageDimensions, textureDimensionCap } from "./textureBudget";

export interface AuthorModelDecodeOptions {
  readonly resourcePrefix: string;
  readonly modelId: string;
  readonly maxDecodedBytes: number;
  readonly textureBudgetBytes?: number;
  readonly liveDeformation?: boolean;
  readonly advancedMaterials?: boolean;
  readonly preserveTexCoords?: boolean;
}
export interface AuthorModelDecodeResult {
  readonly normalizedBytes: Uint8Array;
  readonly decoded: DeformablePacketGlb;
}
export type AuthorModelDecoder = (bytes: Uint8Array, options: AuthorModelDecodeOptions,
  signal: AbortSignal) => Promise<AuthorModelDecodeResult>;
const normalizationFailures = new WeakSet<object>();
export function markAuthorModelNormalizationFailure(error: object): void { normalizationFailures.add(error); }
export function isAuthorModelNormalizationFailure(error: unknown): boolean {
  return !!error && typeof error === "object" && normalizationFailures.has(error);
}

/** Same normalization/import and image budget as the synchronous compiler path. */
export async function decodeAuthorModel(bytes: Uint8Array, options: AuthorModelDecodeOptions,
  signal: AbortSignal, normalize: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>,
  imageDecoder: GltfImageDecoder): Promise<AuthorModelDecodeResult> {
  let normalizedBytes: Uint8Array;
  try { normalizedBytes = await normalize(bytes, signal); }
  catch (error) { if (error && typeof error === "object") markAuthorModelNormalizationFailure(error); throw error; }
  signal.throwIfAborted();
  if (normalizedBytes.byteLength > options.maxDecodedBytes)
    throw new Error(`对象 ${options.modelId} 的解压模型超过场景预算`);
  const cap = options.textureBudgetBytes === undefined ? undefined
    : textureDimensionCap(glbEmbeddedImageDimensions(normalizedBytes), options.textureBudgetBytes);
  const decoded = await decodeDeformablePacketGlb(normalizedBytes,
    cap === undefined ? imageDecoder : capImageDimension(imageDecoder, cap), {
      resourcePrefix: options.resourcePrefix, signal, imageDecodeConcurrency: 2,
      ...(options.liveDeformation ? { liveDeformation: true } : {}),
      ...(options.advancedMaterials ? { advancedMaterials: true } : {}),
      ...(options.preserveTexCoords ? { preserveTexCoords: true } : {}),
    });
  signal.throwIfAborted();
  return { normalizedBytes, decoded };
}
