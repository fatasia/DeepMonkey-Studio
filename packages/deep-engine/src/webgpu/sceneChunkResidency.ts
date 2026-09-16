import type { PreparedPacket } from "../renderPacketTypes.js";
import type { GpuResidencyExecutorOptions, ResidencyBudgets } from "../streaming/index.js";
import type { DeviceSession } from "./deviceSession.js";
import type { GpuRenderResidencyTelemetrySnapshot } from "./gpuRenderResidencyTelemetry.js";
import { createPacketResidencyDomain, type PacketResidencyTicket } from "./packetResidencyDomain.js";
import { createPacketResidencyRequestPlanner, type PacketResidencyDemand,
  type PacketResidencyRequestPlanner } from "./packetResidencyRequestPlanner.js";
import type { PacketResidencySetEntry,
  PacketResidencySetProjection } from "./packetResidencySet.js";
import { createResidentSceneChunkFrame, releaseSceneChunkProjections,
  type ResidentSceneChunkFrame } from "./sceneChunkResidencyFrame.js";
export type { ResidentSceneChunk, ResidentSceneChunkFrame } from "./sceneChunkResidencyFrame.js";

export type SceneChunkResidencyMode = "visible" | "prefetch";
export type SceneChunkResidencyErrorCode = "aborted" | "disposed" | "stale-frame" | "superseded";

export class SceneChunkResidencyError extends Error {
  constructor(readonly code: SceneChunkResidencyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "SceneChunkResidencyError";
  }
}

export interface SceneChunkResidencyDemand {
  readonly key: string;
  readonly mode: SceneChunkResidencyMode;
  readonly demands: readonly PacketResidencyDemand[];
  readonly textureMipLevels?: ReadonlyMap<string, number>;
}

export interface SceneChunkResidencyFrameInput {
  readonly frame: number;
  /** Omitted chunks leave the desired set and become eligible for eviction. */
  readonly chunks: readonly SceneChunkResidencyDemand[];
  readonly signal?: AbortSignal;
}

export interface SceneChunkResidencyOptions {
  readonly meshlets?: boolean;
  readonly executor?: GpuResidencyExecutorOptions;
  readonly onDiscardError?: (error: unknown) => void;
}

export interface SceneChunkResidency {
  readonly disposed: boolean;
  readonly pending: boolean;
  readonly latestFrame: number;
  /** Number of global domain.loadSet submissions issued by accepted scene updates. */
  readonly submittedFrameCount: number;
  readonly chunkCount: number;
  readonly lastDiscardError: unknown;
  telemetrySnapshot(): GpuRenderResidencyTelemetrySnapshot;
  registerChunk(key: string, packet: PreparedPacket): void;
  unregisterChunk(key: string): void;
  /** Abort/supersession stops queued uploads and rolls back candidates; submitted GPU commands finish safely. */
  update(input: SceneChunkResidencyFrameInput): Promise<ResidentSceneChunkFrame>;
  dispose(): void;
}

interface ChunkState {
  readonly ticket: PacketResidencyTicket;
  readonly planner: PacketResidencyRequestPlanner;
}
interface PendingUpdate {
  readonly generation: number;
  readonly frame: number;
  readonly controller: AbortController;
  readonly resolve: (value: ResidentSceneChunkFrame) => void;
  readonly reject: (error: unknown) => void;
  detachExternalAbort?: () => void;
  settled: boolean;
}

