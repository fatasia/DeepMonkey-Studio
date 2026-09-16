// Deep Engine native Deep2d atlas shader contract v1.
struct PainterFrame {
  logical_size: vec2f,
  // Physical target size in pixels; drives aspect-fit letterboxing so the
  // logical canvas never stretches across mismatched aspect ratios (D08).
  physical_size: vec2f,
};

@group(0) @binding(0) var<uniform> frame: PainterFrame;
@group(1) @binding(0) var atlas_texture: texture_2d<f32>;
@group(1) @binding(1) var atlas_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) glyph: f32,
  @location(3) @interpolate(flat) uv_bounds: vec4f,
};

// Mirrors native_deep2d_v1.wgsl: uniform scale + centered letterbox.
fn logical_to_ndc(point: vec2f) -> vec2f {
  let ratio = min(
    frame.physical_size.x / frame.logical_size.x,
    frame.physical_size.y / frame.logical_size.y,
  );
  let scaled = point * ratio;
  let offset = (frame.physical_size - frame.logical_size * ratio) * 0.5;
  let pixel = scaled + offset;
  return vec2f(
    pixel.x / frame.physical_size.x * 2.0 - 1.0,
    1.0 - pixel.y / frame.physical_size.y * 2.0,
  );
}

@vertex
fn vertex_main(
  @location(0) position: vec2f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
  @location(3) glyph: f32,
  @location(4) uv_bounds: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  let ndc = logical_to_ndc(position);
  output.position = vec4f(ndc.x, ndc.y, 0.0, 1.0);
  output.uv = uv;
  output.color = color;
  output.glyph = glyph;
  output.uv_bounds = uv_bounds;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = clamp(input.uv, input.uv_bounds.xy, input.uv_bounds.zw);
  let sampled = textureSample(atlas_texture, atlas_sampler, uv);
  if input.glyph > 0.5 {
    return vec4f(input.color.rgb, input.color.a * sampled.r);
  }
  return sampled * input.color;
}
