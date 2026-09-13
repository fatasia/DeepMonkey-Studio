// Deep Engine native GPU instance culling contract v1.
struct InstanceRow {
  model_0: vec4f, model_1: vec4f, model_2: vec4f,
  normal_0: vec4f, normal_1: vec4f, normal_2: vec4f,
  material_0: vec4f, material_1: vec4f, material_2: vec4f,
};
struct Frustum {
  planes: array<vec4f, 6>,
  params: vec4u,
};
struct IndirectCommand {
  index_count: u32,
  instance_count: atomic<u32>,
  first_index: u32,
  base_vertex: i32,
  first_instance: u32,
};

@group(0) @binding(0) var<storage, read> source_instances: array<InstanceRow>;
@group(0) @binding(1) var<storage, read> bounds: array<vec4f>;
@group(0) @binding(2) var<storage, read> metadata: array<vec4u>;
@group(0) @binding(3) var<uniform> frustum: Frustum;
@group(0) @binding(4) var<storage, read_write> visible_instances: array<InstanceRow>;
@group(0) @binding(5) var<storage, read_write> indirect: array<IndirectCommand>;

fn is_visible(instance: InstanceRow, bound: vec4f) -> bool {
  let local = vec4f(bound.xyz, 1.0);
  let center = vec3f(dot(instance.model_0, local), dot(instance.model_1, local),
    dot(instance.model_2, local));
  let radius = max(bound.w, 0.0);
  for (var plane = 0u; plane < 6u; plane++) {
    let value = frustum.planes[plane];
    let distance = dot(value.xyz, center) + value.w;
    if (distance >= 0.0) { continue; }
    // 局部球变换为椭球；A^T*n 保证剪切/镜像正确，平方比较避免六次 sqrt。
    let local_normal = value.x * instance.model_0.xyz
      + value.y * instance.model_1.xyz + value.z * instance.model_2.xyz;
    if (distance * distance > radius * radius * dot(local_normal, local_normal)) { return false; }
  }
  return true;
}

@compute @workgroup_size(64)
fn cull_instances(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= frustum.params.x) { return; }
  let item = metadata[id.x];
  if ((item.y & frustum.params.y) == 0u) { return; }
  let source = source_instances[id.x];
  if (!is_visible(source, bounds[id.x])) { return; }
  let local = atomicAdd(&indirect[item.x].instance_count, 1u);
  visible_instances[item.z + local] = source;
}
