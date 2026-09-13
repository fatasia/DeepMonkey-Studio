// Deep Engine native cascaded shadow sampling contract v1.
struct CascadedShadowData {
  matrices: array<mat4x4f, 4>,
  split_depths: vec4f,
  blend_starts: vec4f,
  texel_world: vec4f,
  params: vec4f,
  camera_forward: vec4f,
};

@group(0) @binding(1) var shadow_map: texture_depth_2d_array;
@group(0) @binding(2) var shadow_sampler: sampler_comparison;
@group(0) @binding(7) var<uniform> cascaded_shadow: CascadedShadowData;

fn cascade_index(view_depth: f32) -> u32 {
  let count = clamp(u32(cascaded_shadow.params.x), 1u, 4u);
  for (var index = 0u; index < count; index++) {
    if (view_depth <= cascaded_shadow.split_depths[index]) { return index; }
  }
  return count - 1u;
}

fn sample_cascade(index: u32, world: vec3f, normal: vec3f, n_dot_l: f32) -> f32 {
  let receiver = world + normal * cascaded_shadow.texel_world[index]
    * (1.0 - clamp(n_dot_l, 0.0, 1.0));
  let clip = cascaded_shadow.matrices[index] * vec4f(receiver, 1.0);
  let projected = clip.xyz / clip.w;
  let uv = projected.xy * vec2f(0.5, -0.5) + 0.5;
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0))
    && projected.z >= 0.0 && projected.z <= 1.0;
  if (!inside) { return 1.0; }
  var visibility = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      visibility += textureSampleCompareLevel(shadow_map, shadow_sampler,
        uv + vec2f(f32(x), f32(y)) * cascaded_shadow.params.z,
        i32(index), projected.z - cascaded_shadow.params.y);
    }
  }
  return visibility / 9.0;
}

fn shadow_visibility(world: vec3f, normal: vec3f, n_dot_l: f32) -> f32 {
  let count = clamp(u32(cascaded_shadow.params.x), 1u, 4u);
  let view_depth = dot(world - frame.eye.xyz, cascaded_shadow.camera_forward.xyz);
  if (view_depth > cascaded_shadow.split_depths[count - 1u]) { return 1.0; }
  let index = cascade_index(view_depth);
  let current = sample_cascade(index, world, normal, n_dot_l);
  if (index + 1u >= count) { return current; }
  let blend_start = cascaded_shadow.blend_starts[index];
  let split = cascaded_shadow.split_depths[index];
  return mix(current, sample_cascade(index + 1u, world, normal, n_dot_l),
    smoothstep(blend_start, split, view_depth));
}
