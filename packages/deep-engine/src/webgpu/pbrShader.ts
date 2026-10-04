import { GROUND_ALBEDO_WGSL } from "./pbrGroundAlbedo.js";
import { PBR_FOG_WGSL } from "./pbrFogWgsl.js";
import { PBR_DIRECT_LIGHTING_WGSL } from "./pbrDirectLightingWgsl.js";
import { PBR_DIRECT_MULTISCATTERING_WGSL } from "./pbrDirectMultiscatteringWgsl.js";
import { EXTENDED_MATERIAL_EVALUATION_WGSL } from "../shader/materialEvaluateWgsl.js";
import { MATERIAL_DIELECTRIC_WGSL } from "../materialDielectric.js";
import { PBR_DISPLAY_COLOR_WGSL } from "./pbrDisplayColorWgsl.js";
import { PBR_DIRECT_DISPLAY_WGSL } from "./pbrDirectDisplayWgsl.js";
import { WEIGHTED_OIT_FRAGMENT_WGSL } from "./weightedOitWgsl.js";
import { composeForwardPlusPbrShader } from "../lighting/clusterLightingPbrWgsl.js";
import { PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL } from "../lighting/probeClipmapTextureSamplingWgsl.js";
import { CASCADED_SHADOW_WGSL } from "../shadows/cascadedShadowShader.js";
import { VIRTUAL_SHADOW_WGSL } from "./virtualShadowSampling.js";
// J2-B7-migrate：Frame struct 单源生成文本（schema wgslName 钉宿主表面名，DeepOutputSettings
// 由 PBR_DISPLAY_COLOR_WGSL 先于本段定义）。
import { FRAME_STRUCTS_WGSL } from "../frameAbi/generated/frameStructsWgsl.js";
import { PBR_REFLECTION_PROBE_WGSL } from "./pbrReflectionProbeWgsl.js";
export { outputShader } from "./pbrOutputShader.js";

/** 自研验证管线：GGX / Smith / Schlick，线性 HDR，中间过程不做显示编码。 */
// M2 方向光 RT 阴影(2026-10-04):真源 wgsl/directDisplay.wgsl 中 deepPrimaryShadow 的
// RT 分支块(注释 4 行 + 分支 1 行,与 RT_SHADOW_BRANCH_BLOCK 逐字节互钉)。默认档
// sceneShader 在此剥离该块 —— strip 结果与历史文本逐字节一致(hash "76611dda…" 钉值
// 保持不更新,断言见 outputFamilyWgslChecksum.test.ts);RT 档 sceneShaderRayTracedShadows
// 保留原文,并追加 group(2) binding(3) 的 r32float mask 纹理声明(槽位避让
// 0=deepCascade/1=deepShadowMap/2=deepShadowSampler;虚拟档页表在 group 0 尾部 12..14)。
// WGSL 无宏,replace 锚缺失会静默跳过 —— 锚不命中即抛错(fail-fast,模块加载期)。
// 导出供 outputFamilyWgslChecksum.test.ts 的 strip 恒等断言复用(单一真源,禁止测试侧重抄)。
export const RT_SHADOW_BRANCH_BLOCK = `  // M2 方向光 RT 阴影分支(光追 M2 集成):开关位 = frame.output.bloom 保留槽复用
  // (background.w 复用 castShadow 的同族先例;全仓零消费,宿主 pbrFrameUniforms 打包)。
  // 1 = 采样 r32float mask(1.0 可见 / 0.0 遮挡,ShadowRayFramePass 产出);0 = 回退级联。
  // 默认档由 pbrShader.ts 剥离本块(RT_SHADOW_BRANCH_BLOCK 锚),最终 shader 与历史逐字节一致。
  if (frame.output.bloom > 0.5) { return textureLoad(deepRayTracedShadowMask, vec2i(pixel), 0).r; }
`;
/** group(2) binding(3) mask 声明:仅 RT 变体拼接(texture_2d<f32>;r32float 不可过滤,
 *  layout 侧 sampleType 必须 "unfilterable-float",见 pipelines cascadedShadowLayout)。
 *  导出供 WGSL 变体门测试复用(单一真源,禁止测试侧重抄)。 */
