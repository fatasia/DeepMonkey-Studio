import { describe, expect, it } from "vitest";
import { resolveRayTracingDecision, validateRayTracingCapabilities, type RayTracingCapabilities } from "./rayTracingCapabilities.js";
const base: RayTracingCapabilities = { schemaVersion: 1, adapterId: "adapter-1", tier: "pipeline", features: { "acceleration-structure": true, "ray-query": true, "rt-pipeline": true }, maxAccelerationStructureBytes: 1024 };
describe("P4 ray tracing capability contract", () => {
  it("selects pipeline, then query, then deterministic fallback", () => { expect(resolveRayTracingDecision(base)).toMatchObject({ enabled: true, tier: "pipeline", fallbacks: [] }); const query = { ...base, tier: "query", features: { ...base.features, "rt-pipeline": false } } as RayTracingCapabilities; expect(resolveRayTracingDecision(query)).toMatchObject({ enabled: true, tier: "query" }); expect(resolveRayTracingDecision({ ...query, tier: "none", features: { ...query.features, "ray-query": false } })).toMatchObject({ enabled: false, tier: "none", fallbacks: ["raster", "software-gi", "software-shadows"] }); });
  it("validates a serializable snapshot", () => { expect(validateRayTracingCapabilities(base)).toBe(true); expect(validateRayTracingCapabilities({ ...base, features: { ...base.features, "rt-pipeline": 1 } })).toBe(false); });
});
