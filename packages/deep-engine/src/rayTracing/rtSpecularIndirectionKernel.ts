/// <reference types="@webgpu/types" />
/**
 * RT specular GI·一次反弹 indirection 内核:`rt_specular_indirection`。
 *
 * 消费反射 closest-hit 帧通道(rayTraceClosestFrameKernel)的 rgba32float 命中记录
 * [t, normal.xyz] 与光照遮蔽记录 [albedo.rgb, visibility](illumination 档),把每个
 * 反射接收像素的屏外反弹估计写进 rgba16float indirection 纹理
 * [radiance×fraction, fraction](miss = 全零,fraction=0 让合成端零变化):
 *
 * - 命中点辐射度 = 解析一次反弹(megaLights Lambert N·L 直接光语义,灯源 = 主方向光
 *   ——按场景灯光可用性裁决:主方向光在 resolvePbrSceneLighting 恒存在(缺省 DEFAULT
 *   兜底),ReSTIR-DI 灯池 ABI 属 lighting/ 域、其 reservoir 绑首表面像素无法在任意
 *   世界命中点求值,跨域借表属下一切片,如实记录边界)。直接光项乘命中点→光源可见性
 *   (帧通道遮蔽腿产出,遮挡侧保守归零;栈溢出同侧),反照率取命中实例材质表
 *   (无表供给时执行器预填中性 0.5)。环境项 = F1 ambient 合同同源
 *   (scalePbrEnvironmentRadiance 后的 environmentAmbient),miss 方向=天空辐射口径。
 * - 替换权重 fraction = SSR 同一 split-sum DFG(brdfLut 采样,与 SSR trace 的
 *   ssrSpecularFraction 同式):N·V 取 GBuffer 视法线 + 线性视深度重建(SSR
 *   reconstruct 合同同式),roughness 取视法线 alpha —— 与被替换的 IBL 高光回退同权。
 * - 二反弹不做(任务边界,如实登记);环境项不遮蔽(无 AO 项,保守侧如实登记)。
 *
 * == 布局合同 ==
 * binding 0 = linearDepth(r32float texture_2d,SSR 同源目标);1 = viewNormal
 * (rgba8unorm texture_2d,xyz 视法线 w roughness,SSR 同源);2 = brdfLut;3 = sampler;
 * 4 = params uniform(96B);5 = rtHit(texture_storage_2d<rgba32float, read>,
 * 帧通道命中记录只读);6 = rtIndirection(texture_storage_2d<rgba16float, write>);
 * 7 = bounceShading(texture_storage_2d<rgba32float, read>,帧通道遮蔽/反照率记录只读)。
 * 自有 uniform,不占帧 uniform 槽位(frameAbi 单源不受影响)。
 */

import { ssrBrdfFractionWgsl } from "./rtSpecularSharedWgsl.js";

export const RT_SPECULAR_INDIRECTION_ENTRY_POINT = "rt_specular_indirection";

/** binding 合同(rtSpecularFramePasses 的 bindGroup 顺序必须逐项对应)。 */
export const RT_SPECULAR_INDIRECTION_BINDINGS = Object.freeze([
  { binding: 0, name: "linearDepthTex", type: "texture" },
  { binding: 1, name: "viewNormalTex", type: "texture" },
  { binding: 2, name: "brdfLut", type: "texture" },
  { binding: 3, name: "indirectionSampler", type: "sampler" },
  { binding: 4, name: "indirectionParams", type: "uniform" },
  { binding: 5, name: "rtHitRecord", type: "read-only-storage-texture" },
  { binding: 6, name: "rtIndirection", type: "storage-texture" },
  { binding: 7, name: "bounceShading", type: "read-only-storage-texture" },
] as const);

/** params uniform 字节数:vec4u + 5×vec4f = 96。 */
export const RT_SPECULAR_INDIRECTION_PARAMS_BYTES = 96;

/** RT_SPECULAR_INDIRECTION_FORMAT 命中辐射度输出格式(与 ssr-hdr/链尾 HDR 同族)。 */
export const RT_SPECULAR_INDIRECTION_FORMAT: GPUTextureFormat = "rgba16float";

/**
 * 中性一次反弹反照率:命中实例无材质表供给时执行器预填的中灰 0.5(摄影标准中间
 * 反射率)。估计偏保守侧:真实建材 0.2–0.8,不注入超量能量;真实表(命中点材质
 * baseColor)经执行器 instanceAlbedos 供给后本常量只作回退。
 */
export const RT_SPECULAR_BOUNCE_ALBEDO = 0.5;

export interface RtSpecularIndirectionParams {
  /** 内部分辨率(indirection 纹理尺寸)。 */
  readonly width: number;
  readonly height: number;
  /** 垂直半视角正切(SSR 线性视深度重建合同同式)。 */
  readonly tanHalfFov: number;
  readonly aspect: number;
  /** 主方向光:表面→光源 世界方向(resolvePbrSceneLighting.primary.surfaceToLightWorld)。 */
  readonly surfaceToLightWorld: readonly [number, number, number];
  /** 主方向光颜色(rgb)与强度。 */
  readonly lightColor: readonly [number, number, number];
  readonly lightIntensity: number;
  /** 环境辐射(F1 ambient 合同:scalePbrEnvironmentRadiance 后的 environmentAmbient)。 */
  readonly envRadiance: readonly [number, number, number];
  /** split-sum DFG 替换分数的 f0(与 SSR 选项同源)。 */
  readonly fresnelF0: number;
}

