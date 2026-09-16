import type { RenderPacket } from "../renderPacket.js";
import type { SpatialItemId } from "../spatial/types.js";
import type { GltfAnimationImportOptions } from "./animationTypes.js";
import {
  decodeAnimatedMorphSkinnedDocument,
  type DecodedAnimatedMorphSkinnedGlb,
  type GltfAnimatedMorphSkinnedImportOptions,
} from "./decodeAnimatedMorphSkinnedGlb.js";
import { decodeTexturedGltfDocument, type TexturedGltfImportOptions } from "./decodeTexturedGltf.js";
import type { GltfMorphImportTuning } from "./morphTypes.js";
import { parseGlb } from "./parseGlb.js";
import type { GltfRenderInstanceProjection } from "./renderAnimationBridgeTypes.js";
import type { GltfSkinImportTuning } from "./skinTypes.js";
import type { GltfImageDecoder } from "./textureTypes.js";
import {
  RuntimeDecodeTrace,
  type RuntimeDecodeOutcome,
  type RuntimeDecodeTelemetryHooks,
} from "./runtimeDecodeTelemetry.js";
import { abortSignal, invalid, list, object, reference, validateJson, type JsonObject } from "./validation.js";
import { validateAnimationDocument } from "./animationImportValidation.js";

type AnimationTuning<TNodeId extends SpatialItemId> = Omit<GltfAnimationImportOptions<TNodeId>, "sceneIndex" | "mapNodeId" | "signal">;

export interface RuntimeGlbImportOptions<TNodeId extends SpatialItemId = number> extends TexturedGltfImportOptions {
  readonly mapNodeId?: (sourceNodeIndex: number, name: string | undefined) => TNodeId;
  readonly animation?: AnimationTuning<TNodeId>;
  readonly morph?: GltfMorphImportTuning<TNodeId>;
  readonly skinning?: GltfSkinImportTuning<TNodeId>;
  readonly maxDeformationBytes?: number;
  /** Opt-in only: both the monotonic clock and bounded recorder are caller-owned. */
  readonly telemetry?: RuntimeDecodeTelemetryHooks;
}

export interface DecodedRuntimeGlb<TNodeId extends SpatialItemId = number>
  extends DecodedAnimatedMorphSkinnedGlb<TNodeId> {
  readonly packet: RenderPacket;
  /** Ready for GltfRenderAnimationBridge's instances option. */
  readonly instanceProjection: GltfRenderInstanceProjection<TNodeId>;
}

function deformationDocument(json: unknown): JsonObject {
  const source = object(json, "$"), document: JsonObject = { ...source };
  delete document.extensionsUsed; delete document.extensionsRequired;
  return validateAnimationDocument(document);
}

