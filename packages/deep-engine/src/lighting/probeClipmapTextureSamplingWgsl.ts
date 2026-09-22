import { DEEP_GI_NORMAL_BIAS_CELLS, DEEP_GI_NORMAL_WEIGHT_BIAS } from "./probeClipmapSamplingWgsl.js";

export const DEEP_GI_TEXTURE_BINDING = 9;
export const DEEP_GI_TEXTURE_SAMPLER_BINDING = 10;
export const DEEP_GI_TEXTURE_LEVELS_BINDING = 11;
export const DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES = 256;

/**
 * Texture-backed probe clipmap sampling for the renderer group-3 ABI.
 *
 * == 8-tap 手动采样（泄漏抑制） ==
 * 早期版本用 `textureSampleLevel` 取单次双线性结果，硬件插值无法对 8 个探针分别加权，
 * 因此无法实现 DDGI 的法线权重。现改为逐探针 `textureLoad` + 显式三线性权重，
 * 与 CPU 参考 `probeClipmapSampling.ts` 逐式一致：三线性 × validity × Chebyshev 可见性
 * × 法线权重（`pow(max(dot(toProbe, normal), 0), bias)`）。
 * 采样次数：2 层 × 8 探针 = 16 次 textureLoad（预算内，无额外绑定）。
 */
