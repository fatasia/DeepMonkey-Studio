export const PROJECTED_TEXTURE_WORKGROUP_SIZE = 8;

/**
 * P2 投影纹理光核(three r186 ProjectorLight gobo 纹理半部;语义单源见
 * projectedTextureTypes.ts)。单 pass 全分辨率解析求值(无步进无随机):
 * 线性视深度重建(SSR/ssgiReconstruct 同合同)→ view→projector 矩阵 → gobo 双线性
 * 采样 × N·L × 距离平方衰减 × 锥边软化 → 加性合成。无贡献像素走 textureLoad
 * 原值透传(color + 0 逐位等于输入,关闭零变化的 WGSL 半边)。
 * CPU 权威镜像:projectedTextureCpu.ts(同式同序)。
 */

const COMMON = /* wgsl */ `
struct ProjectedTextureParams {
  viewToProjector: mat4x4<f32>,
  // xyz = projector position (view space), w = intensity
  positionIntensity: vec4<f32>,
  // rgb = light color, w = range (attenuation radius)
  colorRange: vec4<f32>,
  // x = edgeSoften (uv), y = tanHalfFov, z = aspect, w = reserved
  tuning: vec4<f32>,
  surface: vec2<u32>,
};
fn projectedSafeNormal(value: vec3f) -> vec3f {
  let lengthSquared = dot(value, value);
  return select(vec3f(0.0, 0.0, 1.0), value * inverseSqrt(max(lengthSquared, 0.00000001)), lengthSquared > 0.00000001);
}
// Same reconstruction contract as SSR/ssrReconstruct (linear view depth → view xyz).
fn projectedReconstruct(coordinate: vec2<u32>, depth: f32) -> vec3f {
  let uv = (vec2f(coordinate) + 0.5) / vec2f(projectedParams.surface);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return vec3f(ndc.x * depth * projectedParams.tuning.y * projectedParams.tuning.z,
    ndc.y * depth * projectedParams.tuning.y, -depth);
}
`;

export const PROJECTED_TEXTURE_LIGHT_WGSL = /* wgsl */ `${COMMON}
@group(0) @binding(0) var sourceColor: texture_2d<f32>;
@group(0) @binding(1) var sourceDepth: texture_2d<f32>;
@group(0) @binding(2) var sourceNormal: texture_2d<f32>;
@group(0) @binding(3) var projectedGobo: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> projectedParams: ProjectedTextureParams;
@group(0) @binding(5) var projectedSampler: sampler;
@group(0) @binding(6) var projectedTarget: texture_storage_2d<rgba16float, write>;

// 视纵参数与矩阵同块:tuning.y=tanHalfFov、tuning.z=aspect,打包单源
// projectedTextureCpu.packProjectedTextureParameters(GPU 捕获脚本共用)。

@compute @workgroup_size(8, 8)
fn applyProjectedTextureLight(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= projectedParams.surface.x || id.y >= projectedParams.surface.y) { return; }
  let coordinate = vec2<i32>(id.xy);
  let depth = textureLoad(sourceDepth, coordinate, 0).x;
  var contribution = vec3f(0.0);
  if (depth > 0.0) {
    let position = projectedReconstruct(id.xy, depth);
    let normal = projectedSafeNormal(textureLoad(sourceNormal, coordinate, 0).xyz * 2.0 - 1.0);
    let toLight = projectedParams.positionIntensity.xyz - position;
    let distance = length(toLight);
    if (distance > 0.0) {
      let cosine = dot(normal, toLight) / distance;
      if (cosine > 0.0) {
        let attenuation = 1.0 - clamp(distance / projectedParams.colorRange.w, 0.0, 1.0);
        if (attenuation > 0.0) {
          let clip = projectedParams.viewToProjector * vec4f(position, 1.0);
          if (clip.w > 0.0) {
            let uv = vec2f(0.5 + 0.5 * (clip.x / clip.w), 0.5 - 0.5 * (clip.y / clip.w));
            let soften = max(projectedParams.tuning.x, 0.0);
            if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
              var cone = 1.0;
              if (soften > 0.0) {
                let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) / soften;
                let t = clamp(edge, 0.0, 1.0);
                cone = t * t * (3.0 - 2.0 * t);
              }
              if (cone > 0.0) {
                let gobo = textureSampleLevel(projectedGobo, projectedSampler,
                  clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
                let scale = projectedParams.positionIntensity.w * cosine * attenuation * attenuation * cone;
                contribution = gobo * projectedParams.colorRange.rgb * scale;
              }
            }
          }
        }
      }
    }
  }
  let color = textureLoad(sourceColor, coordinate, 0).xyz;
  textureStore(projectedTarget, coordinate, vec4f(color + contribution, 1.0));
}
`;
