enable wgpu_ray_query;
struct Params { viewToWorld: mat4x4f, viewport: vec2u, count: u32, shadowMask: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> surfaces: array<vec4f>;
@group(0) @binding(2) var<storage, read> reservoirs: array<vec4f>;
@group(0) @binding(3) var<storage, read> lights: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> visibility: array<f32>;
@group(0) @binding(5) var scene: acceleration_structure;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (any(gid.xy >= params.viewport)) { return; }
  let index = gid.y * params.viewport.x + gid.x;
  visibility[index] = 1.0;
  let winner = u32(reservoirs[index].y);
  if (winner == 0u || winner > params.count || reservoirs[index].z == 0.0) { return; }
  if (surfaces[index * 3u + 2u].w == 0.0 || (params.shadowMask & (1u << (winner - 1u))) == 0u) { return; }
  let point = (params.viewToWorld * vec4f(surfaces[index * 3u].xyz, 1.0)).xyz;
  let lightPosition = (params.viewToWorld * vec4f(lights[(winner - 1u) * 4u].xyz, 1.0)).xyz;
  let delta = lightPosition - point;
  let distance = length(delta);
  if (!(distance > 0.0)) { return; }
  let direction = delta / distance;
  let bias = distance * 0.001;
  var ray: ray_query;
  rayQueryInitialize(&ray, scene, RayDesc(0u, 0xFFu, 0.0, distance - bias * 2.0, point + direction * bias, direction));
  while (rayQueryProceed(&ray)) {}
  let hit = rayQueryGetCommittedIntersection(&ray);
  visibility[index] = select(1.0, 0.0, hit.kind != RAY_QUERY_INTERSECTION_NONE);
}
