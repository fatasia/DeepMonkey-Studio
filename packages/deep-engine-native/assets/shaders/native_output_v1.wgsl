// Deep Engine native HDR output shader contract v1.
@group(0) @binding(0) var hdr_color: texture_2d<f32>;

struct OutputVertex {
  @builtin(position) position: vec4f,
};

@vertex fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> OutputVertex {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  var output: OutputVertex;
  output.position = vec4f(positions[vertex_index], 0.0, 1.0);
  return output;
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

fn resolved_hdr(position: vec4f) -> vec4f {
  // 纯二维档位用单个HDR像素保留同一背景与ACES路径。
  let pixel = min(vec2i(position.xy), vec2i(textureDimensions(hdr_color)) - vec2i(1));
  return textureLoad(hdr_color, pixel, 0);
}

@fragment fn fragment_srgb_target(input: OutputVertex) -> @location(0) vec4f {
  let hdr = resolved_hdr(input.position);
  return vec4f(aces(hdr.rgb), hdr.a);
}

@fragment fn fragment_unorm_target(input: OutputVertex) -> @location(0) vec4f {
  let hdr = resolved_hdr(input.position);
  return vec4f(linear_to_srgb(aces(hdr.rgb)), hdr.a);
}
