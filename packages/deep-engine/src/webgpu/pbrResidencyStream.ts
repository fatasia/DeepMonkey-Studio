import type { PreparedPacket } from "../renderPacketTypes.js";
import type { PacketResidencyDomain, PacketResidencyTicket } from "./packetResidencyDomain.js";
import {
  createPacketResidencyWorkingSet,
  PacketResidencyWorkingSetError,
  type PacketResidencyWorkingSetLoad,
  type PacketResidencyWorkingSetOptions,
} from "./packetResidencyWorkingSet.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import { runResourceCleanup } from "./resourceCleanup.js";

/** PbrRenderer satisfies this contract; successful staging transfers projection ownership. */
export interface PbrResidencyFrameTarget {
  stageResidentPacketValidated(projection: ResidentPacketProjection, signal?: AbortSignal): Promise<void>;
  /** Cancels only work that has not crossed the render frame boundary. */
  cancelResidentPacketStage(): void;
}

export type PbrResidencyStreamOptions = PacketResidencyWorkingSetOptions;

export interface PbrResidencyStageResult {
  readonly frame: number;
}

export interface PbrResidencyStream {
  readonly disposed: boolean;
  readonly pending: boolean;
  readonly latestFrame: number;
  /** Loads a partial-LOD closure and stages it for the target's next render boundary. */
  stage(input: PacketResidencyWorkingSetLoad): Promise<PbrResidencyStageResult>;
  /** Cancels queued load/stage work and candidate ownership; submitted GPU commands finish safely. */
  dispose(): void;
}

interface StageOperation {
  readonly frame: number;
  readonly controller: AbortController;
  readonly detachExternalAbort: () => void;
  cancellation?: PacketResidencyWorkingSetError;
}

/**
 * Connects visibility demand to validated PBR staging. The target must be used
 * exclusively by this stream while live so a newer accepted request can revoke
 * the older unpublished candidate. Publication remains in PbrRenderer.render().
 */
export function createPbrResidencyStream(
  domain: PacketResidencyDomain,
  ticket: PacketResidencyTicket,
  packet: PreparedPacket,
  target: PbrResidencyFrameTarget,
  options: PbrResidencyStreamOptions = {},
): PbrResidencyStream {
  validateTarget(target);
  const workingSet = createPacketResidencyWorkingSet(domain, ticket, packet, options);
  let disposed = false;
  let current: StageOperation | undefined;

  return Object.freeze({
    get disposed() { return disposed; },
    get pending() { return current !== undefined; },
    get latestFrame() { return workingSet.latestFrame; },
    stage(input: PacketResidencyWorkingSetLoad): Promise<PbrResidencyStageResult> {
      if (disposed) return Promise.reject(streamError("disposed", "PBR residency stream is disposed."));
      const controller = new AbortController();
      const detachExternalAbort = forwardAbort(input?.signal, controller, () => {
        if (current?.controller === controller && !current.cancellation) {
          current.cancellation = streamError("aborted", "PBR residency stage was aborted.", input.signal?.reason);
        }
      });
      const revision = workingSet.requestRevision;
      const load = workingSet.load({ ...input, signal: controller.signal });
      if (workingSet.requestRevision === revision) {
        detachExternalAbort();
        return rejectUnexpectedProjection(load);
      }
      const operation: StageOperation = { frame: input.frame, controller, detachExternalAbort };
      const previous = current;
      current = operation;
      if (previous) cancel(previous, "superseded", `PBR residency frame ${input.frame} superseded an earlier stage.`);
      try { target.cancelResidentPacketStage(); }
      catch (error) {
        operation.cancellation = streamError("aborted", "PBR residency target rejected candidate invalidation.", error);
        controller.abort(operation.cancellation);
      }
      return execute(operation, load);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const operation = current; current = undefined;
      if (operation) cancel(operation, "disposed", "PBR residency stream is disposed.");
      runResourceCleanup("PBR residency stream disposal failed.", [
        () => target.cancelResidentPacketStage(), () => workingSet.dispose(),
      ]);
    },
  });

  async function execute(operation: StageOperation,
    load: Promise<ResidentPacketProjection>): Promise<PbrResidencyStageResult> {
    let projection: ResidentPacketProjection | undefined;
    try {
      projection = await load;
      if (operation.cancellation) throw operation.cancellation;
      await target.stageResidentPacketValidated(projection, operation.controller.signal);
      if (operation.cancellation) throw operation.cancellation;
      return Object.freeze({ frame: operation.frame });
    } catch (error) {
      const failure = operation.cancellation ?? error;
      const cleanup: unknown[] = [];
      if (projection) {
        if (current === operation) try { target.cancelResidentPacketStage(); }
        catch (cleanupError) { cleanup.push(cleanupError); }
        if (!projection.released) try { projection.release(); }
        catch (cleanupError) { cleanup.push(cleanupError); }
      }
      if (cleanup.length) throw new AggregateError([failure, ...cleanup], "PBR residency stage rollback failed.");
      throw failure;
    } finally {
      operation.detachExternalAbort();
      if (current === operation) current = undefined;
    }
  }
}

function cancel(operation: StageOperation,
  code: "disposed" | "superseded", message: string): void {
  operation.cancellation ??= streamError(code, message);
  operation.controller.abort(operation.cancellation);
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController,
  onAbort: () => void): () => void {
  if (!signal) return () => {};
  const abort = () => { onAbort(); controller.abort(signal.reason); };
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

async function rejectUnexpectedProjection(load: Promise<ResidentPacketProjection>): Promise<never> {
  const projection = await load;
  try { projection.release(); }
  catch (cause) { throw new AggregateError([cause], "Rejected PBR residency load cleanup failed."); }
  throw new Error("Rejected PBR residency load unexpectedly produced a projection.");
}

function streamError(code: "aborted" | "disposed" | "superseded", message: string,
  cause?: unknown): PacketResidencyWorkingSetError {
  return new PacketResidencyWorkingSetError(code, message,
    cause === undefined ? undefined : { cause });
}

function validateTarget(target: PbrResidencyFrameTarget): void {
  if (!target || typeof target !== "object"
    || typeof target.stageResidentPacketValidated !== "function"
    || typeof target.cancelResidentPacketStage !== "function") {
    throw new TypeError("PBR residency frame target is invalid.");
  }
}
