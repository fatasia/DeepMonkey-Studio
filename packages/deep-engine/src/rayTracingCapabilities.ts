/** P4 capability contract. Detection only; no rendering path is enabled here. */
export type RayTracingFeature = "acceleration-structure" | "ray-query" | "rt-pipeline";
export type RayTracingTier = "none" | "query" | "pipeline";
export interface RayTracingCapabilities {
  readonly schemaVersion: 1;
  readonly adapterId: string;
  readonly tier: RayTracingTier;
  readonly features: Readonly<Record<RayTracingFeature, boolean>>;
  readonly maxAccelerationStructureBytes: number;
}
export type RayTracingFallback = "raster" | "software-gi" | "software-shadows";
export interface RayTracingDecision { readonly enabled: boolean; readonly tier: RayTracingTier; readonly fallbacks: readonly RayTracingFallback[]; readonly reason: string | null }

export function resolveRayTracingDecision(capabilities: RayTracingCapabilities, requested: RayTracingTier = "pipeline"): RayTracingDecision {
  const pipeline = capabilities.tier === "pipeline" && capabilities.features["acceleration-structure"] && capabilities.features["rt-pipeline"];
  const query = capabilities.tier !== "none" && capabilities.features["acceleration-structure"] && capabilities.features["ray-query"];
  if (requested === "pipeline" && pipeline) return { enabled: true, tier: "pipeline", fallbacks: [], reason: null };
  if (requested !== "none" && query) return { enabled: true, tier: "query", fallbacks: ["software-shadows"], reason: "RT pipeline unavailable; using ray-query tier." };
  return { enabled: false, tier: "none", fallbacks: ["raster", "software-gi", "software-shadows"], reason: "Hardware ray tracing is unavailable; retaining raster/software paths." };
}

export function validateRayTracingCapabilities(input: unknown): input is RayTracingCapabilities {
  if (!input || typeof input !== "object") return false;
  const v = input as Partial<RayTracingCapabilities>;
  return v.schemaVersion === 1 && typeof v.adapterId === "string" && ["none", "query", "pipeline"].includes(v.tier as string) && Number.isSafeInteger(v.maxAccelerationStructureBytes) && (v.maxAccelerationStructureBytes as number) >= 0 && !!v.features && ["acceleration-structure", "ray-query", "rt-pipeline"].every(k => typeof (v.features as Record<string, unknown>)[k] === "boolean");
}
