import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import { createResidentPacketTextureLookup, type PacketTextureLookup } from "./packetTextureLookup.js";
import type { PacketGeometryBounds } from "./packetGeometryBounds.js";
import { gpuValidatedStage } from "./gpuValidatedStage.js";
import {
  commitResidentPacketBufferStage,
  discardResidentPacketBufferStage,
  stageResidentPacketBuffers,
  type ResidentPacketBufferPublication,
  type ResidentPacketBufferStagingContext,
  type StagedResidentPacketBuffers,
} from "./residentPacketBufferStaging.js";

interface PendingResidentPacket {
  readonly generation: number;
  readonly staged: StagedResidentPacketBuffers;
  readonly geometryBounds: ReadonlyMap<string, PacketGeometryBounds>;
  readonly textureLookup: PacketTextureLookup;
  rejectCancellation: ((reason: unknown) => void) | undefined;
}

export interface ResidentPacketBufferTransition {
  readonly current: ResidentPacketBufferStatePublication;
  readonly previous?: ResidentPacketBufferStatePublication;
}

export interface ResidentPacketBufferStatePublication extends ResidentPacketBufferPublication {
  readonly geometryBounds: ReadonlyMap<string, PacketGeometryBounds>;
  readonly textureLookup: PacketTextureLookup;
}

/** Owns pending and active streamed packet projections across render frame boundaries. */
export class ResidentPacketBufferState {
  private pendingValue: PendingResidentPacket | undefined;
  private activeValue: ResidentPacketBufferStatePublication | undefined;

  get active(): ResidentPacketBufferStatePublication | undefined { return this.activeValue; }
  get pending(): boolean { return this.pendingValue !== undefined; }

  stage(context: ResidentPacketBufferStagingContext,
    projection: ResidentPacketProjection, generation: number): boolean {
    if (this.pendingValue) throw new Error("A resident packet stage is already pending.");
    const staged = stageResidentPacketBuffers({ ...context,
      ...(this.activeValue ? { geometryBounds: this.activeValue.geometryBounds } : {}) }, projection);
    try {
      this.pendingValue = { generation, staged, rejectCancellation: undefined,
        geometryBounds: staged.geometryBounds,
        textureLookup: createResidentPacketTextureLookup(projection) };
    } catch (error) {
      try { discardResidentPacketBufferStage(context, staged); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Resident packet metadata rollback failed."); }
      throw error;
    }
    return staged.changed;
  }

  async stageValidated(context: ResidentPacketBufferStagingContext,
    projection: ResidentPacketProjection, generation: number,
    signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) throw cancelled();
    const staged = gpuValidatedStage(context.session.device,
      () => this.stage(context, projection, generation), "GPU resident packet preparation failed");
    const pending = this.pendingValue!;
    const cancellation = new Promise<never>((_, reject) => { pending.rejectCancellation = reject; });
    const cancel = (): void => { try { this.cancel(context, generation); } catch { /* promise carries cleanup failure */ } };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      await Promise.race([staged.checked, cancellation]);
      if (this.pendingValue !== pending) throw cancelled();
      return staged.value;
    } catch (error) {
      if (this.pendingValue === pending) {
        try { this.cancel(context, generation); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Resident packet validation rollback failed."); }
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      pending.rejectCancellation = undefined;
    }
  }

  publish(context: ResidentPacketBufferStagingContext,
    generation: number): ResidentPacketBufferTransition | undefined {
    const pending = this.pendingValue;
    if (!pending) return undefined;
    if (pending.generation !== generation) {
      this.cancel(context);
      throw cancelled("Resident packet stage was superseded.");
    }
    this.pendingValue = undefined;
    const publication = commitResidentPacketBufferStage(context, pending.staged);
    const current = Object.freeze({ ...publication,
      geometryBounds: pending.geometryBounds, textureLookup: pending.textureLookup });
    const previous = this.activeValue;
    this.activeValue = current;
    return { current, ...(previous ? { previous } : {}) };
  }

  cancel(context: ResidentPacketBufferStagingContext, generation?: number): void {
    const pending = this.pendingValue;
    if (!pending || (generation !== undefined && pending.generation !== generation)) return;
    this.pendingValue = undefined;
    try {
      discardResidentPacketBufferStage(context, pending.staged);
      pending.rejectCancellation?.(cancelled());
    } catch (error) {
      pending.rejectCancellation?.(error); throw error;
    }
  }

  detachActive(): ResidentPacketBufferStatePublication | undefined {
    const active = this.activeValue;
    this.activeValue = undefined;
    return active;
  }
}

function cancelled(message = "Resident packet validation was cancelled or superseded."): Error {
  const error = new Error(message); error.name = "AbortError"; return error;
}
