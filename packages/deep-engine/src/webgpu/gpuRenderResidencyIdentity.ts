import type { StreamedResourceKind } from "../streaming/index.js";
import type { GpuRenderResidencyIdentity } from "./gpuRenderResidencyRuntime.js";

export function publicIdentity(kind: StreamedResourceKind,
  id: string): GpuRenderResidencyIdentity {
  if ((kind !== "geometry" && kind !== "texture") || typeof id !== "string"
    || !id.trim() || id.length > 256) {
    throw new TypeError("Render residency identity is invalid.");
  }
  return Object.freeze({ kind, id });
}

export function identityKey(identity: GpuRenderResidencyIdentity): string {
  return `${identity.kind}\u0000${identity.id}`;
}

export function validSourceId(id: string): string {
  if (typeof id !== "string" || !id.trim() || id.length > 256) {
    throw new TypeError("Render residency source id is invalid.");
  }
  return id;
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
