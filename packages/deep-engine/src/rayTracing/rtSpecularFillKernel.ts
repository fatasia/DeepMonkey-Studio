/// <reference types="@webgpu/types" />
/**
 * RT specular GI·屏外填充合成内核:`rt_specular_fill`。
 *
 * 合成点 = 既有 SSR 合成(screenSpaceReflection compositeReflection)**之后**:SSR
 * composite 在 trace.a==0(屏内 miss)像素逐位输出合成源色(color×1+0 的算术事实),
 * 本内核只在这些像素用 RT indirection 替换 IBL 高光回退,与 SSR composite 同式
 * `out×(1-α)+rgb`(α=RT 高光分数,rgb 已预乘),能量 1:1 换手不叠加:
 *
 * - trace.a > 0(SSR 屏内命中,含半分辨率双线性半权边缘)= SSR 优先,输出逐位透传;
 * - trace.a == 0 且 rt.a == 0 = 双方皆 miss,`out×1+0` 逐位等于输入(开关零变化);
 * - trace.a == 0 且 rt.a > 0 = RT 屏外反弹替换(画面变化 = 真实收益)。
 *
 * == 布局合同 ==
 * binding 0 = ssrOutput(rgba16float texture_2d,SSR composite 输出);1 = ssrTrace
 * (rgba16float texture_2d,SSR trace 屏内 mask 单源);2 = rtIndirection(rgba16float
 * texture_2d);3 = sampler(filtering,与 SSR composite 双线性上采样同档);4 = params
 * uniform(16B);5 = fillTarget(texture_storage_2d<rgba16float, write>,TAA 输入)。
 * 自有 uniform,不占帧 uniform 槽位(frameAbi 单源不受影响)。
 */

export const RT_SPECULAR_FILL_ENTRY_POINT = "rt_specular_fill";

/** binding 合同(rtSpecularFramePasses 的 bindGroup 顺序必须逐项对应)。 */
export const RT_SPECULAR_FILL_BINDINGS = Object.freeze([
  { binding: 0, name: "ssrOutput", type: "texture" },
  { binding: 1, name: "ssrTrace", type: "texture" },
  { binding: 2, name: "rtIndirectionTex", type: "texture" },
  { binding: 3, name: "fillSampler", type: "sampler" },
  { binding: 4, name: "fillParams", type: "uniform" },
  { binding: 5, name: "fillTarget", type: "storage-texture" },
] as const);

/** params uniform 字节数:vec4u = 16。 */
export const RT_SPECULAR_FILL_PARAMS_BYTES = 16;

/** 填充输出格式(供 TAA 以 texture_2d 消费;与 ssr-hdr 同族)。 */
export const RT_SPECULAR_FILL_FORMAT: GPUTextureFormat = "rgba16float";

export interface RtSpecularFillParams {
  readonly width: number;
  readonly height: number;
}

/** 打包 params uniform(16B):[w,h,0,0]。 */
export function packRtSpecularFillUniform(params: RtSpecularFillParams): ArrayBuffer {
  const data = new ArrayBuffer(RT_SPECULAR_FILL_PARAMS_BYTES);
  new Uint32Array(data).set([params.width, params.height, 0, 0]);
  return data;
}

/** 发射屏外填充合成内核源码(sha256 合同见本目录测试)。 */
export function emitRtSpecularFillKernelWgsl(): string {
  return /* wgsl */ `// RT specular GI offscreen fill (composes AFTER the SSR composite pass).
// The SSR composite writes the pristine source color wherever trace.a==0 (color*(1-0)+0
// arithmetic). This kernel replaces the IBL specular fallback with the RT one-bounce
// indirection at exactly those pixels, using the composite's own replace form
// out*(1-a)+rgb so energy swaps 1:1 instead of stacking. SSR hits (trace.a>0, including
// half-weight bilinear edges) pass through bit-for-bit.
struct FillParams {
  frameSize: vec4u,
};

@group(0) @binding(0) var ssrOutput: texture_2d<f32>;
@group(0) @binding(1) var ssrTrace: texture_2d<f32>;
@group(0) @binding(2) var rtIndirectionTex: texture_2d<f32>;
@group(0) @binding(3) var fillSampler: sampler;
@group(0) @binding(4) var<uniform> fillParams: FillParams;
@group(0) @binding(5) var fillTarget: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn ${RT_SPECULAR_FILL_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u) {
  let px = gid.xy;
  if (px.x >= fillParams.frameSize.x || px.y >= fillParams.frameSize.y) { return; }
  let uv = (vec2f(px) + vec2f(0.5, 0.5)) / vec2f(fillParams.frameSize.xy);
  let current = textureSampleLevel(ssrOutput, fillSampler, uv, 0.0);
  let trace = textureSampleLevel(ssrTrace, fillSampler, uv, 0.0);
  let rt = textureSampleLevel(rtIndirectionTex, fillSampler, uv, 0.0);
  let useRt = trace.a <= 0.0 && rt.a > 0.0;
  let rgb = select(current.rgb, current.rgb * (1.0 - rt.a) + rt.rgb, useRt);
  textureStore(fillTarget, vec2<i32>(px), vec4f(rgb, current.a));
}
`;
}
