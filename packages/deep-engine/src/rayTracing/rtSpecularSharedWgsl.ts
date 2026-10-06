/**
 * RT specular 家族共享 WGSL 片段:split-sum 高光分数 + 安全法线。
 *
 * 与 SSR trace 的 ssrSpecularFraction(screenSpaceReflectionWgsl.ts)同式同序——CPU
 * 侧单源是 postprocess/ssrBrdfFraction.ts:ssrBrdfSpecularFractionCpu,家族测试用它与
 * 本片段语义(LUT 采样路径)对拍防漂移。LUT/采样器符号由调用方注入,片段可被多个
 * 内核拼装而不撞符号。
 */

/** 发射共享片段(brdfLutVar/samplerVar 为调用内核中的绑定变量名)。 */
export function ssrBrdfFractionWgsl(brdfLutVar: string, samplerVar: string): string {
  return /* wgsl */ `
fn rtSpecSafeNormal(value: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  return select(vec3f(0.0, 0.0, 1.0), value * inverseSqrt(max(lengthSquared, 0.00000001)), lengthSquared > 0.00000001);
}
// 与 SSR trace 的 ssrSpecularFraction 同式:同一 split-sum DFG LUT 采样,替换分数 =
// 高光分数(与被替换的 IBL 高光回退同权,能量 1:1 换手)。
fn rtSpecSpecularFraction(cosTheta: f32, roughness: f32, fresnelF0: f32) -> f32 {
  let dfg = textureSampleLevel(${brdfLutVar}, ${samplerVar}, vec2f(clamp(cosTheta, 0.001, 1.0), roughness), 0.0).rg;
  let f0 = fresnelF0;
  let fraction = clamp(f0 * dfg.x + dfg.y, 0.0, 1.0) * (1.0 + f0 * (1.0 / max(dfg.x + dfg.y, 0.05) - 1.0));
  return clamp(fraction, 0.0, 1.0);
}
`;
}