/** Owns one domain so every chunk shares collision checks, GPU handles, and a global budget. */
export function createSceneChunkResidency(session: DeviceSession, budgets: ResidencyBudgets,
  options: SceneChunkResidencyOptions = {}): SceneChunkResidency {
  validateOptions(options);
  const domain = createPacketResidencyDomain(session,
    { ...budgets, retainFrames: budgets.retainFrames ?? 0 }, { ...options.executor,
      ...(options.meshlets === undefined ? {} : { meshlets: options.meshlets }) });
  const chunks = new Map<string, ChunkState>();
  let disposed = false, latestFrame = -1, generation = 0, submittedFrameCount = 0;
  let current: PendingUpdate | undefined, lastDiscardError: unknown;

  return Object.freeze({
    get disposed() { return disposed; },
    get pending() { return current !== undefined; },
    get latestFrame() { return latestFrame; },
    get submittedFrameCount() { return submittedFrameCount; },
    get chunkCount() { return chunks.size; },
    get lastDiscardError() { return lastDiscardError; },
    telemetrySnapshot: () => domain.telemetrySnapshot(),
    registerChunk(key: string, packet: PreparedPacket): void {
      assertOpen(); assertIdle(); validateKey(key);
      if (chunks.has(key)) throw new Error(`Scene residency chunk is already registered: ${key}.`);
      const planner = createPacketResidencyRequestPlanner(packet);
      const ticket = domain.registerPacket(key, packet);
      chunks.set(key, Object.freeze({ ticket, planner }));
    },
    unregisterChunk(key: string): void {
      assertOpen(); assertIdle();
      const chunk = knownChunk(key);
      domain.unregister(chunk.ticket); chunks.delete(key);
    },
    update(input: SceneChunkResidencyFrameInput): Promise<ResidentSceneChunkFrame> {
      if (disposed) return Promise.reject(failure("disposed", "Scene chunk residency is disposed."));
      let planned: ReturnType<typeof planFrame>;
      try {
        validateFrame(input, latestFrame);
        if (input.signal?.aborted) return Promise.reject(abortFailure(input.signal));
        planned = planFrame(input.chunks, chunks);
      } catch (error) { return Promise.reject(error); }
      latestFrame = input.frame;
      if (current) settle(current, failure("superseded",
        `Scene residency frame ${input.frame} superseded an earlier update.`));
      let resolve!: PendingUpdate["resolve"], reject!: PendingUpdate["reject"];
      const promise = new Promise<ResidentSceneChunkFrame>((accept, decline) => {
        resolve = accept; reject = decline;
      });
      const operation: PendingUpdate = { generation: ++generation, frame: input.frame,
        controller: new AbortController(), resolve, reject, settled: false };
      if (input.signal) {
        const abort = () => settle(operation, abortFailure(input.signal!));
        input.signal.addEventListener("abort", abort, { once: true });
        operation.detachExternalAbort = () => input.signal!.removeEventListener("abort", abort);
      }
      current = operation;
      void execute(operation, planned);
      return promise;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; generation += 1;
      if (current) settle(current, failure("disposed", "Scene chunk residency is disposed."));
      chunks.clear(); domain.dispose();
    },
  });

  async function execute(operation: PendingUpdate, planned: ReturnType<typeof planFrame>): Promise<void> {
    try {
      submittedFrameCount += 1;
      const values = await domain.loadSet({ frame: operation.frame, entries: planned.entries,
        signal: operation.controller.signal });
      if (operation.settled || current !== operation || operation.generation !== generation || disposed) {
        discard(values); return;
      }
      const frame = createResidentSceneChunkFrame(operation.frame, values, planned.keysByTicket);
      finish(operation); operation.settled = true; operation.resolve(frame);
    } catch (error) {
      if (operation.settled) {
        if (!hasCause(error, operation.controller.signal.reason)
          && !(disposed && hasErrorCode(error, "disposed"))) recordDiscardError(error);
        return;
      }
      finish(operation); operation.settled = true; operation.reject(error);
    }
  }

  function settle(operation: PendingUpdate, error: SceneChunkResidencyError): void {
    if (operation.settled) return;
    operation.settled = true; operation.controller.abort(error);
    finish(operation); operation.reject(error);
  }
  function finish(operation: PendingUpdate): void {
    operation.detachExternalAbort?.();
    if (current === operation) current = undefined;
  }
  function discard(values: readonly PacketResidencySetProjection[]): void {
    const failures = releaseSceneChunkProjections(values.map(value => value.projection));
    if (!failures.length) return;
    recordDiscardError(failures.length === 1 ? failures[0] : new AggregateError(failures,
      "Discarded scene chunk projections failed to release."));
  }
  function recordDiscardError(error: unknown): void {
    lastDiscardError = error;
    try { options.onDiscardError?.(error); }
    catch (callbackError) { lastDiscardError = new AggregateError([error, callbackError],
      "Scene chunk discard reporting failed."); }
  }
  function assertOpen(): void { if (disposed) throw new Error("Scene chunk residency is disposed."); }
  function assertIdle(): void { if (current) throw new Error("Scene chunk residency is updating."); }
  function knownChunk(key: string): ChunkState {
    validateKey(key); const value = chunks.get(key);
    if (!value) throw new Error(`Unknown scene residency chunk: ${key}.`);
    return value;
  }
}

