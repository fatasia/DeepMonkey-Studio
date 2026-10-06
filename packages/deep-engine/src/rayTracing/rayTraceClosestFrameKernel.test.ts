import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { emitRayTraceClosestFrameKernelWgsl, packRayTraceClosestFrameUniform,
  RAY_TRACE_CLOSEST_FRAME_BINDINGS, RAY_TRACE_CLOSEST_FRAME_ILLUMINATION_BINDINGS,
  RAY_TRACE_CLOSEST_FRAME_ENTRY_POINT, RAY_TRACE_CLOSEST_FRAME_ILLUMINATION_PARAMS_BYTES,
  RAY_TRACE_CLOSEST_FRAME_MISS_T, RAY_TRACE_CLOSEST_FRAME_PARAMS_BYTES } from "./rayTraceClosestFrameKernel.js";
import { BVH_BLAS_CLOSEST_WGSL, BVH_BLAS_OCCLUDED_WGSL, BVH_INTERSECT_NORMAL_WGSL,
  BVH_SLAB_WGSL, bvhTraverseCoreWgsl } from "./bvhTraverseWgsl.js";
import { TLAS_CLOSEST_WGSL, TLAS_OCCLUDED_WGSL } from "./bvhTraverseTlasWgsl.js";

/**
 * 帧循环反射 closest-hit 内核发射合同:f32/f16 两档各自 sha256 字节级钉死(2026-10-05
 * B3 光追双通道切片基线)。有意变更必须:更新钉值 + 复核遍历片段语义 + 真机对拍
 * (hit==CPU traceTlasClosest 镜像,scripts/reflectionRayGpuTest.mjs)后才能入库;
 * 片段级合同与阴影内核(shadowRayFrameKernel.test)同族互补。
 * 光照遮蔽档(2026-10-06 P1 RT specular GI 切片):illumination 变体单独钉值,基线
 * 档(缺省)钉值不变 = 遍历体逐字节与 B3 基线一致(加法式变体,不改基线语义)。
 */
const RAY_TRACE_CLOSEST_FRAME_F32_SHA256 = "5c2939d4917d73f5ef88ebf173c405c053c8deddb36386eacdae4e7bcb9cdf36";
const RAY_TRACE_CLOSEST_FRAME_F16_SHA256 = "ad13deff97ba89145e194fbfb0dbb265bf803cc14ade5ac17dac8e37ece7ec29";
const RAY_TRACE_CLOSEST_FRAME_ILLUM_F32_SHA256 = "85f3de87b1bca70c67825b5004a818dea174647d3ba1038abb3842ed05999e28";
const RAY_TRACE_CLOSEST_FRAME_ILLUM_F16_SHA256 = "589c69900949646d21c12f9f33c8ffb57999eefa0006dc35b3bb972caa418b76";

