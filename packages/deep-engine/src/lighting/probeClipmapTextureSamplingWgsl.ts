import { DEEP_GI_NORMAL_BIAS_CELLS, DEEP_GI_NORMAL_WEIGHT_BIAS } from "./probeClipmapSamplingWgsl.js";
import { PROBE_RADIANCE_MOMENT_LANES } from "../rayTracing/probeRadianceKernel.js";

export const DEEP_GI_TEXTURE_BINDING = 9;
export const DEEP_GI_TEXTURE_SAMPLER_BINDING = 10;
export const DEEP_GI_TEXTURE_LEVELS_BINDING = 11;
export const DEEP_GI_TEXTURE_MOMENTS_BINDING = 16;
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
 *
 * == F5 方案 A：moments lane 布局与镜面方向门 ==
 * moments 2d-array 每逻辑探针层展开为 PROBE_RADIANCE_MOMENT_LANES(4) 个 lane：lane0 =
 * (mean, variance, missRatio, valid)，lane1..3 = RGB L1 SH 方向可见度（96B record
 * words[12..23] 同合同，channel-major l0/l1m-1/l1m0/l1m1，CPU 参考
 * probeDirectionalVisibilitySh）。`deepGiSpecularDirectionalVisibility` 以漫射同款 8-tap
 * 权重重建方向门 `clamp(luma(recon(reflectDir))/luma(env),0,1)`：域外/近黑恒 1、SH 缺失
 * 探针按标量门 fallback、总权重不足恒 1（保守不扰动）。旧 1-lane moments 体积对新
 * 判据 `realMoments=false` → 整体安全降级为旧行为。
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
@group(3) @binding(${DEEP_GI_TEXTURE_MOMENTS_BINDING}) var deepGiMoments: texture_2d_array<f32>;

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
// 半球判断使用原始着色点，详见 storage-record 采样路径的说明。
fn deepGiTextureNormalWeight(probePosition: vec3f, shadingPoint: vec3f, normal: vec3f) -> f32 {
  let toProbe = probePosition - shadingPoint;
  let lengthToProbe = length(toProbe);
  if (!(lengthToProbe > 0.000001)) { return 1.0; }
  let cosine = dot(toProbe, normal) / lengthToProbe;
  if (!(cosine > 0.0)) { return 0.0; }
  return pow(cosine, ${DEEP_GI_NORMAL_WEIGHT_BIAS}.0);
}
fn deepGiTextureVisibilityFrom(moment: vec4f, receiver: vec3f, probePosition: vec3f, spacing: f32) -> f32 {
  if (moment.w == 0.0) { return 1.0; }
  if (!(moment.w > 0.0) || !deepGiTextureFinite3(moment.xyz, 1000000000000.0)) { return 0.0; }
  let distance = length(receiver - probePosition);
  let meanDistance = clamp(moment.x, 0.0, 1000000.0);
  let variance = clamp(moment.y, spacing * spacing * 0.0001, 1000000000000.0);
  let missRatio = clamp(moment.z, 0.0, 1.0);
  let enclosed = missRatio <= 0.001 && variance <= max(meanDistance * meanDistance, spacing * spacing);
  let delta = abs(distance - meanDistance);
  return select(variance / max(variance + delta * delta, 0.000001), 1.0, distance <= meanDistance && enclosed);
}
fn deepGiTextureVisibility(cell: vec3u, logicalLayer: u32, receiver: vec3f, probePosition: vec3f, spacing: f32) -> f32 {
  let size = textureDimensions(deepGiMoments);
  // A 1x1 zero fallback is the old texture path, not fabricated visibility evidence.
  let probeLayer = logicalLayer * ${PROBE_RADIANCE_MOMENT_LANES}u + 0u;
  if (cell.x >= size.x || cell.y >= size.y || probeLayer >= textureNumLayers(deepGiMoments)) { return 1.0; }
  let moment = textureLoad(deepGiMoments, vec2i(cell.xy), i32(probeLayer), 0);
  return deepGiTextureVisibilityFrom(moment, receiver, probePosition, spacing);
}
fn deepGiTextureLevelSample(level: DeepGiTextureLevel, worldPosition: vec3f, worldNormal: vec3f) -> vec4f {
  let normalLength = length(worldNormal);
  let normal = select(vec3f(0.0, 1.0, 0.0), worldNormal / max(normalLength, 0.000001),
    normalLength > 0.000001 && deepGiTextureFinite3(worldNormal, 1000000.0));
  let receiver = worldPosition + normal * level.originSpacing.w * ${DEEP_GI_NORMAL_BIAS_CELLS};
  let upper = level.gridSize - vec3u(1u);
  let momentGrid = textureDimensions(deepGiMoments);
  // F5 方案 A：真实 moments 需覆盖到本层最高逻辑层的全部 lane（lane0 + RGB L1 SH）。
  // 旧 1-lane 体积（无 lane 扩容）对新判据为 false → 整体走旧 texture 行为。
  let realMoments = all(momentGrid == level.gridSize.xy)
    && textureNumLayers(deepGiMoments) >= (level.level + 1u) * level.gridSize.z * ${PROBE_RADIANCE_MOMENT_LANES}u;
  // Real moments use the existing storage-record interpolation coordinate; legacy
  // no-moment bindings retain the historical receiver-biased texture behavior.
  let coordinate = clamp((select(receiver, worldPosition, realMoments) - level.originSpacing.xyz) / level.originSpacing.w,
    vec3f(0.0), vec3f(upper));
  let low = min(vec3u(floor(coordinate)), level.gridSize - vec3u(2u));
  let fraction = clamp(coordinate - vec3f(low), vec3f(0.0), vec3f(1.0));
  let layerBase = level.level * level.gridSize.z;
  var irradiance = vec3f(0.0); var totalWeight = 0.0;
  // 8-tap trilinear with matching committed radiance and hit-moment texels.
  // Legacy bindings carry a zero moment fallback and keep the old texture behavior.
  for (var corner = 0u; corner < 8u; corner = corner + 1u) {
    let bits = vec3u(corner & 1u, (corner >> 1u) & 1u, (corner >> 2u) & 1u);
    let cell = low + bits;
    let axisWeight = mix(vec3f(1.0) - fraction, fraction, vec3f(bits));
    let trilinear = axisWeight.x * axisWeight.y * axisWeight.z;
    if (!(trilinear > 0.0)) { continue; }
    // WGSL texture_2d_array textureLoad signature is (coords, ARRAY_INDEX, LEVEL): the
    // layer index precedes the mip level (F5-L4 audited against the language reference;
    // the capture-side textureStore shares the same layer-before-value convention).
    let sample = textureLoad(deepGiVolume, vec2i(cell.xy), i32(layerBase + cell.z), 0);
    let validity = clamp(sample.a, 0.0, 1.0);
    if (!(validity > 0.0)) { continue; }
    let probePosition = level.originSpacing.xyz + vec3f(cell) * level.originSpacing.w;
    let weight = trilinear * validity * deepGiTextureNormalWeight(probePosition, worldPosition, normal)
      * deepGiTextureVisibility(cell, layerBase + cell.z, receiver, probePosition, level.originSpacing.w);
    irradiance += max(sample.rgb, vec3f(0.0)) * weight; totalWeight += weight;
  }
  if (realMoments) {
    if (!(totalWeight >= 0.001)) { return vec4f(0.0); }
  } else if (!(totalWeight > 0.0)) { return vec4f(0.0); }
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
// F5 方案 A 镜面方向门：与漫射 8-tap 同权重，按记录 RGB L1 SH 重建
// clamp(luma(recon(reflectDir)) / luma(env), 0, 1)；保守三分支（域外/近黑/采样不足恒 1）
// 与 SH 缺失标量 fallback 见 probeDirectionalVisibilitySh.ts 合同注释。
fn deepGiSpecularLevelGate(level: DeepGiTextureLevel, worldPosition: vec3f, worldNormal: vec3f,
  direction: vec3f, environmentIrradiance: vec3f) -> f32 {
  if (!deepGiTextureContains(level, worldPosition)) { return 1.0; }
  let lumaWeights = vec3f(0.2126, 0.7152, 0.0722);
  let envLuma = dot(max(environmentIrradiance, vec3f(0.0)), lumaWeights);
  if (!(envLuma > 0.0001)) { return 1.0; }
  let momentGrid = textureDimensions(deepGiMoments);
  let realMoments = all(momentGrid == level.gridSize.xy)
    && textureNumLayers(deepGiMoments) >= (level.level + 1u) * level.gridSize.z * ${PROBE_RADIANCE_MOMENT_LANES}u;
  if (!realMoments) { return 1.0; }
  let normalLength = length(worldNormal);
  let normal = select(vec3f(0.0, 1.0, 0.0), worldNormal / max(normalLength, 0.000001),
    normalLength > 0.000001 && deepGiTextureFinite3(worldNormal, 1000000.0));
  let receiver = worldPosition + normal * level.originSpacing.w * ${DEEP_GI_NORMAL_BIAS_CELLS};
  let upper = level.gridSize - vec3u(1u);
  let coordinate = clamp((worldPosition - level.originSpacing.xyz) / level.originSpacing.w,
    vec3f(0.0), vec3f(upper));
  let low = min(vec3u(floor(coordinate)), level.gridSize - vec3u(2u));
  let fraction = clamp(coordinate - vec3f(low), vec3f(0.0), vec3f(1.0));
  let layerBase = level.level * level.gridSize.z;
  let axis = vec4f(1.0, direction.y, direction.z, direction.x);
  var gateSum = 0.0; var totalWeight = 0.0;
  for (var corner = 0u; corner < 8u; corner = corner + 1u) {
    let bits = vec3u(corner & 1u, (corner >> 1u) & 1u, (corner >> 2u) & 1u);
    let cell = low + bits;
    let axisWeight = mix(vec3f(1.0) - fraction, fraction, vec3f(bits));
    let trilinear = axisWeight.x * axisWeight.y * axisWeight.z;
    if (!(trilinear > 0.0)) { continue; }
    let probeLayer = layerBase + cell.z;
    let sample = textureLoad(deepGiVolume, vec2i(cell.xy), i32(probeLayer), 0);
    let validity = clamp(sample.a, 0.0, 1.0);
    if (!(validity > 0.0)) { continue; }
    let probePosition = level.originSpacing.xyz + vec3f(cell) * level.originSpacing.w;
    let moment = textureLoad(deepGiMoments, vec2i(cell.xy), i32(probeLayer * ${PROBE_RADIANCE_MOMENT_LANES}u + 0u), 0);
    let weight = trilinear * validity * deepGiTextureNormalWeight(probePosition, worldPosition, normal)
      * deepGiTextureVisibilityFrom(moment, receiver, probePosition, level.originSpacing.w);
    if (!(weight > 0.0)) { continue; }
    let shR = textureLoad(deepGiMoments, vec2i(cell.xy), i32(probeLayer * ${PROBE_RADIANCE_MOMENT_LANES}u + 1u), 0);
    let shG = textureLoad(deepGiMoments, vec2i(cell.xy), i32(probeLayer * ${PROBE_RADIANCE_MOMENT_LANES}u + 2u), 0);
    let shB = textureLoad(deepGiMoments, vec2i(cell.xy), i32(probeLayer * ${PROBE_RADIANCE_MOMENT_LANES}u + 3u), 0);
    // 12 字全零 = SH 缺失（该探针未以 moments 变体捕获）→ 标量 fallback 门。
    let shMissing = all(shR == vec4f(0.0)) && all(shG == vec4f(0.0)) && all(shB == vec4f(0.0));
    var probeVisibility = clamp(dot(max(sample.rgb, vec3f(0.0)), lumaWeights) / envLuma, 0.0, 1.0);
    if (!shMissing) {
      let reconstructed = max(vec3f(dot(shR, axis), dot(shG, axis), dot(shB, axis)), vec3f(0.0));
      probeVisibility = clamp(dot(reconstructed, lumaWeights) / envLuma, 0.0, 1.0);
    }
    gateSum += weight * probeVisibility; totalWeight += weight;
  }
  if (!(totalWeight >= 0.001)) { return 1.0; }
  return clamp(gateSum / totalWeight, 0.0, 1.0);
}
fn deepGiSpecularDirectionalVisibility(worldPosition: vec3f, worldNormal: vec3f,
  direction: vec3f, environmentIrradiance: vec3f) -> f32 {
  if (!deepGiTextureFinite3(worldPosition, 1000000000.0) || !deepGiTextureFinite3(direction, 1000000.0)) { return 1.0; }
  let levelCount = 4u; var selected = levelCount;
  for (var levelIndex = 0u; levelIndex < levelCount; levelIndex++) {
    if (deepGiTextureContains(deepGiTextureLevelBlock.levels[levelIndex], worldPosition)) { selected = levelIndex; break; }
  }
  if (selected == levelCount) { return 1.0; }
  let fine = deepGiSpecularLevelGate(deepGiTextureLevelBlock.levels[selected], worldPosition, worldNormal,
    direction, environmentIrradiance);
  if (selected + 1u >= levelCount || !deepGiTextureContains(deepGiTextureLevelBlock.levels[selected + 1u], worldPosition)) { return fine; }
  let coarse = deepGiSpecularLevelGate(deepGiTextureLevelBlock.levels[selected + 1u], worldPosition, worldNormal,
    direction, environmentIrradiance);
  let blend = clamp(1.0 - deepGiTextureBoundary(deepGiTextureLevelBlock.levels[selected], worldPosition) / 1.5, 0.0, 1.0);
  return mix(fine, coarse, blend);
}
`;
