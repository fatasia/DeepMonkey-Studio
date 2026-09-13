// Deep Engine native Deep2d atlas shader contract v1.
struct PainterFrame {
  logical_size: vec2f,
  reserved: vec2f,
};

@group(0) @binding(0) var<uniform> frame: PainterFrame;
@group(1) @binding(0) var atlas_texture: texture_2d<f32>;
@group(1) @binding(1) var atlas_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) glyph: f32,
};

@vertex
fn vertex_main(
  @location(0) position: vec2f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(3) glyph: f32,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(
    position.x / frame.logical_size.x * 2.0 - 1.0,
    1.0 - position.y / frame.logical_size.y * 2.0,
    0.0,
    1.0,
  );
  output.uv = uv;
  output.color = color;
  output.glyph = glyph;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let sampled = textureSample(atlas_texture, atlas_sampler, input.uv);
  if input.glyph > 0.5 {
    return vec4f(input.color.rgb, input.color.a * sampled.r);
  }
  return sampled * input.color;
}
