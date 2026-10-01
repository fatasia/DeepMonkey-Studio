import {describe,it,expect} from "vitest";
import {consumedShadingRoughness,textureCoverageNormalAlphaSemantics} from "./j3TextureCoverageReadback.js";

// J3 Gate D 通道语义(2026-10-01 归因修正):normal 附件 alpha 两端语义不同 ——
// Web=原始感知 roughness(SSR 锥滤波,clamp 0..1),Native=消费后形式(min(1,clamp(raw,0.045,1)+几何))。
// 本文件锁定 lab 层消费语义推导函数与语义声明,防止通道语义再次静默漂移。
describe("J3 texture coverage roughness channel semantics",()=>{
  it("declares the actual attachment alpha semantics for both families",()=>{
    expect(textureCoverageNormalAlphaSemantics.web).toBe("raw-perceptual-roughness");
    expect(textureCoverageNormalAlphaSemantics.native).toBe("consumed-shading-roughness");
  });
  it("passes raw values through unchanged inside [0.06,1]",()=>{
    expect(consumedShadingRoughness(0.790588)).toBeCloseTo(0.790588,12);
    expect(consumedShadingRoughness(0.06)).toBe(0.06);
    expect(consumedShadingRoughness(1)).toBe(1);
  });
  it("applies the web shade floor 0.06 (not the native 0.045) and ceiling 1",()=>{
    expect(consumedShadingRoughness(0.045)).toBe(0.06);
    expect(consumedShadingRoughness(0.03)).toBe(0.06);
    expect(consumedShadingRoughness(1.2)).toBe(1);
  });
  it("keeps the frozen fixture texels byte-aligned with the raw MR G expectation",()=>{
    // texel G=[96,144,192,224] × roughness 0.9 → raw 全部高于两个下限:消费语义==原始语义。
    const fixtureRoughness=0.9;
    for(const g of [96,144,192,224]){
      const raw=fixtureRoughness*g/255;
      expect(consumedShadingRoughness(raw)).toBe(raw);
    }
  });
});
