import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { emitShadowRayFrameKernelWgsl, packShadowRayFrameUniform, SHADOW_RAY_FRAME_BINDINGS,
  SHADOW_RAY_FRAME_ENTRY_POINT, SHADOW_RAY_FRAME_PARAMS_BYTES } from "./shadowRayFrameKernel.js";
import { BVH_BLAS_OCCLUDED_WGSL, BVH_INTERSECT_WGSL, BVH_SLAB_WGSL, bvhTraverseCoreWgsl } from "./bvhTraverseWgsl.js";
import { TLAS_OCCLUDED_WGSL } from "./bvhTraverseTlasWgsl.js";

/**
 * 帧循环阴影 mask 内核发射合同:f32/f16 两档各自 sha256 字节级钉死(2026-10-05
 * GBuffer 内联切片基线)。有意变更必须:更新钉值 + 复核遍历片段语义 + 真机对拍
 * (mask==CPU 镜像)后才能入库;片段级合同同探针内核(shadowRayKernel.test)。
 */
const SHADOW_RAY_FRAME_F32_SHA256 = "047964dc9ac5ee3cf57ad18dd77ab5210a5469937aaf27c64b592c4c6f50f3cc";
const SHADOW_RAY_FRAME_F16_SHA256 = "9b3c95d74c09a7df1195a4ff65a994cb8d799f28a3a49509572162312f542459";

describe("shadow ray frame kernel generation contract", () => {
  const wgsl = emitShadowRayFrameKernelWgsl();

  it("is byte-stable across emissions (sha256 pins, f32 and f16)", () => {
    expect(createHash("sha256").update(wgsl).digest("hex")).toBe(SHADOW_RAY_FRAME_F32_SHA256);
    expect(createHash("sha256").update(emitShadowRayFrameKernelWgsl({ f16: true })).digest("hex"))
      .toBe(SHADOW_RAY_FRAME_F16_SHA256);
  });

  it("binds depth/uniform/mask-texture in executor order on top of the shared scene slots", () => {
    expect(SHADOW_RAY_FRAME_BINDINGS).toHaveLength(9);
    SHADOW_RAY_FRAME_BINDINGS.forEach((entry, index) => {
      expect(entry.binding).toBe(index);
      expect(wgsl).toContain(`@binding(${index})`);
      expect(wgsl).toContain(`${entry.name}:`);
    });
    // 场景五槽 storage read + 栈哨兵 storage rw = 6 条 storage buffer(≤8 上限);
    // depth 采样纹理、mask storage 纹理、uniform 各一,不计入 storage buffer 计数。
    expect(wgsl.match(/var<storage/gu)?.length).toBe(6);
    expect(wgsl).toContain("var depth: texture_depth_2d");
    expect(wgsl).toContain("var shadowMask: texture_storage_2d<r32float, write>");
  });

  it("declares the 8x8 entry point, background skip and occlusion mask semantics", () => {
    expect(wgsl).toContain(`fn ${SHADOW_RAY_FRAME_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u)`);
    expect(wgsl).toContain("@workgroup_size(8, 8, 1)");
    expect(wgsl).toContain("if (px.x >= params.meta.y || px.y >= params.meta.z) { return; }");
    // 背景像素(depth≥1)无接收者:写可见,不发射射线。
    expect(wgsl).toContain("if (depthSample >= 1.0) {");
    expect(wgsl).toContain("textureStore(shadowMask, px, vec4f(1.0, 1.0, 1.0, 1.0));");
    // 遮挡=0.0/可见=1.0;溢出 fail-closed 写 0.0(遮挡)——绝不静默采信。
    expect(wgsl).toContain("let occluded = traceTwoLevelOccluded(origin, dir, inv, params.dirAndMax.w, params.meta.x, &overflow);");
    expect(wgsl).toContain("textureStore(shadowMask, px, vec4f(select(1.0, 0.0, occluded || overflow != 0u), 1.0, 1.0, 1.0));");
  });

  it("emits only the any-hit traversal path (no closest-hit dead code)", () => {
    expect(wgsl).toContain("fn traceTwoLevelOccluded(");
    expect(wgsl).toContain("fn blasOccluded(");
    expect(wgsl).not.toContain("traceTwoLevelClosest");
    expect(wgsl).not.toContain("blasClosestHit");
    expect(wgsl).not.toContain("intersectTriangleNormal");
  });

  it("keeps the fail-closed stack overflow contract in the shared traversal fragments", () => {
    // 全局哨兵由片段内置 atomicAdd 累计(与探针内核同源);主函数只消费局部标志,
    // 不得重复计数。
    expect(BVH_BLAS_OCCLUDED_WGSL).toContain("*overflow = 1u;");
    expect(TLAS_OCCLUDED_WGSL).toContain("atomicAdd(&stackOverflows, 1u);");
    expect(TLAS_OCCLUDED_WGSL).toContain("if ((metaWords.y & rayMask) == 0u) { continue; }");
    expect(wgsl.match(/atomicAdd\(&stackOverflows/gu)?.length).toBe(2);
  });

  it("switches the f16 variant by enable f16 + compact node struct only", () => {
    const f16 = emitShadowRayFrameKernelWgsl({ f16: true });
    expect(f16).toContain("enable f16;");
    expect(f16).toContain("boundMin: vec4<f16>");
    expect(wgsl).not.toContain("enable f16;");
    expect(wgsl).toContain("boundMin: vec4f");
    for (const fragment of [BVH_SLAB_WGSL, BVH_INTERSECT_WGSL, BVH_BLAS_OCCLUDED_WGSL, TLAS_OCCLUDED_WGSL]) {
      expect(f16).toContain(fragment.slice(0, 40));
    }
  });

  it("packs the 96B params uniform (invViewProjection + dir/tMax + mask/size)", () => {
    const inv: readonly [number, number, number, number, number, number, number, number, number, number,
      number, number, number, number, number, number] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const data = new DataView(packShadowRayFrameUniform({ invViewProjection: inv,
      lightDir: [0, -1, 0], tMax: 12.5, rayMask: 0xFF, width: 640, height: 480 }));
    expect(packShadowRayFrameUniform({ invViewProjection: inv, lightDir: [0, -1, 0], tMax: 1, rayMask: 1,
      width: 1, height: 1 }).byteLength).toBe(SHADOW_RAY_FRAME_PARAMS_BYTES);
    expect(SHADOW_RAY_FRAME_PARAMS_BYTES).toBe(96);
    expect(data.getFloat32(64, true)).toBe(0);       // dir.x @ f32[16]
    expect(data.getFloat32(17 * 4, true)).toBe(-1);  // dir.y @ f32[17]
    expect(data.getFloat32(19 * 4, true)).toBe(12.5);   // tMax @ f32[19]
    expect(data.getUint32(20 * 4, true)).toBe(0xFF);    // rayMask
    expect(data.getUint32(21 * 4, true)).toBe(640);     // width
    expect(data.getUint32(22 * 4, true)).toBe(480);     // height
  });
});
