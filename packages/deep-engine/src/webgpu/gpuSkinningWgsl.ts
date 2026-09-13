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
struct SkinningOutput { position: vec4f, normal: vec4f };
struct SkinningParams { vertexCount: u32, jointCount: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read> sourceVertices: array<SkinningInput>;
@group(0) @binding(1) var<storage, read> jointPalette: array<SkinningJoint>;
@group(0) @binding(2) var<storage, read_write> deformedVertices: array<SkinningOutput>;
@group(0) @binding(3) var<uniform> params: SkinningParams;

fn transformNormal(joint: SkinningJoint, value: vec3f) -> vec3f {
  return vec3f(dot(joint.normal0.xyz, value), dot(joint.normal1.xyz, value), dot(joint.normal2.xyz, value));
}

@compute @workgroup_size(64)
fn skinVertices(@builtin(global_invocation_id) invocation: vec3u) {
  let index = invocation.x;
  if (index >= params.vertexCount) { return; }
  let source = sourceVertices[index];
  var position = vec4f(0.0);
  var normal = vec3f(0.0);
  for (var influence = 0u; influence < 4u; influence += 1u) {
    let weight = source.weights[influence];
    let joint = jointPalette[min(source.joints[influence], params.jointCount - 1u)];
    position += (joint.matrix * vec4f(source.position.xyz, 1.0)) * weight;
    normal += transformNormal(joint, source.normal.xyz) * weight;
  }
  let lengthSquared = dot(normal, normal);
  let normalized = select(source.normal.xyz, normal * inverseSqrt(max(lengthSquared, 0.00000001)), lengthSquared > 0.00000001);
  deformedVertices[index] = SkinningOutput(vec4f(position.xyz, 1.0), vec4f(normalized, 0.0));
}
`;
