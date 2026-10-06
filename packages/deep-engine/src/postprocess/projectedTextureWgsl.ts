export const PROJECTED_TEXTURE_WORKGROUP_SIZE = 8;

/**
 * P2 投影纹理光核(three r186 ProjectorLight gobo 纹理半部;语义单源见
 * projectedTextureTypes.ts)。单 pass 全分辨率解析求值(无步进无随机):
 * 线性视深度重建(SSR/ssgiReconstruct 同合同)→ 逐投影器 view→projector 矩阵 →
 * gobo 双线性采样 × N·L × 距离平方衰减 × 锥边软化 → 槽序 0..3 手展开累加 →
 * 加性合成。无贡献像素走 textureLoad 原值透传(color + 0 逐位等于输入,关闭零
 * 变化的 WGSL 半边)。
 * CPU 权威镜像:projectedTextureCpu.ts(同式同序;packProjectedTextureParametersMulti
 * 544B 打包单源,子块 128B 布局与单投影器 packProjectedTextureParameters 同构)。
 * 多投影器灯池(2026-10-06 后继切片):槽 0..3 各绑一枚 gobo(binding 3/7/8/9),
 * count 钳 4;槽序固定 ascending 累加,单投影器(count=1)与旧单投影器核逐位一致。
 */

const COMMON = /* wgsl */ `
struct ProjectedTextureProjector {
  viewToProjector: mat4x4<f32>,
  // xyz = projector position (view space), w = intensity
  positionIntensity: vec4<f32>,
  // rgb = light color, w = range (attenuation radius)
  colorRange: vec4<f32>,
  // x = edgeSoften (uv), y = tanHalfFov, z = aspect, w = reserved
  tuning: vec4<f32>,
  // 保留单投影器 128B 子块布局(冗余;重建用顶层 surface)
  surface: vec2<u32>,
  pad: vec2<u32>,
};
struct ProjectedTextureParams {
  // 4 × 128B projector slots (unused slots zero-filled, guarded by count)
  projectors: array<ProjectedTextureProjector, 4>,
  // active projector count (1..4), padded to 16B
  count: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
  surface: vec2<u32>,
};
fn projectedSafeNormal(value: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  return select(vec3f(0.0, 0.0, 1.0), value * inverseSqrt(max(lengthSquared, 0.00000001)), lengthSquared > 0.00000001);
}
// Same reconstruction contract as SSR/ssrReconstruct (linear view depth → view xyz).
// tanHalfFov/aspect 全池同值(同一受照面),从槽 0 取(池恒 ≥1,打包单源同写每槽)。
fn projectedReconstruct(coordinate: vec2<u32>, depth: f32) -> vec3f {
  let uv = (vec2f(coordinate) + 0.5) / vec2f(projectedParams.surface);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return vec3f(ndc.x * depth * projectedParams.projectors[0].tuning.y * projectedParams.projectors[0].tuning.z,
    ndc.y * depth * projectedParams.projectors[0].tuning.y, -depth);
}
`;

export const PROJECTED_TEXTURE_LIGHT_WGSL = /* wgsl */ `${COMMON}
@group(0) @binding(0) var sourceColor: texture_2d<f32>;
@group(0) @binding(1) var sourceDepth: texture_2d<f32>;
@group(0) @binding(2) var sourceNormal: texture_2d<f32>;
@group(0) @binding(3) var projectedGobo0: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> projectedParams: ProjectedTextureParams;
@group(0) @binding(5) var projectedSampler: sampler;
@group(0) @binding(6) var projectedTarget: texture_storage_2d<rgba16float, write>;
// 多投影器灯池槽 1..3(槽 0 兼容既有 binding 3;未用槽绑槽 0 gobo,count 守卫不采样)
@group(0) @binding(7) var projectedGobo1: texture_2d<f32>;
@group(0) @binding(8) var projectedGobo2: texture_2d<f32>;
@group(0) @binding(9) var projectedGobo3: texture_2d<f32>;

// 视纵参数与矩阵同块:tuning.y=tanHalfFov、tuning.z=aspect,打包单源
// projectedTextureCpu.packProjectedTextureParameters(Multi)(GPU 捕获脚本共用)。

// 单投影器贡献(与旧单投影器核同式同序:距离→N·L→衰减→clip.w→锥边→gobo 采样)。
fn projectedProjectorContribution(projector: ProjectedTextureProjector, gobo: texture_2d<f32>,
  position: vec3f, normal: vec3f) -> vec3f {
  let toLight = projector.positionIntensity.xyz - position;
  let distance = length(toLight);
  if (distance <= 0.0) { return vec3f(0.0); }
  let cosine = dot(normal, toLight) / distance;
  if (cosine <= 0.0) { return vec3f(0.0); }
  let attenuation = 1.0 - clamp(distance / projector.colorRange.w, 0.0, 1.0);
  if (attenuation <= 0.0) { return vec3f(0.0); }
  let clip = projector.viewToProjector * vec4f(position, 1.0);
  if (clip.w <= 0.0) { return vec3f(0.0); }
  let uv = vec2f(0.5 + 0.5 * (clip.x / clip.w), 0.5 - 0.5 * (clip.y / clip.w));
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return vec3f(0.0); }
  let soften = max(projector.tuning.x, 0.0);
  var cone = 1.0;
  if (soften > 0.0) {
    let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) / soften;
    let t = clamp(edge, 0.0, 1.0);
    cone = t * t * (3.0 - 2.0 * t);
  }
  if (cone <= 0.0) { return vec3f(0.0); }
  let goboSample = textureSampleLevel(gobo, projectedSampler,
    clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  let scale = projector.positionIntensity.w * cosine * attenuation * attenuation * cone;
  return goboSample * projector.colorRange.rgb * scale;
}

@compute @workgroup_size(8, 8)
fn applyProjectedTextureLight(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= projectedParams.surface.x || id.y >= projectedParams.surface.y) { return; }
  let coordinate = vec2<i32>(id.xy);
  let depth = textureLoad(sourceDepth, coordinate, 0).x;
  var contribution = vec3f(0.0);
  if (depth > 0.0) {
    let position = projectedReconstruct(id.xy, depth);
    let normal = projectedSafeNormal(textureLoad(sourceNormal, coordinate, 0).xyz * 2.0 - 1.0);
    // 槽序 0..3 手展开累加(免 binding_array 特性;CPU 镜像同序,f32 加法序一致)。
    let count = min(projectedParams.count, 4u);
    if (count > 0u) {
      contribution = contribution + projectedProjectorContribution(
        projectedParams.projectors[0], projectedGobo0, position, normal);
    }
    if (count > 1u) {
      contribution = contribution + projectedProjectorContribution(
        projectedParams.projectors[1], projectedGobo1, position, normal);
    }
    if (count > 2u) {
      contribution = contribution + projectedProjectorContribution(
        projectedParams.projectors[2], projectedGobo2, position, normal);
    }
    if (count > 3u) {
      contribution = contribution + projectedProjectorContribution(
        projectedParams.projectors[3], projectedGobo3, position, normal);
    }
  }
  let color = textureLoad(sourceColor, coordinate, 0).xyz;
  textureStore(projectedTarget, coordinate, vec4f(color + contribution, 1.0));
}
`;
