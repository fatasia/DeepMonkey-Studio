import { describe, expect, it } from "vitest";
import { resolveRayTracingCapability } from "./rayTracingCapability.js";

describe("ray tracing capability", () => {
  it("enables only supported requested backends", () => {
    expect(resolveRayTracingCapability({ backend: "native", supported: true, requested: true })).toMatchObject({ enabled: true, backend: "native" });
    expect(resolveRayTracingCapability({ backend: "webgpu", supported: false, requested: true }).enabled).toBe(false);
  });
});
