// Deep Engine native HDR bloom shader contract v1.
@group(0) @binding(0) var source_color: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;

struct BloomParams {
  threshold: f32,
  soft_knee: f32,
  radius: f32,
  _padding: f32,
};
@group(0) @binding(2) var<uniform> bloom: BloomParams;

struct FullscreenVertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vertex_main(@builtin(vertex_index) index: u32) -> FullscreenVertex {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  var output: FullscreenVertex;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

fn sampled(uv: vec2f) -> vec3f {
  return max(textureSampleLevel(source_color, linear_sampler, uv, 0.0).rgb, vec3f(0.0));
}

@fragment fn fragment_prefilter(input: FullscreenVertex) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(source_color));
  let color = (sampled(input.uv + texel * vec2f(-0.25, -0.25))
    + sampled(input.uv + texel * vec2f(0.25, -0.25))
    + sampled(input.uv + texel * vec2f(-0.25, 0.25))
    + sampled(input.uv + texel * vec2f(0.25, 0.25))) * 0.25;
  let brightness = max(color.r, max(color.g, color.b));
  let knee = max(bloom.threshold * bloom.soft_knee, 0.00001);
  var soft = clamp(brightness - bloom.threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 0.00001);
  let contribution = max(brightness - bloom.threshold, soft) / max(brightness, 0.00001);
  return vec4f(color * contribution, 1.0);
}

fn gaussian(uv: vec2f, direction: vec2f) -> vec3f {
  let step_uv = direction * bloom.radius / vec2f(textureDimensions(source_color));
  var color = sampled(uv) * 0.227027;
  color += sampled(uv + step_uv * 1.384615) * 0.316216;
  color += sampled(uv - step_uv * 1.384615) * 0.316216;
  color += sampled(uv + step_uv * 3.230769) * 0.070270;
  color += sampled(uv - step_uv * 3.230769) * 0.070270;
  return color;
}

@fragment fn fragment_blur_horizontal(input: FullscreenVertex) -> @location(0) vec4f {
  return vec4f(gaussian(input.uv, vec2f(1.0, 0.0)), 1.0);
}

@fragment fn fragment_blur_vertical(input: FullscreenVertex) -> @location(0) vec4f {
  return vec4f(gaussian(input.uv, vec2f(0.0, 1.0)), 1.0);
}
