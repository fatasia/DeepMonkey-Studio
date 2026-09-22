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

fn local_spot_pcss(layer: i32, uv: vec2f, receiverDepth: f32, softness: f32) -> f32 {
  let size = vec2f(textureDimensions(shadow_map));
  let texel = 1.0 / size;
  let minimum = texel * 0.5;
  let maximum = vec2f(1.0) - minimum;
  let offsets = array<vec2f,4>(vec2f(-1.5,-1.5),vec2f(1.5,-1.5),vec2f(-1.5,1.5),vec2f(1.5,1.5));
  var blockers = 0.0; var count = 0.0;
  for (var index = 0u; index < 4u; index++) {
    let pixel = vec2i(floor(clamp(uv + offsets[index] * texel, minimum, maximum) * size));
    let depth = textureLoad(shadow_map, pixel, layer, 0);
    if (depth < receiverDepth) { blockers += depth; count += 1.0; }
  }
  if (count < 0.5) { return 1.0; }
  let average = blockers / count;
  let radius = clamp((receiverDepth - average) / max(average,0.00001) * softness * 64.0,1.0,4.0);
  let taps = array<vec2f,12>(vec2f(-0.613,0.617),vec2f(0.170,-0.940),vec2f(0.794,0.317),vec2f(-0.880,-0.250),
    vec2f(0.455,0.786),vec2f(-0.230,-0.690),vec2f(0.970,-0.090),vec2f(-0.480,0.120),
    vec2f(0.080,0.420),vec2f(0.520,-0.410),vec2f(-0.720,-0.660),vec2f(0.310,0.080));
  var visibility = 0.0;
  for (var index = 0u; index < 12u; index++) {
    visibility += textureSampleCompareLevel(shadow_map,shadow_sampler,
      clamp(uv + taps[index] * texel * radius,minimum,maximum),layer,receiverDepth);
  }
  return visibility / 12.0;
}

fn local_spot_visibility(index: u32, depthFactor: f32, world: vec3f, n_dot_l: f32, softness: f32) -> f32 {
  if (index >= min(u32(frame.lightingOptions.w),10u)) { return 1.0; }
  let clip = frame.localShadowMatrices[index] * vec4f(world,1.0);
  if (clip.w <= 0.0) { return 1.0; }
  let projected = clip.xyz / clip.w;
  let uv = projected.xy * vec2f(0.5,-0.5)+0.5;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || projected.z < 0.0 || projected.z > 1.0) { return 1.0; }
  // 用透视深度导数把半个 shadow texel 的世界偏移映射到 depth，避免远处漏影。
  let matrix = frame.localShadowMatrices[index];
  let focal = length(vec3f(matrix[0].y,matrix[1].y,matrix[2].y));
  let bias = max(0.0000002, depthFactor*cascaded_shadow.params.z/(clip.w*focal)
    * (1.0+2.0*(1.0-clamp(n_dot_l,0.0,1.0))));
  if (softness > 0.0) { return local_spot_pcss(i32(cascaded_shadow.params.x)+i32(index),uv,projected.z-bias,clamp(softness,0.0,1.0)); }
  var visibility=0.0;
  for (var y=-1; y<=1; y++) {
    for (var x=-1; x<=1; x++) {
      visibility += textureSampleCompareLevel(shadow_map,shadow_sampler,
        uv+vec2f(f32(x),f32(y))*cascaded_shadow.params.z,
        i32(cascaded_shadow.params.x)+i32(index),projected.z-bias);
    }
  }
  return visibility/9.0;
}

fn point_shadow_face(direction: vec3f) -> u32 {
  let major = abs(direction);
  if (major.x >= major.y && major.x >= major.z) { return select(1u,0u,direction.x >= 0.0); }
  if (major.y >= major.z) { return select(3u,2u,direction.y >= 0.0); }
  return select(5u,4u,direction.z >= 0.0);
}
