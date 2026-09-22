import { SHARED_SHADOW_ATLAS_PCF_SAMPLES } from "./sharedShadowAtlas.js";
import { LOCAL_SHADOW_PCSS_MAX_RADIUS_TEXELS, LOCAL_SHADOW_PCSS_TAPS } from "./localShadowSoftness.js";

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

fn deepLocalShadowRotate(value: vec2f, tileOffset: vec2f) -> vec2f {
  let phase = fract(dot(tileOffset, vec2f(12.9898, 78.233))) * 6.283185307179586;
  let c = cos(phase); let s = sin(phase);
  return vec2f(value.x * c - value.y * s, value.x * s + value.y * c);
}

fn deepSampleLocalSpotShadow(entry: DeepLocalSpotShadowEntry, worldPosition: vec3f, nDotL: f32) -> f32 {
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
  let legacyVisibility = visibility / ${SHARED_SHADOW_ATLAS_PCF_SAMPLES}.0;
  let softness = clamp(entry.params.w - 1.0, 0.0, 1.0);
  if (softness <= 0.0) { return legacyVisibility; }

  // Four raw-depth blocker probes estimate a bounded penumbra; taps stay inside this light's guarded atlas tile.
  let tileMin = entry.atlasTransform.xy + vec2f(texel * 0.5);
  let tileMax = entry.atlasTransform.xy + entry.atlasTransform.zw - vec2f(texel * 0.5);
  let slopeBias = entry.params.y * (1.0 + 2.0 * (1.0 - clamp(nDotL, 0.0, 1.0)));
  let receiverDepth = ndc.z - slopeBias;
  let blockerOffsets = array<vec2f, 4>(
    vec2f(-1.5, -1.5), vec2f(1.5, -1.5), vec2f(-1.5, 1.5), vec2f(1.5, 1.5));
  var blockerSum = 0.0; var blockerCount = 0.0;
  for (var blockerIndex = 0u; blockerIndex < 4u; blockerIndex++) {
    let blockerUv = clamp(atlasUv + blockerOffsets[blockerIndex] * texel, tileMin, tileMax);
    let blockerPixel = vec2<i32>(floor(blockerUv / texel));
    let blockerDepth = textureLoad(deepLocalShadowAtlas, blockerPixel, 0);
    if (blockerDepth < receiverDepth) { blockerSum += blockerDepth; blockerCount += 1.0; }
  }
  if (blockerCount < 0.5) { return 1.0; }
  let averageBlocker = blockerSum / blockerCount;
  let penumbra = clamp((receiverDepth - averageBlocker) / max(averageBlocker, 0.00001)
    * softness * 64.0, 1.0, ${LOCAL_SHADOW_PCSS_MAX_RADIUS_TEXELS}.0);
  let pcssOffsets = array<vec2f, ${LOCAL_SHADOW_PCSS_TAPS}>(
    vec2f(-0.613, 0.617), vec2f(0.170, -0.940), vec2f(0.794, 0.317), vec2f(-0.880, -0.250),
    vec2f(0.455, 0.786), vec2f(-0.230, -0.690), vec2f(0.970, -0.090), vec2f(-0.480, 0.120),
    vec2f(0.080, 0.420), vec2f(0.520, -0.410), vec2f(-0.720, -0.660), vec2f(0.310, 0.080));
  visibility = 0.0;
  for (var pcssIndex = 0u; pcssIndex < ${LOCAL_SHADOW_PCSS_TAPS}u; pcssIndex++) {
    let stableOffset = deepLocalShadowRotate(pcssOffsets[pcssIndex], entry.atlasTransform.xy);
    let sampleUv = clamp(atlasUv + stableOffset * texel * penumbra, tileMin, tileMax);
    visibility += textureSampleCompareLevel(deepLocalShadowAtlas, deepLocalShadowSampler, sampleUv, receiverDepth);
  }
  return visibility / ${LOCAL_SHADOW_PCSS_TAPS}.0;
}

fn deepLocalSpotShadow(spotIndex: u32, worldPosition: vec3f, nDotL: f32) -> f32 {
  for (var entryIndex = 0u; entryIndex < ${LOCAL_SPOT_SHADOW_MAX_LIGHTS}u; entryIndex++) {
    let entry = deepLocalSpotShadowData.entries[entryIndex];
    if (entry.params.w < 0.5) { return 1.0; }
    if (u32(entry.params.x) == spotIndex) {
      return deepSampleLocalSpotShadow(entry, worldPosition, nDotL);
    }
  }
  return 1.0;
}
`;
