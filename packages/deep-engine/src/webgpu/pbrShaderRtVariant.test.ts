import { describe, expect, it } from "vitest";
import { DEEP_RAY_TRACED_SHADOW_MASK_WGSL, RT_SHADOW_BRANCH_BLOCK, sceneShader, sceneShaderRayTracedShadows } from "./pbrShader.js";

/**
 * M2 方向光 RT 阴影 WGSL 变体门(2026-10-04):
 * - 默认档 sceneShader 与历史逐字节一致(字节级机器证明在 outputFamilyWgslChecksum.test.ts
 *   的 strip 恒等断言:strip 后组合体 hash === 历史钉值 76611dda…,钉值不更新);
 * - RT 档变体相对默认档的差集必须**恰好**等于「分支块 + group(2) binding(3) 声明」,
 *   多一行少一行都是绑定合同漂移(执行器↔绑定合同:pipelines RT 档 cascadedShadowLayout
 *   第 4 条 = binding 3 / sampleType unfilterable-float / viewDimension 2d,见 pipelines.ts)。
 */
describe("M2 ray-traced shadow WGSL variant gate", () => {
  it("default module carries neither the mask binding nor the sampling branch", () => {
    expect(sceneShader).not.toContain("deepRayTracedShadowMask");
    expect(sceneShader).not.toContain(RT_SHADOW_BRANCH_BLOCK);
    expect(sceneShader).not.toContain("textureLoad(deepRayTracedShadowMask");
  });
  it("RT variant = default + branch block + group(2) binding(3) declaration, byte-exact diff", () => {
    // RT 变体的追加形态 = `\n${decl}`(compose 之后尾部拼接),连同换行一并剥离后
    // 必须逐字节还原默认档。
    const reduced = sceneShaderRayTracedShadows
      .replace(`\n${DEEP_RAY_TRACED_SHADOW_MASK_WGSL}`, "")
      .replace(RT_SHADOW_BRANCH_BLOCK, "");
    expect(reduced).toBe(sceneShader);
    // 声明:槽位/类型合同(mask 是 r32float storage 纹理,采样侧 texture_2d<f32>)。
    expect(sceneShaderRayTracedShadows)
      .toContain("@group(2) @binding(3) var deepRayTracedShadowMask: texture_2d<f32>;");
    // 分支:开关位 = frame.output.bloom 保留槽复用;background/16u 与 author/params2
    // 短路语义必须先于 RT 分支(RT 只替代级联档)。
    expect(sceneShaderRayTracedShadows).toContain(RT_SHADOW_BRANCH_BLOCK);
    const branchIndex = sceneShaderRayTracedShadows.indexOf(RT_SHADOW_BRANCH_BLOCK);
    const backgroundGate = sceneShaderRayTracedShadows.indexOf("if (frame.background.w <= 0.0 || flag(flags, 16u)) { return 1.0; }");
    const virtualGate = sceneShaderRayTracedShadows.indexOf("deepCascade.params2.x > 0.5");
    const cascadeReturn = sceneShaderRayTracedShadows.indexOf("return deepCascadedShadow(");
    expect(backgroundGate).toBeGreaterThan(-1);
    expect(branchIndex).toBeGreaterThan(virtualGate);
    expect(branchIndex).toBeLessThan(cascadeReturn);
  });
  it("samples the mask in the fragment pixel space via integer textureLoad", () => {
    // pixel=fragmentCoordinate 与 mask 同为内部分辨率坐标系;textureLoad 需 vec2<i32>,
    // vec2i(pixel) 截断语义 = 像素中心(x.5)取整到本像素 —— 与 kernel 的 px 整数格对齐。
    expect(RT_SHADOW_BRANCH_BLOCK).toContain("textureLoad(deepRayTracedShadowMask, vec2i(pixel), 0).r");
  });
});
