import type { PreparedPacket } from "../renderPacketTypes.js";
import type {
  PacketResidencyDomain,
  PacketResidencyTicket,
} from "./packetResidencyDomain.js";
import {
  createPacketResidencyRequestPlanner,
  type PacketResidencyDemand,
  type PacketResidencyRequestPlanner,
} from "./packetResidencyRequestPlanner.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";

export type PacketResidencyWorkingSetErrorCode =
  | "aborted"
  | "disposed"
  | "stale-frame"
  | "superseded";

export class PacketResidencyWorkingSetError extends Error {
  constructor(readonly code: PacketResidencyWorkingSetErrorCode,
    message: string, options?: ErrorOptions) {
    super(message, options); this.name = "PacketResidencyWorkingSetError";
  }
}

export interface PacketResidencyWorkingSetLoad {
  readonly frame: number;
  readonly demands: readonly PacketResidencyDemand[];
  /** Desired base mip per referenced texture. */
  readonly textureMipLevels?: ReadonlyMap<string, number>;
  readonly signal?: AbortSignal;
}

export interface PacketResidencyWorkingSetOptions {
  /** Receives a failure while releasing a result that arrived after cancellation. */
  readonly onDiscardError?: (error: unknown) => void;
}

export interface PacketResidencyWorkingSet {
  readonly disposed: boolean;
  readonly pending: boolean;
  readonly latestFrame: number;
  /** Changes synchronously after each accepted load, including same-frame supersession. */
  readonly requestRevision: number;
  readonly lastDiscardError: unknown;
  load(input: PacketResidencyWorkingSetLoad): Promise<ResidentPacketProjection>;
  /** Cancels pending delivery without disposing the shared domain or its ticket. */
  dispose(): void;
}

interface PendingLoad {
  readonly generation: number;
  readonly controller: AbortController;
  detachExternalAbort?: () => void;
  readonly resolve: (projection: ResidentPacketProjection) => void;
  readonly reject: (error: unknown) => void;
  cancelled: boolean;
  settled: boolean;
}

/**
 * Converts per-frame visibility into a partial packet residency projection.
 * Only the latest uncompleted request may publish; callers own every projection
 * successfully returned from load().
 */
