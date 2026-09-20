import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { emitRayTraceKernelWgsl } from "./rayTraceKernel.js";
import { emitTwoLevelRayTraceKernelWgsl, RAY_TRACE_TLAS_BINDINGS, RAY_TRACE_TLAS_ENTRY_POINT } from "./rayTraceTlasKernel.js";
import { BVH_LEAF_SENTINEL, RAY_TRACE_STACK_CAPACITY, RAY_TRACE_WORKGROUP_SIZE } from "./rayTraceLayout.js";

/**
 * 单级发射零变化合同：sha256 字节级钉死（2026-09-20 TLAS 扩展前基线）。
 * 有意变更单级内核必须：更新此钉 + 复核两级内核共享片段（WGSL_CORE/WGSL_HELPERS）语义 +
 * 重跑 test:ray-trace-gpu 真机对拍。两级发射合同用锚点断言（结构而非字节）。
 */
const SINGLE_LEVEL_WGSL_SHA256 = "8fd69bf302b1395e246785c5f54ea77104152321aa3cd64d6550466f75ccae80";

describe("two-level ray trace kernel generation contract", () => {
  const wgsl = emitTwoLevelRayTraceKernelWgsl();

  it("keeps the single-level emission byte-identical to the pre-TLAS baseline", () => {
    const sha = createHash("sha256").update(emitRayTraceKernelWgsl()).digest("hex");
    expect(sha).toBe(SINGLE_LEVEL_WGSL_SHA256);
  });

  it("is deterministic across emissions and interpolates shared layout constants", () => {
    expect(emitTwoLevelRayTraceKernelWgsl()).toBe(wgsl);
    expect(wgsl).toContain(`const STACK_CAPACITY: u32 = ${RAY_TRACE_STACK_CAPACITY}u;`);
    expect(wgsl).toContain(`const SENTINEL: u32 = ${BVH_LEAF_SENTINEL}u;`);
    expect(wgsl).toContain(`@workgroup_size(${RAY_TRACE_WORKGROUP_SIZE})`);
    expect(wgsl).toContain("@compute");
    expect(wgsl).toContain(`fn ${RAY_TRACE_TLAS_ENTRY_POINT}(`);
  });

  it("binds all nine slots in executor order with at most 8 storage buffers", () => {
    expect(RAY_TRACE_TLAS_BINDINGS).toHaveLength(9);
    RAY_TRACE_TLAS_BINDINGS.forEach((entry, index) => {
      expect(entry.binding).toBe(index);
      const pattern = `@binding(${index}) var<${entry.type === "uniform" ? "uniform" : entry.type === "storage" ? "storage, read_write" : "storage, read"}>`;
      expect(wgsl).toContain(pattern);
      expect(wgsl).toContain(`${entry.name}:`);
    });
    expect(wgsl.match(/var<storage/gu)?.length).toBe(8);
  });

  it("declares the TlasInstance struct in the contracted 128B order", () => {
    const struct = wgsl.slice(wgsl.indexOf("struct TlasInstance"), wgsl.indexOf("struct Params"));
    const fields = ["boundsMin: vec4f", "boundsMax: vec4f", "row0: vec4f", "row1: vec4f", "row2: vec4f",
      "meta0: vec4u", "pad0: vec4u", "pad1: vec4u"];
    let cursor = 0;
    for (const field of fields) {
      const at = struct.indexOf(field, cursor);
      expect(at).toBeGreaterThanOrEqual(0);
      cursor = at + field.length;
    }
  });

  it("mirrors the traceTlasClosest t-scaling and mask contracts verbatim", () => {
    expect(wgsl).toContain("(metaWords.y & params.rayMask) == 0u");
    expect(wgsl).toContain("let normalized = localDir / scale;");
    expect(wgsl).toContain("let localTMax = tMax * scale;");
    expect(wgsl).toContain("let worldT = localT / scale;");
    expect(wgsl).toContain("if (worldT <= tMax && worldT < bestWorldT)");
    // 退化方向（scale≤0，含 NaN）整实例跳过，与 CPU directionScale 守卫同语义。
    expect(wgsl).toContain("if (!(scale > 0.0)) { continue; }");
  });

  it("addresses the concatenated global buffers via the placement bases", () => {
    expect(wgsl).toContain("tlasInstances[node.leftFirst + local]");
    expect(wgsl).toContain("nodes[nodeBase + stack[sp]]");
    expect(wgsl).toContain("triangleOrder[triangleBase + node.leftFirst + local]");
    expect(wgsl).toContain("traceBlasClosest(localOrigin, normalized, localInv, localTMax, metaWords.z, metaWords.w, &prim, &overflowFlag)");
  });

  it("fails closed on both stack levels and carries instanceIndex in slot 4", () => {
    expect(wgsl.match(/if \(sp \+ 2u > STACK_CAPACITY\) \{/gu)?.length).toBe(2);
    expect(wgsl.match(/atomicAdd\(&stackOverflows, 1u\);/gu)?.length).toBe(2);
    expect(wgsl).toContain("hitRecords[rayIndex] = HitRecord(select(-1.0, bestWorldT, status == STATUS_HIT), bestPrim, status, bestInstance);");
    expect(wgsl.match(/hitRecords\[rayIndex\]/gu)?.length).toBe(1);
    const body = wgsl.slice(wgsl.indexOf(`fn ${RAY_TRACE_TLAS_ENTRY_POINT}`));
    expect(body.indexOf("if (rayIndex >= params.rayCount) { return; }")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("rayStream[")).toBeGreaterThan(body.indexOf("if (rayIndex >= params.rayCount) { return; }"));
  });
});
