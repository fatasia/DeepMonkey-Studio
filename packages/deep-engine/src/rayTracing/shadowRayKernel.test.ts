import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { emitShadowRayMaskKernelWgsl, packShadowRayUniform, SHADOW_RAY_MASK_BINDINGS,
  SHADOW_RAY_MASK_ENTRY_POINT } from "./shadowRayKernel.js";
import { BVH_BLAS_OCCLUDED_WGSL, BVH_INTERSECT_WGSL, BVH_SLAB_WGSL, bvhTraverseCoreWgsl } from "./bvhTraverseWgsl.js";
import { TLAS_OCCLUDED_WGSL } from "./bvhTraverseTlasWgsl.js";
import { RAY_TRACE_WORKGROUP_SIZE } from "./rayTraceLayout.js";

/**
 * 阴影 mask 内核发射合同：f32/f16 两档各自 sha256 字节级钉死（2026-10-03 compute BVH
 * 骨架基线）。有意变更必须：更新钉值 + 复核 bvhTraverseWgsl/bvhTraverseTlasWgsl 片段
 * 语义 + 重跑 test:shadow-ray-gpu 真机对拍（mask==CPU + RMSE 门）。
 */
const SHADOW_RAY_MASK_F32_SHA256 = "fb51f75f6b6d6c98b5d1db0ed8f6160763197565d2db638c00b1c6cfda35c8b5";
const SHADOW_RAY_MASK_F16_SHA256 = "52b42325a6d71a75555f58df78c70fbb19cb929e33146970b07b644c895347f9";

describe("shadow ray mask kernel generation contract", () => {
  const wgsl = emitShadowRayMaskKernelWgsl();

  it("is byte-stable across emissions (sha256 pins, f32 and f16)", () => {
    expect(createHash("sha256").update(wgsl).digest("hex")).toBe(SHADOW_RAY_MASK_F32_SHA256);
    expect(createHash("sha256").update(emitShadowRayMaskKernelWgsl()).digest("hex")).toBe(SHADOW_RAY_MASK_F32_SHA256);
    expect(createHash("sha256").update(emitShadowRayMaskKernelWgsl({ f16: true })).digest("hex"))
      .toBe(SHADOW_RAY_MASK_F16_SHA256);
  });

  it("binds all nine slots in executor order with at most 8 storage buffers", () => {
    expect(SHADOW_RAY_MASK_BINDINGS).toHaveLength(9);
    SHADOW_RAY_MASK_BINDINGS.forEach((entry, index) => {
      expect(entry.binding).toBe(index);
      const pattern = `@binding(${index}) var<${entry.type === "uniform" ? "uniform" : entry.type === "storage" ? "storage, read_write" : "storage, read"}>`;
      expect(wgsl).toContain(pattern);
      expect(wgsl).toContain(`${entry.name}:`);
    });
    expect(wgsl.match(/var<storage/gu)?.length).toBe(8);
  });

  it("declares the entry point, workgroup size and occlusion mask semantics", () => {
    expect(wgsl).toContain(`fn ${SHADOW_RAY_MASK_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u)`);
    expect(wgsl).toContain(`@workgroup_size(${RAY_TRACE_WORKGROUP_SIZE})`);
    expect(wgsl).toContain("let occluded = traceTwoLevelOccluded(origin, dir, inv, tMax, params.rayMask, &overflow);");
    // 遮挡=0/可见=1；溢出 fail-closed 写 0（遮挡）并入哨兵——绝不静默采信。
    expect(wgsl).toContain("visibilityMasks[rayIndex] = select(1u, 0u, occluded || overflow != 0u);");
  });

  it("emits only the any-hit traversal path (no closest-hit dead code)", () => {
    expect(wgsl).toContain("fn traceTwoLevelOccluded(");
    expect(wgsl).toContain("fn blasOccluded(");
    expect(wgsl).not.toContain("traceTwoLevelClosest");
    expect(wgsl).not.toContain("blasClosestHit");
    expect(wgsl).not.toContain("intersectTriangleNormal");
  });

  it("keeps the fail-closed stack overflow contract in both traversal levels", () => {
    expect(wgsl).toContain("atomicAdd(&stackOverflows, 1u);");
    expect(BVH_BLAS_OCCLUDED_WGSL).toContain("*overflow = 1u;");
    expect(TLAS_OCCLUDED_WGSL).toContain("*overflow = 1u;");
    expect(TLAS_OCCLUDED_WGSL).toContain("if ((metaWords.y & rayMask) == 0u) { continue; }");
  });

  it("switches the f16 variant by enable f16 + compact node struct only", () => {
    const f16 = emitShadowRayMaskKernelWgsl({ f16: true });
    expect(f16).toContain("enable f16;");
    expect(f16).toContain("boundMin: vec4<f16>");
    expect(wgsl).not.toContain("enable f16;");
    expect(wgsl).toContain("boundMin: vec4f");
    // 共享遍历体经 nodeMin/nodeMax 存取器两档逐字一致。
    for (const fragment of [BVH_SLAB_WGSL, BVH_INTERSECT_WGSL, BVH_BLAS_OCCLUDED_WGSL, TLAS_OCCLUDED_WGSL]) {
      expect(f16).toContain(fragment.slice(0, 40));
    }
  });

  it("provides the f16 node accessors with exact widening conversions", () => {
    const core = bvhTraverseCoreWgsl({ f16: true });
    expect(core).toContain("return vec3f(f32(node.boundMin.x), f32(node.boundMin.y), f32(node.boundMin.z));");
  });

  it("packs the 16B params uniform (rayCount/rayMask + pad)", () => {
    const data = new Uint32Array(packShadowRayUniform(1234, 0xAB));
    expect(data).toEqual(new Uint32Array([1234, 0xAB, 0, 0]));
    expect(packShadowRayUniform(1, 0).byteLength).toBe(16);
  });
});