export const PROBE_CLIPMAP_TEXTURE_SAMPLING_WGSL = /* wgsl */ `
struct DeepGiTextureLevel {
  originSpacing: vec4f,
  gridSize: vec3u,
  level: u32,
  originCell: vec3i,
  baseProbe: u32,
  maxPosition: vec3f,
  probeCount: u32,
};
@group(3) @binding(${DEEP_GI_TEXTURE_BINDING}) var deepGiVolume: texture_2d_array<f32>;
@group(3) @binding(${DEEP_GI_TEXTURE_SAMPLER_BINDING}) var deepGiSampler: sampler;
struct DeepGiTextureLevelBlock { levels: array<DeepGiTextureLevel, 4> };
@group(3) @binding(${DEEP_GI_TEXTURE_LEVELS_BINDING}) var<uniform> deepGiTextureLevelBlock: DeepGiTextureLevelBlock;

fn deepGiTextureFinite3(value: vec3f, limit: f32) -> bool {
  return all(value == value) && all(abs(value) <= vec3f(limit));
}
fn deepGiTextureLevelUsable(level: DeepGiTextureLevel) -> bool {
  return level.originSpacing.w > 0.0 && level.originSpacing.w <= 1000000.0
    && deepGiTextureFinite3(level.originSpacing.xyz, 1000000000.0)
    && deepGiTextureFinite3(level.maxPosition, 1000000000.0)
    && all(level.gridSize >= vec3u(2u)) && all(level.gridSize <= vec3u(64u));
}
fn deepGiTextureContains(level: DeepGiTextureLevel, position: vec3f) -> bool {
  return deepGiTextureLevelUsable(level) && all(position >= level.originSpacing.xyz)
    && all(position <= level.maxPosition);
}
// Hemisphere test against the original shading point (see the storage-record path note).
fn deepGiTextureNormalWeight(probePosition: vec3f, shadingPoint: vec3f, normal: vec3f) -> f32 {
  let toProbe = probePosition - shadingPoint;
  let lengthToProbe = length(toProbe);
  if (!(lengthToProbe > 0.000001)) { return 1.0; }
  let cosine = dot(toProbe, normal) / lengthToProbe;
  if (!(cosine > 0.0)) { return 0.0; }
  return pow(cosine, ${DEEP_GI_NORMAL_WEIGHT_BIAS}.0);
}
fn deepGiTextureLevelSample(level: DeepGiTextureLevel, worldPosition: vec3f, worldNormal: vec3f) -> vec4f {
  let normalLength = length(worldNormal);
  let normal = select(vec3f(0.0, 1.0, 0.0), worldNormal / max(normalLength, 0.000001),
    normalLength > 0.000001 && deepGiTextureFinite3(worldNormal, 1000000.0));
  let receiver = worldPosition + normal * level.originSpacing.w * ${DEEP_GI_NORMAL_BIAS_CELLS};
  let upper = level.gridSize - vec3u(1u);
  let coordinate = clamp((receiver - level.originSpacing.xyz) / level.originSpacing.w,
    vec3f(0.0), vec3f(upper));
  let low = min(vec3u(floor(coordinate)), level.gridSize - vec3u(2u));
  let fraction = clamp(coordinate - vec3f(low), vec3f(0.0), vec3f(1.0));
  let layerBase = level.level * level.gridSize.z;
  var irradiance = vec3f(0.0); var totalWeight = 0.0;
  // 8-tap trilinear: one probe per cube corner (cell already carries the corner offset in
  // all three axes), weighted by validity and the DDGI normal weight. The texture path
  // carries no meanDistance/variance channels, so Chebyshev visibility stays in the
  // storage-record path (probeClipmapSamplingWgsl.ts) - it is not invented here.
  for (var corner = 0u; corner < 8u; corner = corner + 1u) {
    let bits = vec3u(corner & 1u, (corner >> 1u) & 1u, (corner >> 2u) & 1u);
    let cell = low + bits;
    let axisWeight = mix(vec3f(1.0) - fraction, fraction, vec3f(bits));
    let trilinear = axisWeight.x * axisWeight.y * axisWeight.z;
    if (!(trilinear > 0.0)) { continue; }
    let sample = textureLoad(deepGiVolume, vec2i(cell.xy), i32(layerBase + cell.z), 0);
    let validity = clamp(sample.a, 0.0, 1.0);
    if (!(validity > 0.0)) { continue; }
    let probePosition = level.originSpacing.xyz + vec3f(cell) * level.originSpacing.w;
    let weight = trilinear * validity * deepGiTextureNormalWeight(probePosition, worldPosition, normal);
    irradiance += max(sample.rgb, vec3f(0.0)) * weight; totalWeight += weight;
  }
  if (!(totalWeight > 0.0)) { return vec4f(0.0); }
  return vec4f(clamp(irradiance / totalWeight, vec3f(0.0), vec3f(65504.0)), 1.0);
}
fn deepGiTextureBoundary(level: DeepGiTextureLevel, position: vec3f) -> f32 {
  let coordinate = (position - level.originSpacing.xyz) / level.originSpacing.w;
  let upper = vec3f(level.gridSize - vec3u(1u));
  return max(min(min(coordinate.x, upper.x - coordinate.x),
    min(coordinate.y, min(upper.y - coordinate.y, min(coordinate.z, upper.z - coordinate.z)))), 0.0);
}
fn deepGiSampleTexture(worldPosition: vec3f, worldNormal: vec3f) -> vec4f {
  if (!deepGiTextureFinite3(worldPosition, 1000000000.0)) { return vec4f(0.0); }
  let levelCount = 4u; var selected = levelCount;
  for (var levelIndex = 0u; levelIndex < levelCount; levelIndex++) {
    if (deepGiTextureContains(deepGiTextureLevelBlock.levels[levelIndex], worldPosition)) { selected = levelIndex; break; }
  }
  if (selected == levelCount) { return vec4f(0.0); }
  let fine = deepGiTextureLevelSample(deepGiTextureLevelBlock.levels[selected], worldPosition, worldNormal);
  if (selected + 1u >= levelCount || !deepGiTextureContains(deepGiTextureLevelBlock.levels[selected + 1u], worldPosition)) { return fine; }
  let coarse = deepGiTextureLevelSample(deepGiTextureLevelBlock.levels[selected + 1u], worldPosition, worldNormal);
  let blend = clamp(1.0 - deepGiTextureBoundary(deepGiTextureLevelBlock.levels[selected], worldPosition) / 1.5, 0.0, 1.0);
  return mix(fine, coarse, blend);
}
`;