export function createPacketResidencyWorkingSet(
  domain: PacketResidencyDomain,
  ticket: PacketResidencyTicket,
  packet: PreparedPacket,
  options: PacketResidencyWorkingSetOptions = {},
): PacketResidencyWorkingSet {
  validateBindings(domain, ticket, packet, options);
  const planner = createPacketResidencyRequestPlanner(packet);
  const onDiscardError = options.onDiscardError;
  let disposed = false, latestFrame = -1, generation = 0, requestRevision = 0;
  let current: PendingLoad | undefined, lastDiscardError: unknown;

  return Object.freeze({
    get disposed() { return disposed; },
    get pending() { return current !== undefined; },
    get latestFrame() { return latestFrame; },
    get requestRevision() { return requestRevision; },
    get lastDiscardError() { return lastDiscardError; },
    load(input: PacketResidencyWorkingSetLoad): Promise<ResidentPacketProjection> {
      if (disposed) return Promise.reject(failure("disposed", "Packet residency working set is disposed."));
      let validated: PacketResidencyWorkingSetLoad;
      let requests: ReturnType<PacketResidencyRequestPlanner["plan"]>;
      try {
        validated = validateLoad(input, latestFrame);
        if (validated.signal?.aborted) return Promise.reject(abortFailure(validated.signal));
        requests = planner.plan(validated.demands,
          validated.textureMipLevels === undefined ? undefined
            : { textureMipLevels: validated.textureMipLevels });
      } catch (error) { return Promise.reject(error); }
      latestFrame = validated.frame;
      requestRevision += 1;
      if (current) cancel(current, failure("superseded",
        `Packet residency frame ${validated.frame} superseded an earlier request.`));

      let resolve!: PendingLoad["resolve"], reject!: PendingLoad["reject"];
      const result = new Promise<ResidentPacketProjection>((accept, decline) => {
        resolve = accept; reject = decline;
      });
      const operation: PendingLoad = { generation: ++generation,
        controller: new AbortController(),
        resolve, reject, cancelled: false, settled: false };
      if (validated.signal) {
        const abort = () => cancel(operation, abortFailure(validated.signal!));
        validated.signal.addEventListener("abort", abort, { once: true });
        operation.detachExternalAbort = () => validated.signal!.removeEventListener("abort", abort);
      }
      current = operation;
      void execute(operation, validated.frame, requests);
      return result;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; generation += 1;
      if (current) cancel(current, failure("disposed", "Packet residency working set is disposed."));
    },
  });

  async function execute(operation: PendingLoad, frame: number,
    requests: ReturnType<PacketResidencyRequestPlanner["plan"]>): Promise<void> {
    try {
      if (operation.cancelled) return;
      const projection = await domain.load(ticket,
        { frame, requests, allowPartialLod: true, signal: operation.controller.signal });
      if (operation.cancelled || current !== operation || disposed
        || operation.generation !== generation) {
        discard(projection); return;
      }
      finish(operation); operation.settled = true; operation.resolve(projection);
    } catch (error) {
      if (operation.cancelled) {
        const reason = operation.controller.signal.reason;
        if (!hasCause(error, reason)
          && !(hasErrorCode(reason, "disposed") && hasErrorCode(error, "disposed"))) {
          recordDiscardError(error);
        }
        return;
      }
      finish(operation); operation.settled = true; operation.reject(error);
    }
  }

  function cancel(operation: PendingLoad, error: PacketResidencyWorkingSetError): void {
    if (operation.cancelled || operation.settled) return;
    operation.cancelled = true; operation.settled = true;
    operation.controller.abort(error);
    finish(operation); operation.reject(error);
  }

  function finish(operation: PendingLoad): void {
    operation.detachExternalAbort?.();
    if (current === operation) current = undefined;
  }

  function discard(projection: ResidentPacketProjection): void {
    try { projection.release(); }
    catch (error) { recordDiscardError(error); }
  }

  function recordDiscardError(error: unknown): void {
    lastDiscardError = error;
    try { onDiscardError?.(error); }
    catch (callbackError) {
      lastDiscardError = new AggregateError([error, callbackError],
        "Packet residency discarded work reporting failed.");
    }
  }
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

function validateBindings(domain: PacketResidencyDomain, ticket: PacketResidencyTicket,
  packet: PreparedPacket, options: PacketResidencyWorkingSetOptions): void {
  if (!domain || typeof domain !== "object" || typeof domain.load !== "function") {
    throw new TypeError("Packet residency domain is invalid.");
  }
  if (!ticket || typeof ticket !== "object") throw new TypeError("Packet residency ticket is invalid.");
  if (!packet || typeof packet !== "object") throw new TypeError("Prepared packet is invalid.");
  if (!options || typeof options !== "object" || Array.isArray(options)
    || (options.onDiscardError !== undefined && typeof options.onDiscardError !== "function")) {
    throw new TypeError("Packet residency working set options are invalid.");
  }
}

function validateLoad(input: PacketResidencyWorkingSetLoad, latestFrame: number): PacketResidencyWorkingSetLoad {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Number.isSafeInteger(input.frame) || input.frame < 0
    || !Array.isArray(input.demands)
    || (input.textureMipLevels !== undefined && !(input.textureMipLevels instanceof Map))
    || (input.signal !== undefined && !isAbortSignal(input.signal))) {
    throw new TypeError("Packet residency working set load is invalid.");
  }
  if (input.frame < latestFrame) throw failure("stale-frame",
    `Packet residency frame regressed from ${latestFrame} to ${input.frame}.`);
  return input;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function";
}

function abortFailure(signal: AbortSignal): PacketResidencyWorkingSetError {
  return failure("aborted", "Packet residency working set load was aborted.", signal.reason);
}

function failure(code: PacketResidencyWorkingSetErrorCode, message: string,
  cause?: unknown): PacketResidencyWorkingSetError {
  return new PacketResidencyWorkingSetError(code, message,
    cause === undefined ? undefined : { cause });
}
