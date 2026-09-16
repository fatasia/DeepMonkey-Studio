export const DEEP_GI_TEXTURE_BINDING = 9;
export const DEEP_GI_TEXTURE_SAMPLER_BINDING = 10;
export const DEEP_GI_TEXTURE_LEVELS_BINDING = 11;
export const DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES = 256;

/** Texture-backed probe clipmap sampling for the renderer group-3 ABI. */
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
fn deepGiTextureLevelSample(level: DeepGiTextureLevel, worldPosition: vec3f, worldNormal: vec3f) -> vec4f {
  let normalLength = length(worldNormal);
  let normal = select(vec3f(0.0, 1.0, 0.0), worldNormal / max(normalLength, 0.000001),
    normalLength > 0.000001 && deepGiTextureFinite3(worldNormal, 1000000.0));
  let receiver = worldPosition + normal * level.originSpacing.w * 0.2;
  let upper = level.gridSize - vec3u(1u);
  let coordinate = clamp((receiver - level.originSpacing.xyz) / level.originSpacing.w,
    vec3f(0.0), vec3f(upper));
  let z0 = min(u32(floor(coordinate.z)), upper.z); let z1 = min(z0 + 1u, upper.z);
  let uv = (coordinate.xy + vec2f(0.5)) / vec2f(level.gridSize.xy);
  let layerBase = level.level * level.gridSize.z;
  let first = textureSampleLevel(deepGiVolume, deepGiSampler, uv, i32(layerBase + z0), 0.0);
  let second = textureSampleLevel(deepGiVolume, deepGiSampler, uv, i32(layerBase + z1), 0.0);
  let sampled = mix(first, second, fract(coordinate.z));
  return vec4f(max(sampled.rgb, vec3f(0.0)), clamp(sampled.a, 0.0, 1.0));
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