function deformationOptions<TNodeId extends SpatialItemId>(
  options: RuntimeGlbImportOptions<TNodeId>,
): GltfAnimatedMorphSkinnedImportOptions<TNodeId> {
  const resourcePrefix = options.resourcePrefix ?? "gltf";
  if (options.morph?.resourcePrefix !== undefined && options.morph.resourcePrefix !== resourcePrefix) {
    invalid("options.morph.resourcePrefix", "Runtime morph resources must share the packet resource prefix.");
  }
  if (options.skinning?.resourcePrefix !== undefined && options.skinning.resourcePrefix !== resourcePrefix) {
    invalid("options.skinning.resourcePrefix", "Runtime skin resources must share the packet resource prefix.");
  }
  return {
    ...(options.sceneIndex === undefined ? {} : { sceneIndex: options.sceneIndex }),
    ...(options.mapNodeId === undefined ? {} : { mapNodeId: options.mapNodeId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxDeformationBytes === undefined ? {} : { maxDecodedBytes: options.maxDeformationBytes }),
    ...(options.animation === undefined ? {} : { animation: options.animation }),
    morph: { ...options.morph, resourcePrefix }, skinning: { ...options.skinning, resourcePrefix },
  };
}

function projectInstances<TNodeId extends SpatialItemId>(document: JsonObject, packet: RenderPacket,
  deformation: DecodedAnimatedMorphSkinnedGlb<TNodeId>, prefix: string): GltfRenderInstanceProjection<TNodeId> {
  const nodes = list(document.nodes, "nodes"), meshes = list(document.meshes, "meshes");
  const instances = new Map(packet.instances.map((instance) => [instance.id, instance] as const));
  const bindings = deformation.animation.nodes.flatMap((selected) => {
    const path = `nodes[${selected.sourceNodeIndex}]`, node = object(nodes[selected.sourceNodeIndex], path);
    if (node.mesh === undefined) return [];
    const meshIndex = reference(meshes, node.mesh, `${path}.mesh`);
    const primitives = list(object(meshes[meshIndex], `meshes[${meshIndex}]`).primitives, `meshes[${meshIndex}].primitives`);
    return primitives.map((_, primitiveIndex) => {
      const id = `${prefix}/node/${selected.sourceNodeIndex}/primitive/${primitiveIndex}`, instance = instances.get(id);
      if (!instance) invalid(path, "Runtime packet is missing the selected mesh instance.");
      return Object.freeze({ nodeId: selected.id, id, geometry: instance.geometry, material: instance.material });
    });
  });
  return Object.freeze({ materials: packet.materials, bindings: Object.freeze(bindings) });
}

/**
 * Imports one embedded GLB into a render packet plus synchronized transform,
 * morph, and skin sources without reparsing or external IO.
 */
export async function decodeRuntimeGlb<TNodeId extends SpatialItemId = number>(
  bytes: Uint8Array,
  imageDecoder: GltfImageDecoder | undefined,
  options: RuntimeGlbImportOptions<TNodeId> = {},
): Promise<DecodedRuntimeGlb<TNodeId>> {
  object(options, "options"); const signal = abortSignal(options.signal, "options.signal");
  if (options.telemetry) return await decodeTimedGlb(bytes, imageDecoder, options);
  signal?.throwIfAborted();
  const parsed = parseGlb(bytes);
  validateJson(parsed.json);
  return await decodeDocument(parsed.json, parsed.buffers, imageDecoder, options);
}

/** Caller-owned glTF document/buffer counterpart to decodeRuntimeGlb; it never performs IO. */
export async function decodeRuntimeGltf<TNodeId extends SpatialItemId = number>(
  json: unknown,
  buffers: readonly Uint8Array[],
  imageDecoder: GltfImageDecoder | undefined,
  options: RuntimeGlbImportOptions<TNodeId> = {},
): Promise<DecodedRuntimeGlb<TNodeId>> {
  object(options, "options"); const signal = abortSignal(options.signal, "options.signal");
  if (options.telemetry) return await decodeTimedGltf(json, buffers, imageDecoder, options);
  signal?.throwIfAborted();
  validateJson(json); return await decodeDocument(json, buffers, imageDecoder, options);
}

async function decodeDocument<TNodeId extends SpatialItemId>(json: unknown, buffers: readonly Uint8Array[],
  imageDecoder: GltfImageDecoder | undefined, options: RuntimeGlbImportOptions<TNodeId>,
): Promise<DecodedRuntimeGlb<TNodeId>> {
  const deformation = decodeAnimatedMorphSkinnedDocument(
    deformationDocument(json), buffers, deformationOptions(options),
  );
  options.signal?.throwIfAborted();
  const packet = await decodeTexturedGltfDocument(json, buffers, imageDecoder, options, true);
  options.signal?.throwIfAborted();
  const instanceProjection = projectInstances(object(json, "$"), packet, deformation, options.resourcePrefix ?? "gltf");
  return Object.freeze({ ...deformation, packet, instanceProjection });
}

async function decodeTimedGlb<TNodeId extends SpatialItemId>(bytes: Uint8Array,
  imageDecoder: GltfImageDecoder | undefined, options: RuntimeGlbImportOptions<TNodeId>,
): Promise<DecodedRuntimeGlb<TNodeId>> {
  const trace = new RuntimeDecodeTrace(options.telemetry!, "glb"); let decodedBytes = 0;
  try {
    options.signal?.throwIfAborted();
    const parsed = trace.measure("parse", () => { const value = parseGlb(bytes); validateJson(value.json); return value; });
    const decoded = await decodeTimedDocument(parsed.json, parsed.buffers, imageDecoder, options, trace,
      value => { decodedBytes = value; });
    trace.finish("success", decodedBytes); return decoded;
  } catch (error) {
    if (!trace.finished) trace.finish(outcome(error, options.signal), decodedBytes, error);
    throw error;
  }
}

async function decodeTimedGltf<TNodeId extends SpatialItemId>(json: unknown, buffers: readonly Uint8Array[],
  imageDecoder: GltfImageDecoder | undefined, options: RuntimeGlbImportOptions<TNodeId>,
): Promise<DecodedRuntimeGlb<TNodeId>> {
  const trace = new RuntimeDecodeTrace(options.telemetry!, "gltf"); let decodedBytes = 0;
  try {
    options.signal?.throwIfAborted();
    trace.measure("parse", () => validateJson(json));
    const decoded = await decodeTimedDocument(json, buffers, imageDecoder, options, trace,
      value => { decodedBytes = value; });
    trace.finish("success", decodedBytes); return decoded;
  } catch (error) {
    if (!trace.finished) trace.finish(outcome(error, options.signal), decodedBytes, error);
    throw error;
  }
}

async function decodeTimedDocument<TNodeId extends SpatialItemId>(json: unknown, buffers: readonly Uint8Array[],
  imageDecoder: GltfImageDecoder | undefined, options: RuntimeGlbImportOptions<TNodeId>, trace: RuntimeDecodeTrace,
  reportBytes: (value: number) => void,
): Promise<DecodedRuntimeGlb<TNodeId>> {
  const deformation = trace.measure("deformation", () => decodeAnimatedMorphSkinnedDocument(
    deformationDocument(json), buffers, deformationOptions(options)));
  let decodedBytes = deformation.decodedBytes; reportBytes(decodedBytes); options.signal?.throwIfAborted();
  const packet = await trace.measureAsync("texturedImageDecode",
    async () => await decodeTexturedGltfDocument(json, buffers, imageDecoder, options, true));
  decodedBytes += packetDecodedBytes(packet); reportBytes(decodedBytes); options.signal?.throwIfAborted();
  const instanceProjection = trace.measure("projection", () => projectInstances(
    object(json, "$"), packet, deformation, options.resourcePrefix ?? "gltf"));
  return Object.freeze({ ...deformation, packet, instanceProjection });
}

function packetDecodedBytes(packet: RenderPacket): number {
  let total = 0;
  for (const geometry of packet.geometries) {
    total += geometry.vertices.byteLength + geometry.indices.byteLength + (geometry.uv0?.byteLength ?? 0)
      + (geometry.uv1?.byteLength ?? 0) + (geometry.tangents?.byteLength ?? 0);
  }
  for (const texture of packet.textures ?? []) {
    total += texture.data.byteLength;
    for (const level of texture.mipmaps ?? []) total += level.data.byteLength;
  }
  if (!Number.isSafeInteger(total)) throw new Error("Runtime decoded byte count exceeds the safe integer range.");
  return total;
}

function outcome(error: unknown, signal: AbortSignal | undefined): RuntimeDecodeOutcome {
  return signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "aborted" : "failure";
}