export const DEEP_RAY_TRACED_SHADOW_MASK_WGSL = `// M2 方向光 RT 阴影 mask(ShadowRayFramePass 写 r32float,直接光 pass textureLoad 采样)。
@group(2) @binding(3) var deepRayTracedShadowMask: texture_2d<f32>;
`;
function stripRtShadowBranch(body: string): string {
  const stripped = body.replace(RT_SHADOW_BRANCH_BLOCK, "");
  if (stripped === body) throw new Error(
    "directDisplay.wgsl RT shadow branch block drifted; run `pnpm --filter @bim-studio/deep-engine wgsl:sync`.");
  return stripped;
}
const buildSceneShaderCore = (directDisplay: string): string => /* wgsl */ `
${WEIGHTED_OIT_FRAGMENT_WGSL}
${PBR_DISPLAY_COLOR_WGSL}
${PBR_FOG_WGSL}
${PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL}
${FRAME_STRUCTS_WGSL}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(0) @binding(3) var specularEnvironment: texture_cube<f32>;
@group(0) @binding(4) var diffuseEnvironment: texture_cube<f32>;
@group(0) @binding(5) var brdfLut: texture_2d<f32>;
@group(0) @binding(6) var environmentSampler: sampler;
${PBR_REFLECTION_PROBE_WGSL}
struct MaterialTextures {
  baseRow0: vec4f, baseRow1: vec4f, mrRow0: vec4f, mrRow1: vec4f,
  occlusionRow0: vec4f, occlusionRow1: vec4f,
  normalRow0: vec4f, normalRow1: vec4f,
  emissiveRow0: vec4f, emissiveRow1: vec4f,
  extended0: vec4f, extended1: vec4f,
};
@group(1) @binding(0) var baseColorMap: texture_2d<f32>;
@group(1) @binding(1) var baseColorSampler: sampler;
@group(1) @binding(2) var metallicRoughnessMap: texture_2d<f32>;
@group(1) @binding(3) var metallicRoughnessSampler: sampler;
@group(1) @binding(4) var<uniform> materialTextures: MaterialTextures;
@group(1) @binding(5) var occlusionMap: texture_2d<f32>;
@group(1) @binding(6) var occlusionSampler: sampler;
@group(1) @binding(7) var normalMap: texture_2d<f32>;
@group(1) @binding(8) var normalSampler: sampler;
@group(1) @binding(9) var emissiveMap: texture_2d<f32>;
@group(1) @binding(10) var emissiveSampler: sampler;
struct Input {
  @location(0) position: vec3f, @location(1) normal: vec3f,
  @location(2) row0: vec4f, @location(3) row1: vec4f, @location(4) row2: vec4f,
  @location(5) normal0: vec4f, @location(6) normal1: vec4f, @location(7) normal2: vec4f,
  @location(8) colorMetal: vec4f, @location(9) material: vec4f,
  @location(10) uvSets: vec4f, @location(12) emissiveAlpha: vec4f,
};
struct TangentInput {
  @location(0) position: vec3f, @location(1) normal: vec3f,
  @location(2) row0: vec4f, @location(3) row1: vec4f, @location(4) row2: vec4f,
  @location(5) normal0: vec4f, @location(6) normal1: vec4f, @location(7) normal2: vec4f,
  @location(8) colorMetal: vec4f, @location(9) material: vec4f,
  @location(10) uvSets: vec4f, @location(11) tangent: vec4f, @location(12) emissiveAlpha: vec4f,
};
struct Vertex {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f, @location(1) normal: vec3f,
  @location(2) @interpolate(flat) colorMetal: vec4f,
  @location(3) @interpolate(flat) material: vec4f, @location(4) uv0: vec2f,
  @location(5) tangent: vec4f, @location(6) @interpolate(flat) emissiveAlpha: vec4f, @location(7) uv1: vec2f,
  @location(8) currentClip: vec4f, @location(9) previousClip: vec4f, @location(10) viewDepth: f32,
  @location(11) authorShadow: vec4f,
  @location(12) @interpolate(flat) dielectric: f32,
};
struct PreviousInstanceInput {
  @location(13) row0: vec4f, @location(14) row1: vec4f, @location(15) row2: vec4f,
};
fn flag(value: f32, bit: u32) -> bool { return (u32(round(value)) & bit) != 0u; }
fn safeNormalize(value: vec3f, fallback: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  let normalized = value * inverseSqrt(max(lengthSquared, 0.00000001));
  return select(fallback, normalized, lengthSquared > 0.00000001);
}
fn tangentFallback(normal: vec3f) -> vec3f {
  let axis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(normal.x) > 0.9);
  return safeNormalize(cross(axis, normal), vec3f(0.0, 0.0, 1.0));
}
@vertex fn vertexMain(v: Input, previous: PreviousInstanceInput) -> Vertex {
  var out: Vertex;
  let p = vec4f(v.position, 1.0);
  out.world = vec3f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p));
  out.clip = frame.currentViewProjection * vec4f(out.world, 1.0); out.currentClip = out.clip;
  let previousWorld = vec3f(dot(previous.row0, p), dot(previous.row1, p), dot(previous.row2, p));
  out.previousClip = frame.previousViewProjection * vec4f(previousWorld, 1.0);
  out.viewDepth = max(-(frame.worldToView * vec4f(out.world, 1.0)).z, 0.0);
  out.normal = safeNormalize(mat3x3f(v.normal0.xyz, v.normal1.xyz, v.normal2.xyz) * v.normal, vec3f(0.0, 1.0, 0.0));
  out.tangent = vec4f(1.0, 0.0, 0.0, v.material.z);
  out.dielectric = deepDielectricF0(v.normal0.w); out.colorMetal = v.colorMetal; out.material = v.material; out.uv0 = v.uvSets.xy; out.uv1 = v.uvSets.zw; out.emissiveAlpha = v.emissiveAlpha;
  out.authorShadow = deepAuthorShadowCoordinate(out.world, out.normal);
  return out;
}
@vertex fn vertexNormalMapped(v: TangentInput, previous: PreviousInstanceInput) -> Vertex {
  var out: Vertex;
  let p = vec4f(v.position, 1.0);
  out.world = vec3f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p));
  out.clip = frame.currentViewProjection * vec4f(out.world, 1.0); out.currentClip = out.clip;
  let previousWorld = vec3f(dot(previous.row0, p), dot(previous.row1, p), dot(previous.row2, p));
  out.previousClip = frame.previousViewProjection * vec4f(previousWorld, 1.0);
  out.viewDepth = max(-(frame.worldToView * vec4f(out.world, 1.0)).z, 0.0);
  let n = safeNormalize(mat3x3f(v.normal0.xyz, v.normal1.xyz, v.normal2.xyz) * v.normal, vec3f(0.0, 1.0, 0.0));
  let rawTangent = vec3f(dot(v.row0.xyz, v.tangent.xyz), dot(v.row1.xyz, v.tangent.xyz), dot(v.row2.xyz, v.tangent.xyz));
  out.normal = n;
  out.tangent = vec4f(safeNormalize(rawTangent - n * dot(n, rawTangent), tangentFallback(n)), v.tangent.w * v.material.z);
  out.dielectric = deepDielectricF0(v.normal0.w); out.colorMetal = v.colorMetal; out.material = v.material; out.uv0 = v.uvSets.xy; out.uv1 = v.uvSets.zw; out.emissiveAlpha = v.emissiveAlpha;
  out.authorShadow = deepAuthorShadowCoordinate(out.world, out.normal);
  return out;
}
struct ShadowInput {
  @location(0) position: vec3f,
  @location(2) row0: vec4f, @location(3) row1: vec4f, @location(4) row2: vec4f,
};
struct ShadowMaskInput {
  @location(0) position: vec3f, @location(10) uvSets: vec4f,
  @location(2) row0: vec4f, @location(3) row1: vec4f, @location(4) row2: vec4f,
  @location(9) material: vec4f, @location(12) emissiveAlpha: vec4f,
};
@vertex fn shadowMain(v: ShadowInput) -> @builtin(position) vec4f {
  let p = vec4f(v.position, 1.0);
  return frame.light * vec4f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p), 1.0);
}
struct ShadowVertex {
  @builtin(position) clip: vec4f, @location(0) uv0: vec2f, @location(1) uv1: vec2f, @location(2) alphaCutoff: vec2f,
};
@vertex fn shadowMaskMain(v: ShadowMaskInput) -> ShadowVertex {
  var out: ShadowVertex; let p = vec4f(v.position, 1.0);
  out.clip = frame.light * vec4f(dot(v.row0, p), dot(v.row1, p), dot(v.row2, p), 1.0);
  out.uv0 = v.uvSets.xy; out.uv1 = v.uvSets.zw; out.alphaCutoff = vec2f(v.emissiveAlpha.w, v.material.y); return out;
}
@fragment fn shadowMaskPlain(v: ShadowVertex) { if (v.alphaCutoff.x < v.alphaCutoff.y) { discard; } }
@fragment fn shadowMaskTextured(v: ShadowVertex) {
  let uv = vec3f(select(v.uv0, v.uv1, materialTextures.baseRow0.w > 1.5), 1.0);
  let baseUv = vec2f(dot(materialTextures.baseRow0.xyz, uv), dot(materialTextures.baseRow1.xyz, uv));
  var sampledAlpha = 1.0;
  if (materialTextures.baseRow0.w > 0.5) { sampledAlpha = textureSample(baseColorMap, baseColorSampler, baseUv).a; }
  if (v.alphaCutoff.x * sampledAlpha < v.alphaCutoff.y) { discard; }
}
// B1 Brief-VSM 虚拟阴影页物化:depth-as-float 片元(线性光深 = frag builtin z,WebGPU 0..1),
// 写 r32float 页 atlas。页管线仅 solid 档(无 mask 变体):纹理 alpha 裁剪叶类在页中
// 按实心投影(documented 简化;textureArray 锚点唯一性合同见 textureArrayWgsl)。
@fragment fn shadowPageDepth(@builtin(position) fragCoord: vec4f) -> @location(0) f32 {
  return fragCoord.z;
}
// 页矩形背景清屏:整页 viewport 三角带写 far=1.0(空域 = 受光),depth 写关闭
// (页 depth assist 每 pass 清 1.0,场景片元对 1.0 做 less 比较即可正常覆写)。
@vertex fn shadowPageClear(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let x = f32(index & 1u) * 2.0 - 1.0;
  let y = 1.0 - f32(index >> 1u) * 2.0;
  return vec4f(x, y, 1.0, 1.0);
}
@fragment fn shadowPageClearDepth() -> @location(0) f32 {
  return 1.0;
}
${PBR_DIRECT_LIGHTING_WGSL}
${PBR_DIRECT_MULTISCATTERING_WGSL}
${EXTENDED_MATERIAL_EVALUATION_WGSL.replace(MATERIAL_DIELECTRIC_WGSL, "")}
fn orientedNormal(normalInput: vec3f, material: vec4f, frontFacing: bool) -> vec3f {
  let gltfFront = select(!frontFacing, frontFacing, material.z > 0.0);
  let reverseBackFace = flag(material.w, 1u) && !gltfFront;
  return safeNormalize(select(normalInput, -normalInput, reverseBackFace), vec3f(0.0, 1.0, 0.0));
}
${GROUND_ALBEDO_WGSL}
// F5 方案 A（2026-10-03 用户批准）：镜面 IBL 方向可见度门以探针 RGB L1 SH 重建
// clamp(luma(recon(reflection))/luma(env),0,1) 为主路径（SH 缺失探针按 f5-variant-semantics
// 标量门 fallback）；f5-final-webgpu-verification 撤销的「全域标量亮度比乘子」不再以全域
// 形式回归——标量只作为缺失 SH 的逐探针 fallback（其暗 albedo vs 遮挡不可辨识局限在案）。
// 白炉/域外 gate≡1.0 → 乘法逐位不变。见 docs/specs/f5-directional-l1-implementation-20261003.md。
fn shade(fragmentCoordinate: vec2f, world: vec3f, normalInput: vec3f, geometryNormal: vec3f, ground: bool, baseInput: vec3f, metalInput: f32,
  roughInput: f32, occlusionInput: f32, emissive: vec3f, authorShadow: vec4f, materialFlags: f32, dielectric: f32,
  applyFog: bool) -> vec3f {
  deepResetDirectViewDfg();
  // orientedNormal/mappedNormal already normalize and provide fallback.
  let n = normalInput;
  let view = safeNormalize(frame.eye.xyz - world, vec3f(0.0, 0.0, 1.0));
  let l = safeNormalize(frame.lightDirection.xyz, vec3f(0.0, 1.0, 0.0));
  let metal = select(metalInput, 0.0, ground); let rough = min(1.0,
    select(clamp(roughInput, 0.06, 1.0), 0.9, ground) + deepViewGeometryRoughness(geometryNormal));
  var grid = 0.0;
  if (frame.floor.w > 0.0) {
    let gridDistance = abs(fract(world.xz / 2.4 - 0.5) - 0.5) / max(fwidth(world.xz / 2.4), vec2f(0.0001));
    grid = (1.0 - min(min(gridDistance.x, gridDistance.y), 1.0)) * exp(-length(world.xz) * 0.06) * frame.floor.w;
  }
  let base = groundGridAlbedo(select(baseInput, frame.floor.rgb, ground), grid, ground);
  let visibility = deepPrimaryShadow(world, n, dot(n, l), authorShadow, fragmentCoordinate, materialFlags);
  var color = brdfWithDielectricF0(n, view, l, base, metal, rough, dielectric) * frame.sunColor.rgb * frame.sunColor.w * visibility;
  let nv = clamp(dot(n, view), 0.001, 1.0); var dfg = vec2f(0.0); var directDfg = vec2f(0.0);
  if (frame.eye.w > 0.0 || (frame.sunColor.w > 0.0 && dot(n, l) > 0.0)) {
    dfg = textureSampleLevel(brdfLut, environmentSampler, vec2f(nv, rough), 0.0).rg;
    directDfg = deepDirectDfg185(rough, nv);
    deepSeedDirectViewDfg(directDfg);
  }
  color += deepDirectMultiscatteringFromView(n, l, base, metal, rough, dielectric, directDfg)
    * frame.sunColor.rgb * frame.sunColor.w * visibility;
  if (deepClusterParams.limits.z > 0u || deepClusterParams.grid1.w > 0u) {
    color += deepForwardPlusPbrWorldReceivingF0(fragmentCoordinate, world, n, frame.worldToView, base, metal, rough, !flag(materialFlags, 16u), dielectric);
  }
  if (frame.eye.w > 0.0) {
    let f0 = mix(vec3f(dielectric), base, metal);
    // C12 白炉修复:IBL 漫反射/高光的能量分配必须用同一 split-sum 分数。原实现把漫反射
    // 储备定在镜面 Schlick(rough→1 时坍缩为 1−f0),而高光实际交付 LUT 分数(rough→1 时
    // f0·dfg.x+dfg.y ≈ 0.0135),白粗糙面总出射 0.9735 → 白炉欠冲 −2.65%(实测)。
    // 修复后 total = (1−fraction) + fraction ≡ 1,对任意 f0/rough/nv 构造性守恒;
    // 金属路径(漫反射为 0)与镜面极限(fraction→f0)逐位不变。
    let energyCompensation = vec3f(1.0) + f0 * (1.0 / max(dfg.x + dfg.y, 0.05) - 1.0);
    let specularFraction = clamp(f0 * dfg.x + dfg.y, vec3f(0.0), vec3f(1.0)) * energyCompensation;
    let environmentIrradiance = textureSampleLevel(diffuseEnvironment, environmentSampler, n, 0.0).rgb * frame.lightDirection.w;
    let gi = deepGiSampleTexture(world, n); let irradiance = mix(environmentIrradiance, gi.rgb, gi.a);
    let occlusion = clamp(occlusionInput, 0.0, 1.0);
    color += (1.0 - specularFraction) * (1.0 - metal) * base * irradiance * occlusion * frame.eye.w;
    let reflection = reflect(-view, n);
    let radiance = deepPbrReflectionRadiance(world, reflection, rough) * frame.lightDirection.w;
    // F5 方案 A（批准设计）：镜面 IBL 方向可见度门 = clamp(luma(L1 SH 重建(reflection)) /
    // luma(env), 0, 1)。保守三分支（域外/近黑/采样不足恒 1）+ SH 缺失探针标量 fallback；
    // 白炉/开阔天空 gate≡1.0 → radiance*1.0 与无门版本逐位同（IEEE754 ×1.0 精确）。
    // 合同：docs/specs/f5-directional-l1-implementation-20261003.md §1.3。
    let specularDirectionalVisibility = deepGiSpecularDirectionalVisibility(world, n, reflection, environmentIrradiance);
    color += radiance * specularDirectionalVisibility * specularFraction * occlusion * frame.eye.w;
  }
  color += deepAuthoredDiffuse(n, base, metal, occlusionInput) + select(emissive, vec3f(0.0), ground);
  return select(color, deepApplySceneFog(select(color, baseInput, flag(materialFlags, 64u)), world, materialFlags), applyFog);
}
fn clipUv(clip: vec4f) -> vec2f {
  let safeW = select(-max(abs(clip.w), 0.00000001), max(abs(clip.w), 0.00000001), clip.w >= 0.0);
  return clip.xy / safeW * vec2f(0.5, -0.5) + 0.5;
}
fn coverage(alpha: f32, material: vec4f) -> f32 {
  if (flag(material.w, 2u) && alpha < material.y) { discard; }
  // 512 = alpha-to-coverage(AA-M2):片元 alpha 直通,target0 侧由硬件按 alpha 生成
  // MSAA sample mask(alphaToCoverageEnabled 管线变体)。MASK 的 alphaTest discard 与
  // three r185 一致地先于 a2c 发生(alphaTest 剪裁 + 剩余片元抖动覆盖共存);
  // 512 位未置时保持历史语义:OPAQUE 输出 1.0、BLEND 直通 alpha。
  return select(select(1.0, alpha, flag(material.w, 4u)), alpha, flag(material.w, 512u));
}
fn slotUv(uv0: vec2f, uv1: vec2f, row0: vec4f, row1: vec4f) -> vec2f {
  let uv = vec3f(select(uv0, uv1, row0.w > 1.5), 1.0);
  return vec2f(dot(row0.xyz, uv), dot(row1.xyz, uv));
}
struct GeometryOutput {
  @location(0) color: vec4f, @location(1) viewDepth: f32,
  @location(2) viewNormal: vec4f, @location(3) motion: vec2f,
};
fn geometryOutput(v: Vertex, color: vec4f, worldNormal: vec3f, roughness: f32) -> GeometryOutput {
  var out: GeometryOutput; out.color = color; out.viewDepth = v.viewDepth;
  let viewNormal = safeNormalize((frame.worldToView * vec4f(worldNormal, 0.0)).xyz, vec3f(0.0, 0.0, 1.0));
  // Alpha is the perceptual roughness consumed by SSR cone filtering; xyz stays the shared encoded view normal.
  out.viewNormal = vec4f(viewNormal * 0.5 + 0.5, clamp(roughness, 0.0, 1.0));
  let projectionJitterDeltaUv = frame.tuning.xy;
  out.motion = clamp(clipUv(v.previousClip) - clipUv(v.currentClip) - projectionJitterDeltaUv, vec2f(-2.0), vec2f(2.0)); return out;
}
@fragment fn fragmentMain(v: Vertex, @builtin(front_facing) frontFacing: bool) -> GeometryOutput {
  let ground = flag(v.material.w, 8u);
  let normal = orientedNormal(v.normal, v.material, frontFacing);
  let color = shade(v.clip.xy, v.world, normal, normal, ground,
    v.colorMetal.rgb, v.colorMetal.w, v.material.x, 1.0, v.emissiveAlpha.rgb, v.authorShadow, v.material.w, v.dielectric, true);
  return geometryOutput(v, vec4f(color, coverage(v.emissiveAlpha.w, v.material)), normal, v.material.x);
}
@fragment fn fragmentMainColor(v: Vertex, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  let ground = flag(v.material.w, 8u);
  let normal = orientedNormal(v.normal, v.material, frontFacing);
  let color = shade(v.clip.xy, v.world, normal, normal, ground,
    v.colorMetal.rgb, v.colorMetal.w, v.material.x, 1.0, v.emissiveAlpha.rgb, v.authorShadow, v.material.w, v.dielectric, true);
  return vec4f(color, coverage(v.emissiveAlpha.w, v.material));
}
${directDisplay}
@fragment fn fragmentMainTransparent(v: Vertex, @builtin(front_facing) frontFacing: bool) -> DeepWeightedOitOutput {
  let ground = flag(v.material.w, 8u); let normal = orientedNormal(v.normal, v.material, frontFacing);
  let color = shade(v.clip.xy, v.world, normal, normal, ground, v.colorMetal.rgb, v.colorMetal.w, v.material.x, 1.0, v.emissiveAlpha.rgb, v.authorShadow, v.material.w, v.dielectric, true);
  let depth = clamp(v.clip.z, 0.0, 1.0);
  let alpha = coverage(v.emissiveAlpha.w, v.material);
  if (flag(v.material.w, 128u)) { return deepWeightedOitPremultiplied(color, alpha, depth); }
  return deepWeightedOit(color, alpha, depth);
}
struct SurfaceSample { base: vec3f, metal: f32, rough: f32, alpha: f32, occlusion: f32, emissive: vec3f };
fn sampleSurface(v: Vertex) -> SurfaceSample {
  let baseUv = slotUv(v.uv0, v.uv1, materialTextures.baseRow0, materialTextures.baseRow1);
  let mrUv = slotUv(v.uv0, v.uv1, materialTextures.mrRow0, materialTextures.mrRow1);
  var baseSample = vec4f(1.0); var mrSample = vec4f(1.0); var occlusion = 1.0; var emission = vec3f(1.0);
  if (materialTextures.baseRow0.w > 0.5) { baseSample = textureSample(baseColorMap, baseColorSampler, baseUv); }
  if (materialTextures.mrRow0.w > 0.5) { mrSample = textureSample(metallicRoughnessMap, metallicRoughnessSampler, mrUv); }
  if (materialTextures.occlusionRow0.w > 0.5) {
    let aoUv = slotUv(v.uv0, v.uv1, materialTextures.occlusionRow0, materialTextures.occlusionRow1);
    let sampled = textureSample(occlusionMap, occlusionSampler, aoUv).r;
    occlusion = 1.0 + materialTextures.occlusionRow1.w * (sampled - 1.0);
  }
  if (materialTextures.emissiveRow0.w > 0.5) {
    let emissiveUv = slotUv(v.uv0, v.uv1, materialTextures.emissiveRow0, materialTextures.emissiveRow1);
    emission = textureSample(emissiveMap, emissiveSampler, emissiveUv).rgb;
  }
  return SurfaceSample(v.colorMetal.rgb * baseSample.rgb, v.colorMetal.w * mrSample.b,
    v.material.x * mrSample.g, v.emissiveAlpha.w * baseSample.a, occlusion,
    v.emissiveAlpha.rgb * emission * materialTextures.emissiveRow1.w);
}
fn mappedNormal(v: Vertex, frontFacing: bool) -> vec3f {
  let normalUv = slotUv(v.uv0, v.uv1, materialTextures.normalRow0, materialTextures.normalRow1);
  let n = orientedNormal(v.normal, v.material, frontFacing);
  let sourceTangent = safeNormalize(v.tangent.xyz - n * dot(n, v.tangent.xyz), tangentFallback(n));
  let sourceBitangent = cross(n, sourceTangent) * v.tangent.w;
  let determinant = materialTextures.normalRow0.x * materialTextures.normalRow1.y - materialTextures.normalRow0.y * materialTextures.normalRow1.x;
  let determinantSign = select(-1.0, 1.0, determinant >= 0.0);
  let tangent = safeNormalize((sourceTangent * materialTextures.normalRow1.y - sourceBitangent * materialTextures.normalRow1.x) * determinantSign, tangentFallback(n));
  let bitangent = cross(n, tangent) * v.tangent.w * determinantSign;
  let sampled = textureSample(normalMap, normalSampler, normalUv).rgb * 2.0 - 1.0;
  let tangentNormal = safeNormalize(vec3f(sampled.xy * materialTextures.normalRow1.w, sampled.z), vec3f(0.0, 0.0, 1.0));
  return safeNormalize(tangent * tangentNormal.x + bitangent * tangentNormal.y + n * tangentNormal.z, n);
}
fn extendedShade(v: Vertex, normal: vec3f, geometryNormal: vec3f, surface: SurfaceSample) -> vec3f {
  let params = materialTextures.extended0;
  let coatAndTransmission = materialTextures.extended1;
  if (params.y == 0.0 && params.w == 0.0 && coatAndTransmission.y == 0.0) {
    return shade(v.clip.xy, v.world, normal, geometryNormal, false, surface.base, surface.metal, surface.rough,
      surface.occlusion, surface.emissive, v.authorShadow, v.material.w, v.dielectric, true);
  }
  let view = safeNormalize(frame.eye.xyz - v.world, vec3f(0.0, 0.0, 1.0));
  let light = safeNormalize(frame.lightDirection.xyz, vec3f(0.0, 1.0, 0.0));
  let tangent = safeNormalize(v.tangent.xyz - normal * dot(normal, v.tangent.xyz), tangentFallback(normal));
  let extended = deepEvaluateExtendedMaterial(surface.base, surface.metal, surface.rough,
    normal, view, light, tangent, frame.sunColor.rgb * frame.sunColor.w,
    DeepMaterialEvalParams(params.x, params.y, params.z, params.w, coatAndTransmission.x, coatAndTransmission.y));
  let visibility = deepPrimaryShadow(v.world, normal, dot(normal, light), v.authorShadow, v.clip.xy, v.material.w);
  // The reference lobe is direct radiance; preserve stock IBL/GI and emissive, replacing only its direct term.
  let original = shade(v.clip.xy, v.world, normal, geometryNormal, false, surface.base, surface.metal, surface.rough,
    surface.occlusion, surface.emissive, v.authorShadow, v.material.w, v.dielectric, false);
  let stockRough = min(1.0, clamp(surface.rough, 0.06, 1.0) + deepViewGeometryRoughness(geometryNormal));
  let stockDirect = (brdfWithDielectricF0(normal, view, light, surface.base, surface.metal, stockRough, v.dielectric)
    + deepSampleDirectMultiscattering(normal, view, light, surface.base, surface.metal, stockRough, v.dielectric))
    * frame.sunColor.rgb * frame.sunColor.w * visibility;
  return deepApplySceneFog(select(original - stockDirect + extended.rgb * visibility,
    surface.base, flag(v.material.w, 64u)), v.world, v.material.w);
}
@fragment fn fragmentMaterial(v: Vertex, @builtin(front_facing) frontFacing: bool) -> GeometryOutput {
  let surface = sampleSurface(v); let geometryNormal = orientedNormal(v.normal, v.material, frontFacing); var normal = geometryNormal;
  if (materialTextures.normalRow0.w > 0.5) { normal = mappedNormal(v, frontFacing); }
  let color = extendedShade(v, normal, geometryNormal, surface);
  return geometryOutput(v, vec4f(color, coverage(surface.alpha, v.material)), normal, surface.rough);
}
@fragment fn fragmentMaterialColor(v: Vertex, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  let surface = sampleSurface(v); let geometryNormal = orientedNormal(v.normal, v.material, frontFacing); var normal = geometryNormal;
  if (materialTextures.normalRow0.w > 0.5) { normal = mappedNormal(v, frontFacing); }
  let color = extendedShade(v, normal, geometryNormal, surface);
  return vec4f(color, coverage(surface.alpha, v.material));
}
@fragment fn fragmentMaterialDisplay(v: Vertex, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  let surface = sampleSurface(v); let geometryNormal = orientedNormal(v.normal, v.material, frontFacing); var normal = geometryNormal;
  if (materialTextures.normalRow0.w > 0.5) { normal = mappedNormal(v, frontFacing); }
  let color = extendedShade(v, normal, geometryNormal, surface);
  return vec4f(deepDisplayColor(color, frame.output), coverage(surface.alpha, v.material));
}
@fragment fn fragmentMaterialTransparent(v: Vertex, @builtin(front_facing) frontFacing: bool) -> DeepWeightedOitOutput {
  let surface = sampleSurface(v); let geometryNormal = orientedNormal(v.normal, v.material, frontFacing); var normal = geometryNormal;
  if (materialTextures.normalRow0.w > 0.5) { normal = mappedNormal(v, frontFacing); }
  let color = extendedShade(v, normal, geometryNormal, surface);
  let depth = clamp(v.clip.z, 0.0, 1.0);
  let alpha = coverage(surface.alpha, v.material);
  if (flag(v.material.w, 128u)) { return deepWeightedOitPremultiplied(color, alpha, depth); }
  return deepWeightedOit(color, alpha, depth);
}
`;
// 默认档:剥离 RT 分支块(与历史 sceneShader 逐字节一致 —— 改动前 baseline 的字节等价
// 由 outputFamilyWgslChecksum.test.ts 的 strip 恒等断言机器证明)。
export const sceneShaderCore = buildSceneShaderCore(stripRtShadowBranch(PBR_DIRECT_DISPLAY_WGSL));

