export const GPU_DEFORMATION_HISTORY_STRIDE = 48;
export const GPU_DEFORMATION_HISTORY_WORKGROUP_SIZE = 64;

/** Skinner output has no tangent; zero explicitly denotes unavailable tangent data. */
export const GPU_DEFORMATION_HISTORY_WGSL = /* wgsl */ `
struct SkinVertex { position: vec4f, normal: vec4f };
struct DeformedVertex { position: vec4f, normal: vec4f, tangent: vec4f };
@group(0) @binding(0) var<storage, read> sourceVertices: array<SkinVertex>;
@group(0) @binding(1) var<storage, read_write> historyVertices: array<DeformedVertex>;
@compute @workgroup_size(64)
fn expandSkinVertices(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&sourceVertices) || id.x >= arrayLength(&historyVertices)) { return; }
  let value = sourceVertices[id.x];
  historyVertices[id.x] = DeformedVertex(value.position, value.normal, vec4f(0.0));
}
`;
