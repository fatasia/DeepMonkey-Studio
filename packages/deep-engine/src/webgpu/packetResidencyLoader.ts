import type {
  GeometryResource,
  PreparedBatch,
  PreparedMaterialTextures,
  PreparedPacket,
} from "../renderPacketTypes.js";
import type {
  GpuResidencyExecutorOptions,
  ResidencyBudgets,
} from "../streaming/index.js";
import type { PreparedTexture } from "../textures/decodedTexture.js";
import type { DeviceSession } from "./deviceSession.js";
import {
  GpuRenderResidencyRuntime,
  type GpuRenderResidencyFrameResult,
  type GpuRenderResidencyRequest,
} from "./gpuRenderResidencyRuntime.js";
import {
  createPacketResidencyCatalogFromSnapshot,
  type PacketResidencyCatalog,
} from "./packetResidencyCatalog.js";
import {
  foreignPacketResidencyRequest,
  incompletePacketResidency,
} from "./packetResidencyClosure.js";
import {
  createResidentPacketProjection,
  type ResidentPacketProjection,
} from "./residentPacketProjection.js";

export interface PacketResidencyLoadOptions {
  readonly frame: number;
  /** Defaults to the catalog's finest, required dependency closure. */
  readonly requests?: readonly GpuRenderResidencyRequest[];
  /** Allows absent finer/middle LOD geometry while preserving a complete drawable fallback. */
  readonly allowPartialLod?: boolean;
  readonly signal?: AbortSignal;
}

export type PacketResidencyLoadErrorCode =
  | "unbound-runtime"
  | "frame-rejected"
  | "partial-failure"
  | "incomplete-residency";

export class PacketResidencyLoadError extends Error {
  constructor(readonly code: PacketResidencyLoadErrorCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "PacketResidencyLoadError";
  }
}

export interface PacketResidencyLoader {
  readonly requests: readonly GpuRenderResidencyRequest[];
  /** Creates a source-bound runtime whose lifetime remains owned by the caller. */
  createRuntime(session: DeviceSession, budgets: ResidencyBudgets,
    options?: GpuResidencyExecutorOptions): GpuRenderResidencyRuntime;
  loadInto(runtime: GpuRenderResidencyRuntime, options: PacketResidencyLoadOptions):
  Promise<ResidentPacketProjection>;
}

/**
 * Owns one immutable CPU snapshot and accepts only runtimes it source-bound.
 * Runtime disposal remains the caller's responsibility.
 */
export function createPacketResidencyLoader(packet: PreparedPacket): PacketResidencyLoader {
  const snapshot = snapshotPacket(packet);
  const catalog = createPacketResidencyCatalogFromSnapshot(snapshot);
  const runtimes = new WeakSet<GpuRenderResidencyRuntime>();
  return Object.freeze({ requests: catalog.requests,
    createRuntime(session: DeviceSession, budgets: ResidencyBudgets,
      options?: GpuResidencyExecutorOptions): GpuRenderResidencyRuntime {
      const runtime = new GpuRenderResidencyRuntime(session, budgets, catalog.sourceFor, options);
      runtimes.add(runtime); return runtime;
    },
    async loadInto(runtime: GpuRenderResidencyRuntime,
      options: PacketResidencyLoadOptions): Promise<ResidentPacketProjection> {
      validateOptions(options);
      if (!runtimes.has(runtime)) throw new PacketResidencyLoadError("unbound-runtime",
        "Packet residency runtime was not created by this loader.");
      catalog.registerInto(runtime);
      const requests = options.requests ?? catalog.requests;
      const foreign = foreignPacketResidencyRequest(catalog, requests);
      if (foreign) throw new PacketResidencyLoadError("unbound-runtime",
        `Packet residency request does not belong to this loader: ${foreign}.`);
      const result = await submitFrame(runtime, options.frame, requests, options.signal);
      assertAppliedFrame(result, options.frame);
      assertCompleteResidency(snapshot, catalog, runtime, options.allowPartialLod === true);
      return createResidentPacketProjection(snapshot, (kind, id) => runtime.acquire(kind, id),
        options.allowPartialLod === true ? { allowPartialLod: true } : undefined);
    },
  });
}

async function submitFrame(runtime: GpuRenderResidencyRuntime, frame: number,
  requests: readonly GpuRenderResidencyRequest[],
  signal?: AbortSignal): Promise<GpuRenderResidencyFrameResult> {
  try { return await runtime.submit(frame, requests, signal); }
  catch (cause) {
    throw new PacketResidencyLoadError("frame-rejected",
      `Packet residency frame ${frame} failed before it was applied.`, { cause });
  }
}

