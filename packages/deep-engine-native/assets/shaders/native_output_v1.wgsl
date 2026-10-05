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

// Output color functions are assembled from shared displayColor and native_output_color.

fn resolved_hdr(position: vec4f) -> vec4f {
  // 纯二维档位用单个HDR像素保留同一背景与ACES路径。
  let pixel = min(vec2i(position.xy), vec2i(textureDimensions(hdr_color)) - vec2i(1));
  return textureLoad(hdr_color, pixel, 0);
}

@fragment fn fragment_srgb_target(input: OutputVertex) -> @location(0) vec4f {
  let hdr = resolved_hdr(input.position);
  let vignette_uv = input.position.xy / vec2f(textureDimensions(hdr_color));
  return vec4f(aces(author_grading_apply(hdr.rgb, vignette_uv)), hdr.a);
}

@fragment fn fragment_unorm_target(input: OutputVertex) -> @location(0) vec4f {
  let hdr = resolved_hdr(input.position);
  let vignette_uv = input.position.xy / vec2f(textureDimensions(hdr_color));
  return vec4f(linear_to_srgb(aces(author_grading_apply(hdr.rgb, vignette_uv))), hdr.a);
}
