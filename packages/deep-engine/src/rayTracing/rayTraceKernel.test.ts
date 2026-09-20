import { describe, expect, it } from "vitest";
import { BVH_LEAF_SENTINEL, RAY_TRACE_STACK_CAPACITY, RAY_TRACE_WORKGROUP_SIZE } from "./rayTraceLayout.js";
import { emitRayTraceKernelWgsl, RAY_TRACE_BINDINGS, RAY_TRACE_ENTRY_POINT } from "./rayTraceKernel.js";

/** kernel 生成合同：布局常量单一来源插值 + fail-closed 结构 + 与 CPU 参考的语义锚点。 */
describe("ray trace kernel generation contract", () => {
  const wgsl = emitRayTraceKernelWgsl();

  it("is deterministic across emissions", () => {
    expect(emitRayTraceKernelWgsl()).toBe(wgsl);
  });

  it("interpolates layout constants from the single source of truth", () => {
    expect(wgsl).toContain(`const STACK_CAPACITY: u32 = ${RAY_TRACE_STACK_CAPACITY}u;`);
    expect(wgsl).toContain(`const SENTINEL: u32 = ${BVH_LEAF_SENTINEL}u;`);
    expect(wgsl).toContain(`@workgroup_size(${RAY_TRACE_WORKGROUP_SIZE})`);
    expect(wgsl).toContain(`fn ${RAY_TRACE_ENTRY_POINT}(`);
    expect(wgsl).toContain("@compute");
  });

  it("declares the BvhNode struct in the contracted byte order", () => {
    const struct = wgsl.slice(wgsl.indexOf("struct BvhNode"), wgsl.indexOf("struct HitRecord"));
    const fields = ["boundMin: vec4f", "boundMax: vec4f", "leftFirst: u32", "count: u32", "rightChild: u32", "pad0: u32"];
    let cursor = 0;
    for (const field of fields) {
      const at = struct.indexOf(field, cursor);
      expect(at).toBeGreaterThanOrEqual(0);
      cursor = at + field.length;
    }
  });

  it("binds all eight storage/uniform slots in executor order", () => {
    RAY_TRACE_BINDINGS.forEach((entry, index) => {
      expect(entry.binding).toBe(index);
      const pattern = `@binding(${index}) var<${entry.type === "uniform" ? "uniform" : entry.type === "storage" ? "storage, read_write" : "storage, read"}>`;
      expect(wgsl).toContain(pattern);
      expect(wgsl).toContain(`${entry.name}:`);
    });
  });

  it("keeps the Moller-Trumbore rejection contract identical to the CPU reference", () => {
    expect(wgsl).toContain("const DET_EPSILON: f32 = 1e-20;");
    expect(wgsl).toContain("if (abs(det) < DET_EPSILON) { return -1.0; }");
    expect(wgsl).toContain("if (u < 0.0 || u > 1.0) { return -1.0; }");
    expect(wgsl).toContain("if (v < 0.0 || u + v > 1.0) { return -1.0; }");
    expect(wgsl).toContain("return dot(e2, q) * inv;");
  });

  it("mirrors the CPU parallel-axis slab branch (never 0*Inf=NaN culling)", () => {
    expect(wgsl).toContain("if (dir != 0.0) {");
    expect(wgsl).toContain("return origin >= lo && origin <= hi;");
  });

  it("fails closed on stack overflow instead of silently truncating", () => {
    expect(wgsl).toContain("atomicAdd(&stackOverflows, 1u);");
    expect(wgsl).toContain("status = STATUS_OVERFLOW;");
    expect(wgsl).toContain(`if (sp + 2u > STACK_CAPACITY) {`);
    expect(wgsl.indexOf("atomicAdd")).toBeLessThan(wgsl.indexOf("hitRecords[rayIndex] = HitRecord"));
  });

  it("writes exactly one record per ray and misses report t=-1", () => {
    expect(wgsl).toContain("hitRecords[rayIndex] = HitRecord(select(-1.0, bestT, status == STATUS_HIT), bestPrim, status, 0u);");
    expect(wgsl.match(/hitRecords\[rayIndex\]/gu)?.length).toBe(1);
  });

  it("guards out-of-range lanes before any buffer access", () => {
    const body = wgsl.slice(wgsl.indexOf(`fn ${RAY_TRACE_ENTRY_POINT}`));
    const guard = body.indexOf("if (rayIndex >= params.rayCount) { return; }");
    const firstAccess = body.indexOf("rayStream[");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(firstAccess);
  });
});