function validateOptions(options: PacketResidencyLoadOptions): void {
  if (!options || typeof options !== "object" || !Number.isSafeInteger(options.frame) || options.frame < 0) {
    throw new TypeError("Packet residency load options are invalid.");
  }
  if (options.requests !== undefined && !Array.isArray(options.requests)) {
    throw new TypeError("Packet residency requests must be an array.");
  }
  if (options.allowPartialLod !== undefined && typeof options.allowPartialLod !== "boolean") {
    throw new TypeError("Packet partial LOD option must be a boolean.");
  }
  if (options.signal !== undefined && !isAbortSignal(options.signal)) {
    throw new TypeError("Packet residency signal is invalid.");
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function";
}

function assertAppliedFrame(result: GpuRenderResidencyFrameResult, frame: number): void {
  if (result.status !== "applied" || result.frame !== frame || !result.execution) {
    throw new PacketResidencyLoadError("frame-rejected",
      `Packet residency frame ${frame} was not applied.`,
      result.error === undefined ? undefined : { cause: result.error });
  }
  if (result.execution.commit.failedUploads.length || result.execution.uploadFailures.length) {
    throw new PacketResidencyLoadError("partial-failure",
      `Packet residency frame ${frame} contained failed uploads.`);
  }
}

function assertCompleteResidency(
  packet: PreparedPacket,
  catalog: PacketResidencyCatalog,
  runtime: Pick<GpuRenderResidencyRuntime, "get">,
  allowPartialLod: boolean,
): void {
  const failure = incompletePacketResidency(packet, catalog, runtime, allowPartialLod);
  if (failure) throw new PacketResidencyLoadError("incomplete-residency",
    `Packet dependency is not completely resident: ${failure.kind}:${failure.id}.`);
}

function snapshotPacket(packet: PreparedPacket): PreparedPacket {
  if (!packet || typeof packet !== "object") throw new TypeError("Prepared packet is invalid.");
  const geometries = new Map<string, GeometryResource>();
  for (const [key, source] of packet.geometries) geometries.set(key, snapshotGeometry(source));
  const textures = Object.freeze(packet.textures.map(snapshotTexture));
  const batches = Object.freeze(packet.batches.map(snapshotBatch));
  return Object.freeze({ geometries, textures, batches });
}

function snapshotGeometry(source: GeometryResource): GeometryResource {
  return Object.freeze({ ...source, vertices: source.vertices.slice(), indices: source.indices.slice(),
    ...(source.uv0 ? { uv0: source.uv0.slice() } : {}),
    ...(source.uv1 ? { uv1: source.uv1.slice() } : {}),
    ...(source.tangents ? { tangents: source.tangents.slice() } : {}),
  });
}

function snapshotTexture(source: PreparedTexture): PreparedTexture {
  return Object.freeze({ ...source, sampler: Object.freeze({ ...source.sampler }),
    levels: Object.freeze(source.levels.map(level => Object.freeze({ ...level, data: level.data.slice() }))),
  });
}

function snapshotBatch(source: PreparedBatch): PreparedBatch {
  return Object.freeze({ ...source,
    instanceIds: Object.freeze(source.instanceIds.slice()), data: source.data.slice(),
    ...(source.sortCenter ? { sortCenter: tuple3(source.sortCenter) } : {}),
    ...(source.textures ? { textures: snapshotMaterialTextures(source.textures) } : {}),
    ...(source.lod ? { lod: Object.freeze({ ...source.lod,
      levels: Object.freeze(source.lod.levels.map(level => Object.freeze({ ...level }))),
    }) } : {}),
  });
}

function snapshotMaterialTextures(source: PreparedMaterialTextures): PreparedMaterialTextures {
  return Object.freeze({ emissiveStrength: source.emissiveStrength,
    ...(source.baseColor ? { baseColor: Object.freeze({ ...source.baseColor,
      uvTransform: tuple6(source.baseColor.uvTransform) }) } : {}),
    ...(source.metallicRoughness ? { metallicRoughness: Object.freeze({ ...source.metallicRoughness,
      uvTransform: tuple6(source.metallicRoughness.uvTransform) }) } : {}),
    ...(source.normal ? { normal: Object.freeze({ ...source.normal,
      uvTransform: tuple6(source.normal.uvTransform) }) } : {}),
    ...(source.occlusion ? { occlusion: Object.freeze({ ...source.occlusion,
      uvTransform: tuple6(source.occlusion.uvTransform) }) } : {}),
    ...(source.emissive ? { emissive: Object.freeze({ ...source.emissive,
      uvTransform: tuple6(source.emissive.uvTransform) }) } : {}),
  });
}

function tuple3(value: readonly [number, number, number]): readonly [number, number, number] {
  return Object.freeze([value[0], value[1], value[2]]);
}

function tuple6(value: readonly [number, number, number, number, number, number]):
readonly [number, number, number, number, number, number] {
  return Object.freeze([value[0], value[1], value[2], value[3], value[4], value[5]]);
}