/** 打包 params uniform(96B):[w,h,0,0] + [tanHalfFov,aspect,0,0] + 光方向/色强/环境/f0。 */
export function packRtSpecularIndirectionUniform(params: RtSpecularIndirectionParams): ArrayBuffer {
  const data = new ArrayBuffer(RT_SPECULAR_INDIRECTION_PARAMS_BYTES);
  const f32 = new Float32Array(data);
  const u32 = new Uint32Array(data);
  u32[0] = params.width; u32[1] = params.height; u32[2] = 0; u32[3] = 0;
  f32[4] = params.tanHalfFov; f32[5] = params.aspect; f32[6] = 0; f32[7] = 0;
  f32[8] = params.surfaceToLightWorld[0]!; f32[9] = params.surfaceToLightWorld[1]!;
  f32[10] = params.surfaceToLightWorld[2]!; f32[11] = 0;
  f32[12] = params.lightColor[0]!; f32[13] = params.lightColor[1]!; f32[14] = params.lightColor[2]!;
  f32[15] = params.lightIntensity;
  f32[16] = params.envRadiance[0]!; f32[17] = params.envRadiance[1]!; f32[18] = params.envRadiance[2]!;
  f32[19] = 0;
  f32[20] = params.fresnelF0; f32[21] = 0; f32[22] = 0; f32[23] = 0;
  return data;
}

/** 发射一次反弹 indirection 内核源码(sha256 合同见本目录测试)。 */
export function emitRtSpecularIndirectionKernelWgsl(): string {
  return /* wgsl */ `// RT specular GI one-bounce indirection (consumes the reflection closest-hit frame channel).
// Per receiver pixel: record [t, normal.xyz] + illumination shading record
// [albedo.rgb, visibility] -> analytic one-bounce radiance at the hit point, weighted by
// the same split-sum specular fraction the replaced IBL fallback uses. The direct term
// is multiplied by the hit->light visibility traced by the frame channel; the ambient
// term is unoccluded (no AO term, honest boundary). Output [radiance*frac, frac]; every
// miss path stores zero (fail-closed: no fake energy).
${ssrBrdfFractionWgsl("brdfLut", "indirectionSampler")}
struct IndirectionParams {
  frameSize: vec4u,
  // x=tanHalfFov, y=aspect (SSR linear-view-depth reconstruction contract).
  projection: vec4f,
  lightDirection: vec4f,
  lightColorIntensity: vec4f,
  envRadiance: vec4f,
  // x=fresnelF0
  misc: vec4f,
};

@group(0) @binding(0) var linearDepthTex: texture_2d<f32>;
@group(0) @binding(1) var viewNormalTex: texture_2d<f32>;
@group(0) @binding(2) var brdfLut: texture_2d<f32>;
@group(0) @binding(3) var indirectionSampler: sampler;
@group(0) @binding(4) var<uniform> indirectionParams: IndirectionParams;
@group(0) @binding(5) var rtHitRecord: texture_storage_2d<rgba32float, read>;
@group(0) @binding(6) var rtIndirection: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var bounceShading: texture_storage_2d<rgba32float, read>;

fn rtIndirectionStoreMiss(px: vec2u) {
  textureStore(rtIndirection, vec2<i32>(px), vec4f(0.0));
}

@compute @workgroup_size(8, 8, 1)
fn ${RT_SPECULAR_INDIRECTION_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u) {
  let px = gid.xy;
  if (px.x >= indirectionParams.frameSize.x || px.y >= indirectionParams.frameSize.y) { return; }
  // 帧通道命中记录:t<=0 = miss(fail-closed,不产生虚假反弹能量)。
  let record = textureLoad(rtHitRecord, vec2<i32>(px));
  if (!(record.x > 0.0)) { rtIndirectionStoreMiss(px); return; }
  let linearDepth = textureLoad(linearDepthTex, vec2<i32>(px), 0).x;
  if (!(linearDepth > 0.0)) { rtIndirectionStoreMiss(px); return; }
  let normalRaw = textureLoad(viewNormalTex, vec2<i32>(px), 0);
  let viewNormal = rtSpecSafeNormal(normalRaw.xyz * 2.0 - 1.0);
  let roughness = clamp(normalRaw.w, 0.0, 1.0);
  // N·V:SSR trace 合同同式(线性视深度重建 -> 入射方向 -> saturate(-N·I))。
  let uv = (vec2f(px) + vec2f(0.5, 0.5)) / vec2f(indirectionParams.frameSize.xy);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let viewPos = vec3f(ndc.x * linearDepth * indirectionParams.projection.x * indirectionParams.projection.y,
    ndc.y * linearDepth * indirectionParams.projection.x, -linearDepth);
  let incident = normalize(viewPos / linearDepth);
  let cosTheta = clamp(-dot(viewNormal, incident), 0.0, 1.0);
  // 命中点解析一次反弹:Lambert N·L 主方向光(直接项乘命中点→光源可见性,帧通道
  // 遮蔽腿产出)+ F1 ambient 合同环境项(无 AO,保守侧),反照率 = 命中实例材质
  // (无表供给 = 执行器预填中性 ${RT_SPECULAR_BOUNCE_ALBEDO});命中法线已朝反射接收面定向。
  let shading = textureLoad(bounceShading, vec2<i32>(px));
  let bounceAlbedo = clamp(shading.rgb, vec3f(0.0), vec3f(1.0));
  let hitNormal = record.yzw;
  let ndotl = clamp(dot(hitNormal, indirectionParams.lightDirection.xyz), 0.0, 1.0);
  let direct = ndotl * indirectionParams.lightColorIntensity.rgb * indirectionParams.lightColorIntensity.w
    * shading.a;
  let oneBounce = (direct + indirectionParams.envRadiance.rgb) * bounceAlbedo;
  let fraction = rtSpecSpecularFraction(cosTheta, roughness, indirectionParams.misc.x);
  textureStore(rtIndirection, vec2<i32>(px), vec4f(oneBounce * fraction, fraction));
}
`;
}
