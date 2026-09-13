import type { CascadedShadowPlan } from "./types.js";

export const CASCADED_SHADOW_MAX_CASCADES = 8;
export const CASCADED_SHADOW_UNIFORM_FLOATS = 156;
export const CASCADED_SHADOW_UNIFORM_BYTES = CASCADED_SHADOW_UNIFORM_FLOATS * 4;

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Packs eight fixed matrix slots followed by split, blend, texel and sampling parameters. */
export function packCascadedShadowUniform(plan: CascadedShadowPlan, depthBias = 0.001,
  constantNormalBias = false): Float32Array<ArrayBuffer> {
  if (!plan || !Array.isArray(plan.cascades) || plan.cascades.length < 1 || plan.cascades.length > CASCADED_SHADOW_MAX_CASCADES) {
    throw new RangeError("Cascade plan must contain 1-8 slices.");
  }
  if (!Number.isFinite(depthBias) || depthBias < 0 || depthBias > 0.1) throw new RangeError("Cascade depth bias is invalid.");
  const data = new Float32Array(CASCADED_SHADOW_UNIFORM_FLOATS);
  for (let index = 0; index < CASCADED_SHADOW_MAX_CASCADES; index += 1) {
    data.set(index < plan.cascades.length ? plan.cascades[index]!.viewProjection : IDENTITY, index * 16);
  }
  const last = plan.cascades.at(-1)!;
  for (let index = 0; index < CASCADED_SHADOW_MAX_CASCADES; index += 1) {
    const cascade = plan.cascades[index];
    data[128 + index] = cascade?.far ?? last.far;
    data[136 + index] = cascade?.blendStart ?? last.far;
    data[144 + index] = cascade?.texelWorldSize ?? last.texelWorldSize;
  }
  data.set([plan.cascades.length, depthBias, 1 / plan.shadowMapSize, constantNormalBias ? 1 : 0], 152);
  return data;
}

/** Reusable group-2 shadow library for a depth2d-array. It blends adjacent cascades with 3x3 comparison PCF. */
export const CASCADED_SHADOW_WGSL = /* wgsl */`
const DEEP_MAX_CASCADES: u32 = 8u;

struct DeepCascadeShadowData {
  matrices: array<mat4x4f, 8>,
  splitDepths0: vec4f,
  splitDepths1: vec4f,
  blendStarts0: vec4f,
  blendStarts1: vec4f,
  texelWorld0: vec4f,
  texelWorld1: vec4f,
  params: vec4f,
};

@group(2) @binding(0) var<uniform> deepCascade: DeepCascadeShadowData;
@group(2) @binding(1) var deepShadowMap: texture_depth_2d_array;
@group(2) @binding(2) var deepShadowSampler: sampler_comparison;

fn deepCascadeValue(first: vec4f, second: vec4f, index: u32) -> f32 {
  if (index < 4u) { return first[index]; }
  return second[index - 4u];
}

fn deepCascadeIndex(viewDepth: f32) -> u32 {
  let count = clamp(u32(deepCascade.params.x), 1u, DEEP_MAX_CASCADES);
  for (var index = 0u; index < count; index += 1u) {
    if (viewDepth <= deepCascadeValue(deepCascade.splitDepths0, deepCascade.splitDepths1, index)) { return index; }
  }
  return count - 1u;
}

fn deepSampleCascade(index: u32, worldPosition: vec3f, worldNormal: vec3f, nDotL: f32) -> f32 {
  let texelWorld = deepCascadeValue(deepCascade.texelWorld0, deepCascade.texelWorld1, index);
  let slopeBias = 1.0 - clamp(nDotL, 0.0, 1.0);
  let normalBias = select(slopeBias, 1.0, deepCascade.params.w > 0.5);
  let receiverPosition = worldPosition + worldNormal * texelWorld * normalBias;
  let clip = deepCascade.matrices[index] * vec4f(receiverPosition, 1.0);
  let ndc = clip.xyz / clip.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z < 0.0 || ndc.z > 1.0) { return 1.0; }
  var visibility = 0.0;
  let texel = deepCascade.params.z;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      visibility += textureSampleCompareLevel(deepShadowMap, deepShadowSampler,
        uv + vec2f(f32(x), f32(y)) * texel, i32(index), ndc.z - deepCascade.params.y);
    }
  }
  return visibility / 9.0;
}

fn deepCascadedShadow(viewDepth: f32, worldPosition: vec3f, worldNormal: vec3f, nDotL: f32) -> f32 {
  let count = clamp(u32(deepCascade.params.x), 1u, DEEP_MAX_CASCADES);
  let lastSplit = deepCascadeValue(deepCascade.splitDepths0, deepCascade.splitDepths1, count - 1u);
  if (viewDepth > lastSplit) { return 1.0; }
  let index = deepCascadeIndex(viewDepth);
  let current = deepSampleCascade(index, worldPosition, worldNormal, nDotL);
  if (index + 1u >= count) { return current; }
  let blendStart = deepCascadeValue(deepCascade.blendStarts0, deepCascade.blendStarts1, index);
  let split = deepCascadeValue(deepCascade.splitDepths0, deepCascade.splitDepths1, index);
  if (blendStart >= split) { return current; }
  let blend = smoothstep(blendStart, split, viewDepth);
  return mix(current, deepSampleCascade(index + 1u, worldPosition, worldNormal, nDotL), blend);
}
`;
