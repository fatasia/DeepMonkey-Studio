export const GPU_MORPH_SKINNING_WORKGROUP_SIZE = 64;
export const GPU_MORPH_SKINNING_INFLUENCE_STRIDE = 32;
export const GPU_MORPH_SKINNING_OUTPUT_STRIDE = 48;

export const GPU_MORPH_SKINNING_WGSL = /* wgsl */`
struct MorphVertex { position: vec4f, normal: vec4f, tangent: vec4f };
struct MorphDelta { position: vec4f, normal: vec4f, tangent: vec4f };
struct SkinInfluence { joints: vec4u, weights: vec4f };
struct SkinningJoint { matrix: mat4x4f, normal0: vec4f, normal1: vec4f, normal2: vec4f };
struct Params { vertexCount: u32, targetCount: u32, flags: u32, jointCount: u32 };
@group(0) @binding(0) var<storage, read> sourceVertices: array<MorphVertex>;
@group(0) @binding(1) var<storage, read> targetDeltas: array<MorphDelta>;
@group(0) @binding(2) var<storage, read> morphWeights: array<f32>;
@group(0) @binding(3) var<storage, read> influences: array<SkinInfluence>;
@group(0) @binding(4) var<storage, read> jointPalette: array<SkinningJoint>;
@group(0) @binding(5) var<storage, read_write> outputVertices: array<MorphVertex>;
@group(0) @binding(6) var<uniform> params: Params;

fn safeNormalize(value: vec3f, fallback: vec3f) -> vec3f {
  let scale = max(abs(value.x), max(abs(value.y), abs(value.z)));
  if (scale <= 0.00000001) { return fallback; }
  let scaled = value / scale;
  return scaled * inverseSqrt(max(dot(scaled, scaled), 0.00000001));
}
fn perpendicular(normal: vec3f) -> vec3f {
  let axis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(normal.x) > 0.9);
  return normalize(cross(normal, axis));
}
fn transformNormal(joint: SkinningJoint, value: vec3f) -> vec3f {
  return vec3f(dot(joint.normal0.xyz, value), dot(joint.normal1.xyz, value), dot(joint.normal2.xyz, value));
}

@compute @workgroup_size(64)
fn deformMorphSkinVertices(@builtin(global_invocation_id) invocation: vec3u) {
  let vertexIndex = invocation.x;
  if (vertexIndex >= params.vertexCount) { return; }
  let source = sourceVertices[vertexIndex];
  var position = source.position.xyz;
  var normal = source.normal.xyz;
  var tangent = source.tangent.xyz;
  for (var targetIndex = 0u; targetIndex < params.targetCount; targetIndex += 1u) {
    let delta = targetDeltas[targetIndex * params.vertexCount + vertexIndex];
    let weight = morphWeights[targetIndex];
    position += delta.position.xyz * weight;
    normal += delta.normal.xyz * weight;
    tangent += delta.tangent.xyz * weight;
  }
  let hasNormal = (params.flags & 1u) != 0u;
  let hasTangent = (params.flags & 2u) != 0u;
  normal = select(vec3f(0.0), safeNormalize(normal, source.normal.xyz), hasNormal);
  if (hasTangent) {
    var morphFallback = source.tangent.xyz;
    if (hasNormal) {
      morphFallback -= normal * dot(normal, morphFallback);
      morphFallback = safeNormalize(morphFallback, perpendicular(normal));
      tangent -= normal * dot(normal, tangent);
    }
    tangent = safeNormalize(tangent, morphFallback);
  } else { tangent = vec3f(0.0); }

  let influence = influences[vertexIndex];
  var skinnedPosition = vec4f(0.0);
  var skinnedNormal = vec3f(0.0);
  var skinnedTangent = vec3f(0.0);
  var linear0 = vec3f(0.0); var linear1 = vec3f(0.0); var linear2 = vec3f(0.0);
  for (var slot = 0u; slot < 4u; slot += 1u) {
    let weight = influence.weights[slot];
    let joint = jointPalette[min(influence.joints[slot], params.jointCount - 1u)];
    skinnedPosition += (joint.matrix * vec4f(position, 1.0)) * weight;
    skinnedNormal += transformNormal(joint, normal) * weight;
    skinnedTangent += (joint.matrix[0].xyz * tangent.x + joint.matrix[1].xyz * tangent.y + joint.matrix[2].xyz * tangent.z) * weight;
    linear0 += joint.matrix[0].xyz * weight; linear1 += joint.matrix[1].xyz * weight; linear2 += joint.matrix[2].xyz * weight;
  }
  let finalNormal = select(vec3f(0.0), safeNormalize(skinnedNormal, normal), hasNormal);
  var finalTangent = vec3f(0.0);
  var handedness = 0.0;
  if (hasTangent) {
    var fallback = skinnedTangent;
    if (hasNormal) {
      fallback -= finalNormal * dot(finalNormal, fallback);
      fallback = safeNormalize(fallback, perpendicular(finalNormal));
      skinnedTangent -= finalNormal * dot(finalNormal, skinnedTangent);
    }
    finalTangent = safeNormalize(skinnedTangent, fallback);
    let determinant = dot(linear0, cross(linear1, linear2));
    handedness = source.tangent.w * select(1.0, -1.0, determinant < -0.00000001);
  }
  outputVertices[vertexIndex] = MorphVertex(vec4f(skinnedPosition.xyz, 1.0), vec4f(finalNormal, 0.0), vec4f(finalTangent, handedness));
}
`;
