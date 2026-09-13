// Deep Engine native HDR bloom output shader contract v1.
@group(0) @binding(0) var hdr_color: texture_2d<f32>;
@group(0) @binding(1) var bloom_color: texture_2d<f32>;
@group(0) @binding(2) var bloom_sampler: sampler;

struct OutputParams {
  values: vec4f,
};
@group(0) @binding(3) var<uniform> output: OutputParams;

struct OutputVertex {
  @builtin(position) position: vec4f,
};

@vertex fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> OutputVertex {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var result: OutputVertex;
  result.position = vec4f(positions[vertex_index], 0.0, 1.0);
  return result;
}

fn aces(color: vec3f) -> vec3f {
  return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14),
    vec3f(0.0), vec3f(1.0));
}

fn linear_to_srgb(linear: vec3f) -> vec3f {
  let low = linear * 12.92;
  let high = 1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, linear <= vec3f(0.0031308));
}

fn combined_hdr(position: vec4f) -> vec4f {
  let pixel = vec2i(position.xy);
  let hdr = textureLoad(hdr_color, pixel, 0);
  let uv = (vec2f(pixel) + 0.5) / vec2f(textureDimensions(hdr_color));
  let glow = textureSampleLevel(bloom_color, bloom_sampler, uv, 0.0).rgb
    * output.values.x;
  return vec4f(hdr.rgb + glow, hdr.a);
}

@fragment fn fragment_srgb_target(input: OutputVertex) -> @location(0) vec4f {
  let hdr = combined_hdr(input.position);
  return vec4f(aces(hdr.rgb), hdr.a);
}

@fragment fn fragment_unorm_target(input: OutputVertex) -> @location(0) vec4f {
  let hdr = combined_hdr(input.position);
  return vec4f(linear_to_srgb(aces(hdr.rgb)), hdr.a);
}
