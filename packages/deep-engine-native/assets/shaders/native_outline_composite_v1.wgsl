
@group(0) @binding(0) var object_mask: texture_2d<f32>;
@group(0) @binding(1) var selected_depth: texture_depth_2d;
@group(0) @binding(2) var scene_depth: texture_depth_multisampled_2d;
struct VertexOutput { @builtin(position) position: vec4f };
@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: VertexOutput; output.position = vec4f(positions[index], 0.0, 1.0); return output;
}
fn sample_mask(pixel: vec2i, size: vec2i) -> f32 {
  return textureLoad(object_mask, clamp(pixel, vec2i(0), size - vec2i(1)), 0).r;
}
fn scene_depth_at(pixel: vec2i) -> f32 {
  var value = 1.0;
  for (var sample = 0; sample < 4; sample += 1) { value = min(value, textureLoad(scene_depth, pixel, sample)); }
  return value;
}
struct OutlineSample { alpha: f32, hidden: bool };
fn outline_sample(position: vec4f) -> OutlineSample {
  let size = vec2i(textureDimensions(object_mask));
  let pixel = clamp(vec2i(position.xy), vec2i(0), size - vec2i(1));
  var minimum = sample_mask(pixel, size); var maximum = minimum; var nearest_selected = 1.0;
  for (var y = -2; y <= 2; y += 1) { for (var x = -2; x <= 2; x += 1) {
    if (abs(x) + abs(y) > 2) { continue; }
    let point = clamp(pixel + vec2i(x, y), vec2i(0), size - vec2i(1));
    let value = sample_mask(point, size);
    minimum = min(minimum, value); maximum = max(maximum, value);
    if (value > 0.001) { nearest_selected = min(nearest_selected, textureLoad(selected_depth, point, 0)); }
  }}
  var result: OutlineSample;
  result.alpha = clamp((maximum - minimum) * 2.5, 0.0, 1.0);
  result.hidden = nearest_selected > scene_depth_at(pixel) + 0.0005;
  return result;
}
fn linear_to_srgb(linear: vec3f) -> vec3f {
  let low = linear * 12.92; let high = 1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, linear <= vec3f(0.0031308));
}
fn outline_color(sample: OutlineSample) -> vec4f {
  return vec4f(select(vec3f(0.3, 0.62, 1.0), vec3f(0.14, 0.29, 0.44), sample.hidden), sample.alpha);
}
@fragment fn fragment_srgb_target(input: VertexOutput) -> @location(0) vec4f { return outline_color(outline_sample(input.position)); }
@fragment fn fragment_unorm_target(input: VertexOutput) -> @location(0) vec4f {
  let sample = outline_sample(input.position); let color = outline_color(sample);
  return vec4f(linear_to_srgb(color.rgb), color.a);
}
