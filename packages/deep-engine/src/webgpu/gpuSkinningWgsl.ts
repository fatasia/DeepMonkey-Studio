export const GPU_SKINNING_WORKGROUP_SIZE = 64;
export const GPU_SKINNING_INPUT_STRIDE = 64;
export const GPU_SKINNING_OUTPUT_STRIDE = 32;
export const GPU_SKINNING_JOINT_STRIDE = 112;

export const GPU_SKINNING_WGSL = /* wgsl */`
struct SkinningInput {
  position: vec4f,
  normal: vec4f,
  joints: vec4u,
  weights: vec4f,
};
struct SkinningJoint {
  matrix: mat4x4f,
  normal0: vec4f,
  normal1: vec4f,
  normal2: vec4f,
};
struct SkinningParams { vertexCount: u32, jointCount: u32, hasTangents: u32, pad1: u32 };
// 原64-byte顶点区不变；可选切线紧随整个顶点区，避免增加绑定或虚拟morph目标。
@group(0) @binding(0) var<storage, read> sourceData: array<vec4u>;
@group(0) @binding(1) var<storage, read> jointPalette: array<SkinningJoint>;
@group(0) @binding(2) var<storage, read_write> deformedVertices: array<vec4f>;
@group(0) @binding(3) var<uniform> params: SkinningParams;

fn transformNormal(joint: SkinningJoint, value: vec3f) -> vec3f {
  return vec3f(dot(joint.normal0.xyz, value), dot(joint.normal1.xyz, value), dot(joint.normal2.xyz, value));
}

@compute @workgroup_size(64)
fn skinVertices(@builtin(global_invocation_id) invocation: vec3u) {
  let index = invocation.x;
  if (index >= params.vertexCount) { return; }
  let base = index * 4u;
  let source = SkinningInput(bitcast<vec4f>(sourceData[base]), bitcast<vec4f>(sourceData[base + 1u]),
    sourceData[base + 2u], bitcast<vec4f>(sourceData[base + 3u]));
  var position = vec4f(0.0);
  var normal = vec3f(0.0);
  var linear0 = vec3f(0.0); var linear1 = vec3f(0.0); var linear2 = vec3f(0.0);
  for (var influence = 0u; influence < 4u; influence += 1u) {
    let weight = source.weights[influence];
    let joint = jointPalette[min(source.joints[influence], params.jointCount - 1u)];
    position += (joint.matrix * vec4f(source.position.xyz, 1.0)) * weight;
    normal += transformNormal(joint, source.normal.xyz) * weight;
    if (params.hasTangents != 0u) {
      linear0 += joint.matrix[0].xyz * weight; linear1 += joint.matrix[1].xyz * weight; linear2 += joint.matrix[2].xyz * weight;
    }
  }
  let lengthSquared = dot(normal, normal);
  let normalized = select(source.normal.xyz, normal * inverseSqrt(max(lengthSquared, 0.00000001)), lengthSquared > 0.00000001);
  let stride = select(2u, 3u, params.hasTangents != 0u);
  deformedVertices[index * stride] = vec4f(position.xyz, 1.0);
  deformedVertices[index * stride + 1u] = vec4f(normalized, 0.0);
  if (params.hasTangents != 0u) {
    let authored = bitcast<vec4f>(sourceData[params.vertexCount * 4u + index]);
    let direction = linear0 * authored.x + linear1 * authored.y + linear2 * authored.z;
    let tangent = direction - normalized * dot(normalized, direction);
    let axis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(normalized.x) > 0.9);
    let fallback = normalize(cross(normalized, axis));
    let tangentLength = dot(tangent, tangent);
    let finalTangent = select(fallback, tangent * inverseSqrt(max(tangentLength, 1e-16)), tangentLength > 1e-16);
    let determinant = dot(linear0, cross(linear1, linear2));
    deformedVertices[index * stride + 2u] = vec4f(finalTangent, authored.w * select(1.0, -1.0, determinant < -1e-8));
  }
}
`;
