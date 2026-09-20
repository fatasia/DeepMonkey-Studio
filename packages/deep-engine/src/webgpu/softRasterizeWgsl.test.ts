import { describe, expect, it } from "vitest";
import { emitSoftRasterizeWgsl, SOFT_RASTERIZE_BINDINGS, SOFT_RASTERIZE_DEPTH_MIN_ENTRY_POINT,
  SOFT_RASTERIZE_DEPTH_KEY_CLEAR, SOFT_RASTERIZE_WRITE_ENTRY_POINT,
  SOFT_RASTERIZE_WORKGROUP_SIZE } from "./softRasterizeWgsl.js";
import { VISIBILITY_CLEAR_SLOT, VISIBILITY_TRIANGLE_MASK } from "./visibilityBufferEncoding.js";

describe("soft rasterize kernel contract", () => {
  it("interpolates constants from the encoding contract as the single source of truth", () => {
    const wgsl = emitSoftRasterizeWgsl();
    expect(wgsl).toContain(`const CLEAR_SLOT: u32 = ${VISIBILITY_CLEAR_SLOT}u;`);
    expect(wgsl).toContain(`const TRIANGLE_MASK: u32 = ${VISIBILITY_TRIANGLE_MASK}u;`);
    expect(wgsl).toContain(`const DEPTH_KEY_CLEAR: u32 = ${SOFT_RASTERIZE_DEPTH_KEY_CLEAR}u;`);
    expect(wgsl).toContain(`@workgroup_size(${SOFT_RASTERIZE_WORKGROUP_SIZE})`);
  });

  it("declares both phase entry points, bindings in contract order, and 10-float triangle stride", () => {
    const wgsl = emitSoftRasterizeWgsl();
    expect(wgsl).toContain(`fn ${SOFT_RASTERIZE_DEPTH_MIN_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u)`);
    expect(wgsl).toContain(`fn ${SOFT_RASTERIZE_WRITE_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u)`);
    const bindings = SOFT_RASTERIZE_BINDINGS.map(binding => binding.binding);
    expect(bindings).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(wgsl).toContain("let base = triangleIndex * 10u;");
    expect(wgsl).toContain("let localIndex = u32(triangles[base + 9u]);");
    // slotBase 必须经 params 读取（裸标识符无法解析，真机 WGSL 解析错误）。
    expect(wgsl).toContain("let slot = params.slotBase + triangleIndex;");
  });

  it("keeps the deterministic depth-min z rejection and per-triangle fault channels", () => {
    const wgsl = emitSoftRasterizeWgsl();
    // 两阶段确定性最小深度：先 atomicMin 单调键，dispatch 屏障后等键回写（顺序互换不变量）。
    expect(wgsl).toContain("atomicMin(&depthKeyScratch[pixel], depthKey(depth));");
    expect(wgsl).toContain("if (atomicLoad(&depthKeyScratch[pixel]) == depthKey(depth)) {");
    expect(wgsl).toContain("atomicAdd(&softRasterFaults[0], 1u);");
    expect(wgsl).toContain("if (area <= 0.0) { return; }");
    expect(wgsl).toContain("if (slot >= CLEAR_SLOT)");
    // WGSL 无 isFinite 内建：有限性守卫必须走可移植的 |v| ≤ FLT_MAX 判定（NaN/±inf 均被拒）。
    expect(wgsl).toContain("fn isFiniteF32(v: f32) -> bool {");
    expect(wgsl).toContain("if (!isFiniteF32(ax)");
    // write 阶段对故障守卫静默跳过：每故障三角 atomicAdd 恰一次。
    expect(wgsl.split("atomicAdd(&softRasterFaults[0], 1u);").length - 1).toBe(3);
    expect(wgsl.split("fn soft_rasterize_depth_min").length - 1).toBe(1);
    expect(wgsl.split("fn soft_rasterize_write").length - 1).toBe(1);
  });

  it("emits structurally deterministic output across calls", () => {
    expect(emitSoftRasterizeWgsl()).toBe(emitSoftRasterizeWgsl());
  });
});
