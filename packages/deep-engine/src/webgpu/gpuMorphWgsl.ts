export const GPU_MORPH_WORKGROUP_SIZE = 64;
export const GPU_MORPH_VERTEX_STRIDE = 48;
export const GPU_MORPH_DELTA_STRIDE = 48;
export const GPU_MORPH_FLAG_NORMAL = 1;
export const GPU_MORPH_FLAG_TANGENT = 2;

export const GPU_MORPH_WGSL = /* wgsl */`
struct MorphVertex { position: vec4f, normal: vec4f, tangent: vec4f };
struct MorphDelta { position: vec4f, normal: vec4f, tangent: vec4f };
struct MorphParams { vertexCount: u32, targetCount: u32, flags: u32, pad: u32 };
@group(0) @binding(0) var<storage, read> sourceVertices: array<MorphVertex>;
@group(0) @binding(1) var<storage, read> targetDeltas: array<MorphDelta>;
@group(0) @binding(2) var<storage, read> targetWeights: array<f32>;
@group(0) @binding(3) var<storage, read_write> deformedVertices: array<MorphVertex>;
@group(0) @binding(4) var<uniform> params: MorphParams;

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

@compute @workgroup_size(64)
fn deformMorphVertices(@builtin(global_invocation_id) invocation: vec3u) {
  let vertexIndex = invocation.x;
  if (vertexIndex >= params.vertexCount) { return; }
  let source = sourceVertices[vertexIndex];
  var position = source.position.xyz;
  var normalValue = source.normal.xyz;
  var tangentValue = source.tangent.xyz;
  for (var targetIndex = 0u; targetIndex < params.targetCount; targetIndex += 1u) {
    let delta = targetDeltas[targetIndex * params.vertexCount + vertexIndex];
    let weight = targetWeights[targetIndex];
    position += delta.position.xyz * weight;
    normalValue += delta.normal.xyz * weight;
    tangentValue += delta.tangent.xyz * weight;
  }
  let hasNormal = (params.flags & 1u) != 0u;
  let hasTangent = (params.flags & 2u) != 0u;
  let normal = select(vec3f(0.0), safeNormalize(normalValue, source.normal.xyz), hasNormal);
  var tangent = vec3f(0.0);
  if (hasTangent) {
    var fallback = source.tangent.xyz;
    if (hasNormal) {
      fallback -= normal * dot(normal, fallback);
      fallback = safeNormalize(fallback, perpendicular(normal));
      tangentValue -= normal * dot(normal, tangentValue);
    }
    tangent = safeNormalize(tangentValue, fallback);
  }
  deformedVertices[vertexIndex] = MorphVertex(
    vec4f(position, 1.0), vec4f(normal, 0.0), vec4f(tangent, select(0.0, source.tangent.w, hasTangent))
  );
}
`;