describe("reflection closest-hit frame kernel generation contract", () => {
  const wgsl = emitRayTraceClosestFrameKernelWgsl();

  it("is byte-stable across emissions (sha256 pins, f32 and f16)", () => {
    expect(createHash("sha256").update(wgsl).digest("hex")).toBe(RAY_TRACE_CLOSEST_FRAME_F32_SHA256);
    expect(createHash("sha256").update(emitRayTraceClosestFrameKernelWgsl({ f16: true })).digest("hex"))
      .toBe(RAY_TRACE_CLOSEST_FRAME_F16_SHA256);
  });

  it("binds depth/uniform/hit-record-texture in executor order on top of the shared scene slots", () => {
    expect(RAY_TRACE_CLOSEST_FRAME_BINDINGS).toHaveLength(9);
    RAY_TRACE_CLOSEST_FRAME_BINDINGS.forEach((entry, index) => {
      expect(entry.binding).toBe(index);
      expect(wgsl).toContain(`@binding(${index})`);
      expect(wgsl).toContain(`${entry.name}:`);
    });
    // 场景五槽 storage read + 栈哨兵 storage rw = 6 条 storage buffer(≤8 上限);
    // depth 采样纹理、命中记录 storage 纹理、uniform 各一,不计入 storage buffer 计数。
    expect(wgsl.match(/var<storage/gu)?.length).toBe(6);
    expect(wgsl).toContain("var depth: texture_depth_2d");
    expect(wgsl).toContain("var reflectionHit: texture_storage_2d<rgba32float, write>");
  });

  it("declares the 8x8 entry point, background skip and miss-record semantics", () => {
    expect(wgsl).toContain(`fn ${RAY_TRACE_CLOSEST_FRAME_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u)`);
    expect(wgsl).toContain("@workgroup_size(8, 8, 1)");
    expect(wgsl).toContain("if (px.x >= params.frameMeta.y || px.y >= params.frameMeta.z) { return; }");
    // "meta" 是 WGSL 保留字(Dawn 拒编译,阴影内核真机 2026-10-05 实证)——字段名锁 frameMeta。
    expect(wgsl).not.toMatch(/\bparams\.meta\b/);
    expect(wgsl).toContain("frameMeta: vec4u,");
    // 背景像素(depth≥1)无反射接收者:写 miss,不发射射线。
    expect(wgsl).toContain("if (textureLoad(depth, px, 0) >= 1.0) {");
    expect(wgsl).toContain(`vec4f(${RAY_TRACE_CLOSEST_FRAME_MISS_T}.0, 0.0, 0.0, 0.0)`);
  });

  it("emits only the closest-hit traversal path (no occlusion dead code)", () => {
    expect(wgsl).toContain("fn traceTwoLevelClosest(");
    expect(wgsl).toContain("fn blasClosestHit(");
    expect(wgsl).toContain("fn intersectTriangleNormal(");
    expect(wgsl).not.toContain("traceTwoLevelOccluded");
    expect(wgsl).not.toContain("blasOccluded");
    expect(wgsl).not.toContain("intersectTriangle(");
  });

  it("keeps the fail-closed stack overflow contract in the shared traversal fragments", () => {
    // 全局哨兵由片段内置 atomicAdd 累计(与阴影内核同源);主函数只消费局部标志,
    // 不得重复计数;溢出写 miss(无反射是保守侧:不产生虚假能量)。
    expect(BVH_BLAS_CLOSEST_WGSL).toContain("*overflow = 1u;");
    expect(TLAS_CLOSEST_WGSL).toContain("atomicAdd(&stackOverflows, 1u);");
    expect(TLAS_CLOSEST_WGSL).toContain("if ((metaWords.y & rayMask) == 0u) { continue; }");
    expect(wgsl.match(/atomicAdd\(&stackOverflows/gu)?.length).toBe(2);
    expect(wgsl).toContain("if (found == 0u || overflow != 0u) {");
  });

  it("switches the f16 variant by enable f16 + compact node struct only", () => {
    const f16 = emitRayTraceClosestFrameKernelWgsl({ f16: true });
    expect(f16).toContain("enable f16;");
    expect(f16).toContain("boundMin: vec4<f16>");
    expect(wgsl).not.toContain("enable f16;");
    expect(wgsl).toContain("boundMin: vec4f");
    for (const fragment of [BVH_SLAB_WGSL, BVH_INTERSECT_NORMAL_WGSL, BVH_BLAS_CLOSEST_WGSL, TLAS_CLOSEST_WGSL]) {
      expect(f16).toContain(fragment.slice(0, 40));
    }
  });

  it("reconstructs shading points from depth and orients the differenced normal before the grazing guard", () => {
    // 着色点重建与阴影内核同式(NDC→world,透视除);深度差分法线必须先朝向相机
    // 再判掠射 —— 顺序颠倒会让叉积手性随视角翻转产生整屏 miss(2026-10-05 审查修正)。
    expect(wgsl).toContain("let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depthSample, 1.0);");
    expect(wgsl.indexOf("if (dot(normal, params.eyeAndMax.xyz - world) < 0.0) { normal = -normal; }"))
      .toBeLessThan(wgsl.indexOf("if (dot(incident, normal) >= -1e-4) {"));
    expect(wgsl).toContain("let reflectDir = incident - 2.0 * dot(incident, normal) * normal;");
    // 自相交偏移:origin 沿反射方向前移 bias(与 CPU 参考同式同值)。
    expect(wgsl).toContain("let origin = world + reflectDir * params.biasAndPad.x;");
  });

  it("writes [t, normal.xyz] hit records; overflow guards share the miss path", () => {
    expect(wgsl).toContain("textureStore(reflectionHit, px, vec4f(hit.t, hit.normal.x, hit.normal.y, hit.normal.z));");
    expect(wgsl).toContain("fn frameStoreMiss(px: vec2u) {");
  });

  it("packs the 112B params uniform (invViewProjection + eye/tMax + bias + meta)", () => {
    const inv: readonly [number, number, number, number, number, number, number, number, number, number,
      number, number, number, number, number, number] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const data = new DataView(packRayTraceClosestFrameUniform({ invViewProjection: inv,
      eye: [3, -4, 5], tMax: 12.5, bias: 0.0125, rayMask: 0xFF, width: 640, height: 480 }));
    expect(packRayTraceClosestFrameUniform({ invViewProjection: inv, eye: [0, 0, 0], tMax: 1, bias: 0,
      rayMask: 1, width: 1, height: 1 }).byteLength).toBe(RAY_TRACE_CLOSEST_FRAME_PARAMS_BYTES);
    expect(RAY_TRACE_CLOSEST_FRAME_PARAMS_BYTES).toBe(112);
    expect(data.getFloat32(16 * 4, true)).toBe(3);      // eye.x @ f32[16]
    expect(data.getFloat32(17 * 4, true)).toBe(-4);     // eye.y
    expect(data.getFloat32(19 * 4, true)).toBe(12.5);   // tMax @ f32[19]
    expect(data.getFloat32(20 * 4, true)).toBeCloseTo(0.0125, 6); // bias @ f32[20]
    expect(data.getUint32(24 * 4, true)).toBe(0xFF);    // rayMask @ u32[24]
    expect(data.getUint32(25 * 4, true)).toBe(640);     // width
    expect(data.getUint32(26 * 4, true)).toBe(480);     // height
    expect(data.getUint32(27 * 4, true)).toBe(0);       // pad
  });

  it("derives the shared core from the same traversal fragment library as the shadow kernel", () => {
    // 通道互补合同:反射内核拼 closest-hit 家族,阴影内核拼 any-hit 家族,共享
    // core/slab;任一侧变更遍历片段,另一侧的真机对拍门必须同批复跑。
    expect(bvhTraverseCoreWgsl()).toContain("struct TraverseHit");
    expect(wgsl).toContain(BVH_SLAB_WGSL);
  });
});

describe("reflection closest-hit frame kernel illumination variant (occlusion + albedo record)", () => {
  const wgsl = emitRayTraceClosestFrameKernelWgsl({ illumination: true });
  const f16 = emitRayTraceClosestFrameKernelWgsl({ illumination: true, f16: true });

  it("pins the illumination emissions (f32 and f16) and keeps the baseline pins untouched", () => {
    expect(createHash("sha256").update(wgsl).digest("hex")).toBe(RAY_TRACE_CLOSEST_FRAME_ILLUM_F32_SHA256);
    expect(createHash("sha256").update(f16).digest("hex")).toBe(RAY_TRACE_CLOSEST_FRAME_ILLUM_F16_SHA256);
  });

  it("is a pure addition on the baseline: identical traversal body, extra bindings only", () => {
    const baseline = emitRayTraceClosestFrameKernelWgsl();
    // 基线遍历主体逐字保留(加法式变体;防遮蔽腿顺手改动反射语义)。
    for (const anchor of ["fn frameWorldPosition", "if (dot(incident, normal) >= -1e-4) {",
      "let reflectDir = incident - 2.0 * dot(incident, normal) * normal;",
      "textureStore(reflectionHit, px, vec4f(hit.t, hit.normal.x, hit.normal.y, hit.normal.z));"]) {
      expect(wgsl).toContain(anchor);
    }
    // 基线不含遮蔽片段,illumination 档含(与阴影内核同源片段)。
    expect(baseline).not.toContain("traceTwoLevelOccluded");
    expect(wgsl).toContain("fn traceTwoLevelOccluded(");
    expect(wgsl).toContain(BVH_BLAS_OCCLUDED_WGSL.slice(0, 40));
    expect(wgsl).toContain(TLAS_OCCLUDED_WGSL.slice(0, 40));
    // 遮蔽腿 triangle-intersect 经适配器复用 closest 族 intersectTriangleNormal
    // (两族片段 fetchVertex 撞名,禁止直接拼装 BVH_INTERSECT_WGSL —— 真机 Dawn
    // parse error 实证;adapter + 无重复 fetchVertex 双断言钉死)。
    expect(wgsl).toContain("fn intersectTriangle(origin: vec3f, dir: vec3f, prim: u32) -> f32 {");
    expect(wgsl).toContain("return intersectTriangleNormal(origin, dir, prim, &occlusionNormal);");
    expect(wgsl.match(/fn fetchVertex/gu)?.length).toBe(1);
  });

  it("binds the shading record and instance albedo table on top of the shared 9 slots", () => {
    expect(RAY_TRACE_CLOSEST_FRAME_ILLUMINATION_BINDINGS).toHaveLength(11);
    RAY_TRACE_CLOSEST_FRAME_ILLUMINATION_BINDINGS.forEach((entry, index) => {
      expect(entry.binding).toBe(index);
      expect(wgsl).toContain(`@binding(${index})`);
    });
    expect(wgsl).toContain("var bounceShading: texture_storage_2d<rgba32float, write>;");
    expect(wgsl).toContain("var<storage, read> instanceAlbedos: array<vec4f>;");
    // storage buffer 计数:基线 6 + instanceAlbedos = 7(≤8 默认上限)。
    expect(wgsl.match(/var<storage/gu)?.length).toBe(7);
  });

  it("traces hit-point visibility toward the light with the shadow-family fail-closed side", () => {
    // 遮蔽腿:命中点沿光方向偏移 bias → traceTwoLevelOccluded;遮挡/栈溢出 → visibility=0。
    expect(wgsl).toContain("let hitPosition = origin + reflectDir * hit.t;");
    expect(wgsl).toContain("let shadowOrigin = hitPosition + lightDir * params.biasAndPad.x;");
    expect(wgsl).toContain(
      "let occluded = traceTwoLevelOccluded(shadowOrigin, lightDir, shadowInv,\n      params.eyeAndMax.w, params.frameMeta.x, &shadowOverflow);");
    expect(wgsl).toContain("visibility = select(1.0, 0.0, occluded || shadowOverflow != 0u);");
    // 退化光方向(dot<0.5)不发射:visibility 保持 1(无遮蔽信息 ≠ 无中生有遮挡)。
    expect(wgsl).toContain("if (dot(lightDir, lightDir) > 0.5) {");
  });

  it("fetches per-instance albedo with an out-of-range neutral fallback and writes [albedo.rgb, visibility]", () => {
    expect(wgsl).toContain("var bounceAlbedo = vec3f(0.5, 0.5, 0.5);");
    expect(wgsl).toContain("if (hit.instanceIndex < params.frameMeta.w) {");
    expect(wgsl).toContain("bounceAlbedo = clamp(instanceAlbedos[hit.instanceIndex].rgb, vec3f(0.0), vec3f(1.0));");
    expect(wgsl).toContain("textureStore(bounceShading, px, vec4f(bounceAlbedo, visibility));");
    // miss 路径遮蔽记录同写零(fail-closed:消费端按 a=0 读作无直接光)。
    expect(wgsl).toContain("textureStore(bounceShading, px, vec4f(0.0));");
  });

  it("packs the 128B illumination uniform (lightDirection @ f32[24..26], meta @ u32[28..31])", () => {
    const inv: readonly [number, number, number, number, number, number, number, number, number, number,
      number, number, number, number, number, number] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const data = new DataView(packRayTraceClosestFrameUniform({ invViewProjection: inv,
      eye: [3, -4, 5], tMax: 12.5, bias: 0.0125, rayMask: 0xFF, width: 640, height: 480,
      lightDirectionWorld: [0.5, 0.8, -0.3], albedoCount: 4 }));
    expect(data.byteLength).toBe(RAY_TRACE_CLOSEST_FRAME_ILLUMINATION_PARAMS_BYTES);
    expect(RAY_TRACE_CLOSEST_FRAME_ILLUMINATION_PARAMS_BYTES).toBe(128);
    expect(RAY_TRACE_CLOSEST_FRAME_PARAMS_BYTES).toBe(112);
    expect(data.getFloat32(24 * 4, true)).toBeCloseTo(0.5, 7);   // lightDir.x @ f32[24]
    expect(data.getFloat32(25 * 4, true)).toBeCloseTo(0.8, 7);
    expect(data.getFloat32(26 * 4, true)).toBeCloseTo(-0.3, 7);
    expect(data.getUint32(28 * 4, true)).toBe(0xFF);             // rayMask @ u32[28]
    expect(data.getUint32(29 * 4, true)).toBe(640);
    expect(data.getUint32(30 * 4, true)).toBe(480);
    expect(data.getUint32(31 * 4, true)).toBe(4);                // albedoCount
    // 基线布局(无 lightDirectionWorld)保持 112B:既有偏移不被遮蔽档挤压。
    const baseline = new DataView(packRayTraceClosestFrameUniform({ invViewProjection: inv,
      eye: [3, -4, 5], tMax: 12.5, bias: 0.0125, rayMask: 0xFF, width: 640, height: 480 }));
    expect(baseline.byteLength).toBe(RAY_TRACE_CLOSEST_FRAME_PARAMS_BYTES);
    expect(baseline.getUint32(24 * 4, true)).toBe(0xFF);
  });
});
