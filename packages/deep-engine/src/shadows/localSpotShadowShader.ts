import { SHARED_SHADOW_ATLAS_PCF_SAMPLES } from "./sharedShadowAtlas.js";

export const LOCAL_SPOT_SHADOW_MAX_LIGHTS = 4;
export const LOCAL_SPOT_SHADOW_ENTRY_BYTES = 96;
export const LOCAL_SPOT_SHADOW_UNIFORM_BYTES = LOCAL_SPOT_SHADOW_ENTRY_BYTES * LOCAL_SPOT_SHADOW_MAX_LIGHTS;

/** Fixed group-3 ABI for at most four shared-atlas spot-shadow slices. */
export const LOCAL_SPOT_SHADOW_WGSL = /* wgsl */ `
struct DeepLocalSpotShadowEntry {
  viewProjection: mat4x4f,
  atlasTransform: vec4f,
  params: vec4f,
};
struct DeepLocalSpotShadowData {
  entries: array<DeepLocalSpotShadowEntry, ${LOCAL_SPOT_SHADOW_MAX_LIGHTS}>,
};
@group(3) @binding(6) var<uniform> deepLocalSpotShadowData: DeepLocalSpotShadowData;
@group(3) @binding(7) var deepLocalShadowAtlas: texture_depth_2d;
@group(3) @binding(8) var deepLocalShadowSampler: sampler_comparison;

fn deepSampleLocalSpotShadow(entry: DeepLocalSpotShadowEntry, worldPosition: vec3f) -> f32 {
  let clip = entry.viewProjection * vec4f(worldPosition, 1.0);
  if (clip.w <= 0.0) { return 1.0; }
  let ndc = clip.xyz / clip.w;
  let tileUv = ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  if (any(tileUv < vec2f(0.0)) || any(tileUv > vec2f(1.0)) || ndc.z < 0.0 || ndc.z > 1.0) {
    return 1.0;
  }
  let atlasUv = entry.atlasTransform.xy + tileUv * entry.atlasTransform.zw;
  let texel = entry.params.z;
  let offsets = array<vec2f, ${SHARED_SHADOW_ATLAS_PCF_SAMPLES}>(
    vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(-0.5, 0.5), vec2f(0.5, 0.5));
  var visibility = 0.0;
  for (var sampleIndex = 0u; sampleIndex < ${SHARED_SHADOW_ATLAS_PCF_SAMPLES}u; sampleIndex++) {
    visibility += textureSampleCompareLevel(deepLocalShadowAtlas, deepLocalShadowSampler,
      atlasUv + offsets[sampleIndex] * texel, ndc.z - entry.params.y);
  }
  return visibility / ${SHARED_SHADOW_ATLAS_PCF_SAMPLES}.0;
}

fn deepLocalSpotShadow(spotIndex: u32, worldPosition: vec3f) -> f32 {
  for (var entryIndex = 0u; entryIndex < ${LOCAL_SPOT_SHADOW_MAX_LIGHTS}u; entryIndex++) {
    let entry = deepLocalSpotShadowData.entries[entryIndex];
    if (entry.params.w < 0.5) { return 1.0; }
    if (u32(entry.params.x) == spotIndex) {
      return deepSampleLocalSpotShadow(entry, worldPosition);
    }
  }
  return 1.0;
}
`;
