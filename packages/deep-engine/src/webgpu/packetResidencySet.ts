import type { GpuRenderResidencyRequest } from "./gpuRenderResidencyRuntime.js";
import type { PacketResidencyTicket } from "./packetResidencyDomain.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";

export interface PacketResidencySetEntry {
  readonly ticket: PacketResidencyTicket;
  readonly requests?: readonly GpuRenderResidencyRequest[];
  /** False loads optional prefetch resources without acquiring a drawable projection. */
  readonly project?: boolean;
  readonly allowPartialLod?: boolean;
}

export interface PacketResidencySetLoadOptions {
  readonly frame: number;
  readonly entries: readonly PacketResidencySetEntry[];
  readonly signal?: AbortSignal;
}

export interface PacketResidencySetProjection {
  readonly ticket: PacketResidencyTicket;
  readonly projection: ResidentPacketProjection;
}

/** Merges shared identities while preserving the strongest quality and requirement. */
export function mergePacketResidencyRequests(
  groups: readonly (readonly GpuRenderResidencyRequest[])[],
): readonly GpuRenderResidencyRequest[] {
  const merged = new Map<string, GpuRenderResidencyRequest>();
  for (const group of groups) for (const request of group) {
    const key = `${request.kind}\u0000${request.id}`, previous = merged.get(key);
    if (!previous) {
      merged.set(key, Object.freeze({ ...request })); continue;
    }
    merged.set(key, Object.freeze({ kind: request.kind, id: request.id,
      desiredLevel: Math.min(previous.desiredLevel, request.desiredLevel),
      priority: Math.max(previous.priority ?? 0, request.priority ?? 0),
      required: previous.required === true || request.required === true }));
  }
  return Object.freeze([...merged.values()]);
}

export function releasePacketResidencySet(
  values: readonly PacketResidencySetProjection[],
): unknown[] {
  const failures: unknown[] = [];
  for (let index = values.length - 1; index >= 0; index--) {
    try { values[index]!.projection.release(); }
    catch (error) { failures.push(error); }
  }
  return failures;
}
