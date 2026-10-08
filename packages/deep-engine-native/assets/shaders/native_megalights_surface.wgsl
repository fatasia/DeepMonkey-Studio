struct Params { clipToView: mat4x4f, worldToView: mat4x4f, viewport: vec2u, fullViewport: vec2u, reserved: vec4u };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var depth: texture_depth_multisampled_2d;
@group(0) @binding(2) var<storage, read_write> surfaces: array<vec4f>;
@group(0) @binding(3) var baseMetal: texture_2d<f32>;
@group(0) @binding(4) var normalRoughness: texture_2d<f32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (any(gid.xy >= params.viewport)) { return; }
  let pixel = vec2i((vec2f(gid.xy)+0.5)/vec2f(params.viewport)*vec2f(params.fullViewport));
  var value = textureLoad(depth, pixel, 0);
  for (var sample = 1; sample < 4; sample++) { value = min(value, textureLoad(depth, pixel, sample)); }
  let base = (gid.y * params.viewport.x + gid.x) * 3u;
  let normalRough = textureLoad(normalRoughness, pixel, 0);
  if (value >= 1.0 || all(normalRough.xyz == vec3f(0.0))) {
    surfaces[base] = vec4f(0.0); surfaces[base + 1u] = vec4f(0.0); surfaces[base + 2u] = vec4f(0.0); return;
  }
  let uv = (vec2f(pixel) + 0.5) / vec2f(params.fullViewport);
  let projected = params.clipToView * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, value, 1.0);
  let normalView = (params.worldToView * vec4f(normalRough.xyz * 2.0 - 1.0, 0.0)).xyz;
  let material = textureLoad(baseMetal, pixel, 0);
  let receiveShadow = material.a < 2.0;
  surfaces[base] = vec4f(projected.xyz / projected.w, select(material.a - 2.0, material.a, receiveShadow));
  surfaces[base + 1u] = vec4f(normalize(normalView), normalRough.a);
  surfaces[base + 2u] = vec4f(material.rgb, select(0.0, 1.0, receiveShadow));
}
