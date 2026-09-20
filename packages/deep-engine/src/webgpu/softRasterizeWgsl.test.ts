import { describe, expect, it } from "vitest";
import { emitSoftRasterizeWgsl, SOFT_RASTERIZE_BINDINGS,
  SOFT_RASTERIZE_ENTRY_POINT } from "./softRasterizeWgsl.js";
import { VISIBILITY_CLEAR_SLOT, VISIBILITY_TRIANGLE_MASK } from "./visibilityBufferEncoding.js";

describe("soft rasterize kernel contract", () => {
  it("interpolates constants from the encoding contract as the single source of truth", () => {
    const wgsl = emitSoftRasterizeWgsl();
    expect(wgsl).toContain(`const CLEAR_SLOT: u32 = ${VISIBILITY_CLEAR_SLOT}u;`);
    expect(wgsl).toContain(`const TRIANGLE_MASK: u32 = ${VISIBILITY_TRIANGLE_MASK}u;`);
  });

  it("declares the entry point, bindings in contract order, and 10-float triangle stride", () => {
    const wgsl = emitSoftRasterizeWgsl();
    expect(wgsl).toContain(`fn ${SOFT_RASTERIZE_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u)`);
    const bindings = SOFT_RASTERIZE_BINDINGS.map(binding => binding.binding);
    expect(bindings).toEqual([0, 1, 2, 3, 4, 5]);
    expect(wgsl).toContain("let base = triangleIndex * 10u;");
    expect(wgsl).toContain("let localIndex = u32(triangles[base + 9u]);");
    expect(wgsl).toContain("@workgroup_size(64)");
  });

  it("keeps the depth-less z rejection and per-triangle fault channels", () => {
    const wgsl = emitSoftRasterizeWgsl();
    expect(wgsl).toContain("if (depth < visibilityDepth[pixel]) {");
    expect(wgsl).toContain("atomicAdd(&softRasterFaults[0], 1u);");
    expect(wgsl).toContain("if (area <= 0.0) { return; }");
    expect(wgsl).toContain("if (slot >= CLEAR_SLOT)");
  });

  it("emits structurally deterministic output across calls", () => {
    expect(emitSoftRasterizeWgsl()).toBe(emitSoftRasterizeWgsl());
  });
});