/** Ready-to-compile default module with the fixed Forward+ group-3 library.
 *  B1 Brief-VSM:虚拟阴影采样库紧随级联库注入(params2.x=0 时虚拟分支全部不进入,
 *  级联档 WGSL 行为逐字节等价;stock WGSL 变更 diff 见交付报告)。
 *  M2 光追阴影:默认档剥离 RT 分支块,本导出与历史文本逐字节一致(零变化证明见
 *  outputFamilyWgslChecksum.test.ts 的 strip 恒等断言)。 */
export const sceneShader = composeForwardPlusPbrShader(
  `${CASCADED_SHADOW_WGSL}\n${VIRTUAL_SHADOW_WGSL}\n${sceneShaderCore}`, "direct-multiscattering");

/** M2 方向光 RT 阴影变体(2026-10-04,opt-in,features.rayTracedShadows=true):
 *  deepPrimaryShadow 保留 frame.output.bloom 开关的 mask 采样分支 + 追加
 *  group(2) binding(3) mask 纹理声明。开关位=0 时分支不进入,与默认档行为一致
 *  (运行时 fail-closed 回退通道:mask 供给异常的帧清 0 位即回级联,无需重建管线)。
 *  分支放在 author/虚拟档之后、级联 return 之前 —— RT 只替代级联档,author/VSM 语义不变。 */
export const sceneShaderRayTracedShadows = composeForwardPlusPbrShader(
  `${CASCADED_SHADOW_WGSL}\n${VIRTUAL_SHADOW_WGSL}\n${buildSceneShaderCore(PBR_DIRECT_DISPLAY_WGSL)}\n${DEEP_RAY_TRACED_SHADOW_MASK_WGSL}`,
  "direct-multiscattering");

export { currentToPreviousUvMotion } from "./pbrMotionCpu.js";
