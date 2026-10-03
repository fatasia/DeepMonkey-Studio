import { DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL } from "../lighting/reflectionProbeBoxProjectionWgsl.js";

/** Host bindings surround the existing C15 canonical math; the record stride remains 64 bytes. */
export const PBR_REFLECTION_PROBE_WGSL = /* wgsl */ `
${DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL}
struct DeepPbrReflectionRecord { box: DeepReflectionProbeBox, capture: vec4f, reserved: vec4f };
struct DeepPbrReflectionPair { records: array<DeepPbrReflectionRecord, 2> };
@group(0) @binding(9) var primaryReflectionEnvironment: texture_cube<f32>;
@group(0) @binding(10) var secondaryReflectionEnvironment: texture_cube<f32>;
@group(0) @binding(11) var<uniform> localReflectionProbes: DeepPbrReflectionPair;

fn deepPbrGlobalReflection(reflection: vec3f, roughness: f32) -> vec3f {
  let maxSpecularLod = f32(textureNumLevels(specularEnvironment) - 1u);
  let lod = deepPbrRebasedLod(roughness, maxSpecularLod, localReflectionProbes.records[0].reserved.x);
  return textureSampleLevel(specularEnvironment, environmentSampler, reflection, lod).rgb;
}

fn deepPbrRebasedLod(roughness: f32, keptMaxLod: f32, droppedMips: f32) -> f32 {
  return clamp(roughness * (keptMaxLod + droppedMips) - droppedMips, 0.0, keptMaxLod);
}

// Preserve canonical projection inside the box; fade to its planar sentinel at the boundary.
// Sampling the blended direction keeps one cubemap sample per participating probe.
fn deepPbrReflectionDirection(world: vec3f, reflection: vec3f, probe: DeepReflectionProbeBox) -> vec3f {
  let projected = deepReflectionProbeBoxProject(world, reflection, probe);
  if (projected.w < 0.0) { return reflection; }
  if (probe.blendDistance <= 0.0) { return projected.xyz; }
  let margin = probe.halfExtents - abs(world - probe.center);
  let boundaryDistance = max(min(margin.x, min(margin.y, margin.z)), 0.0);
  let influence = smoothstep(0.0, probe.blendDistance, boundaryDistance);
  let blended = mix(reflection, projected.xyz, influence);
  let magnitude = length(blended);
  if (magnitude <= 0.000001) { return reflection; }
  return blended / magnitude;
}

fn deepPbrReflectionRadiance(world: vec3f, reflection: vec3f, roughness: f32) -> vec3f {
  let first = localReflectionProbes.records[0].box;
  let second = localReflectionProbes.records[1].box;
  if (first.influenceRadius <= 0.0 && second.influenceRadius <= 0.0) {
    return deepPbrGlobalReflection(reflection, roughness);
  }
  let raw = vec2f(deepReflectionProbeInfluenceWeight(world, first), deepReflectionProbeInfluenceWeight(world, second));
  let swapped = raw.x < raw.y;
  let ordered = select(raw, raw.yx, swapped);
  let pair = deepReflectionProbePairWeights(ordered.x, ordered.y, 0.01);
  let weights = select(pair, pair.yx, swapped);
  if (weights.x + weights.y <= 0.0) {
    return deepPbrGlobalReflection(reflection, roughness);
  }
  var radiance = vec3f(0.0);
  if (weights.x > 0.0) {
    let direction = deepPbrReflectionDirection(world, reflection, first);
    let lod = deepPbrRebasedLod(roughness, f32(textureNumLevels(primaryReflectionEnvironment) - 1u),
      localReflectionProbes.records[0].reserved.y);
    radiance += textureSampleLevel(primaryReflectionEnvironment, environmentSampler, direction, lod).rgb * weights.x;
  }
  if (weights.y > 0.0) {
    let direction = deepPbrReflectionDirection(world, reflection, second);
    let lod = deepPbrRebasedLod(roughness, f32(textureNumLevels(secondaryReflectionEnvironment) - 1u),
      localReflectionProbes.records[0].reserved.z);
    radiance += textureSampleLevel(secondaryReflectionEnvironment, environmentSampler, direction, lod).rgb * weights.y;
  }
  let coverage = min(raw.x + raw.y, 1.0);
  if (coverage < 1.0) {
    return mix(deepPbrGlobalReflection(reflection, roughness), radiance, coverage);
  }
  return radiance;
}
`;