function planFrame(inputs: readonly SceneChunkResidencyDemand[], chunks: ReadonlyMap<string, ChunkState>) {
  const entries: PacketResidencySetEntry[] = [], keysByTicket = new Map<PacketResidencyTicket, string>();
  const seen = new Set<string>();
  for (const input of inputs) {
    validateChunkDemand(input);
    if (seen.has(input.key)) throw new TypeError(`Duplicate scene residency chunk demand: ${input.key}.`);
    seen.add(input.key);
    const chunk = chunks.get(input.key);
    if (!chunk) throw new Error(`Unknown scene residency chunk: ${input.key}.`);
    let requests = chunk.planner.plan(input.demands,
      input.textureMipLevels ? { textureMipLevels: input.textureMipLevels } : undefined);
    if (input.mode === "prefetch") requests = Object.freeze(requests.map(request =>
      Object.freeze({ ...request, required: false })));
    entries.push(Object.freeze({ ticket: chunk.ticket, requests,
      project: input.mode === "visible", allowPartialLod: true }));
    if (input.mode === "visible") keysByTicket.set(chunk.ticket, input.key);
  }
  return Object.freeze({ entries: Object.freeze(entries), keysByTicket });
}

function validateFrame(input: SceneChunkResidencyFrameInput, latestFrame: number): void {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Number.isSafeInteger(input.frame) || input.frame < 0 || !Array.isArray(input.chunks)
    || (input.signal !== undefined && !isAbortSignal(input.signal))) {
    throw new TypeError("Scene chunk residency frame is invalid.");
  }
  if (input.frame < latestFrame) throw failure("stale-frame",
    `Scene residency frame regressed from ${latestFrame} to ${input.frame}.`);
}
function validateChunkDemand(input: SceneChunkResidencyDemand): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.key !== "string"
    || (input.mode !== "visible" && input.mode !== "prefetch") || !Array.isArray(input.demands)
    || (input.textureMipLevels !== undefined && !(input.textureMipLevels instanceof Map))) {
    throw new TypeError("Scene chunk residency demand is invalid.");
  }
}
function validateOptions(options: SceneChunkResidencyOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || (options.meshlets !== undefined && typeof options.meshlets !== "boolean")
    || (options.executor !== undefined && (!options.executor || typeof options.executor !== "object"))
    || (options.onDiscardError !== undefined && typeof options.onDiscardError !== "function")) {
    throw new TypeError("Scene chunk residency options are invalid.");
  }
}
function validateKey(key: string): void {
  if (typeof key !== "string" || !key.trim() || key.length > 256) throw new TypeError("Scene chunk key is invalid.");
}
function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function";
}
function abortFailure(signal: AbortSignal): SceneChunkResidencyError {
  return failure("aborted", "Scene chunk residency update was aborted.", signal.reason);
}
function failure(code: SceneChunkResidencyErrorCode, message: string, cause?: unknown): SceneChunkResidencyError {
  return new SceneChunkResidencyError(code, message, cause === undefined ? undefined : { cause });
}

function hasCause(error: unknown, expected: unknown): boolean {
  const seen = new Set<unknown>(); let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current === expected) return true;
    seen.add(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { readonly cause?: unknown }).cause : undefined;
  }
  return false;
}

function hasErrorCode(error: unknown, expected: string): boolean {
  const seen = new Set<unknown>(); let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (typeof current === "object" && "code" in current
      && (current as { readonly code?: unknown }).code === expected) return true;
    seen.add(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { readonly cause?: unknown }).cause : undefined;
  }
  return false;
}
