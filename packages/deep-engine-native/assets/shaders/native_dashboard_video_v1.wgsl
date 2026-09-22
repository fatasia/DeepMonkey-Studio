struct PainterFrame {
  logical_size: vec2f,
  physical_size: vec2f,
};

@group(0) @binding(0) var<uniform> frame: PainterFrame;
@group(1) @binding(0) var video_texture: texture_2d<f32>;
@group(1) @binding(1) var video_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

struct SolidVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

fn logical_to_ndc(point: vec2f) -> vec2f {
  let ratio = min(
    frame.physical_size.x / frame.logical_size.x,
    frame.physical_size.y / frame.logical_size.y,
  );
  let pixel = point * ratio + (frame.physical_size - frame.logical_size * ratio) * 0.5;
  return vec2f(
    pixel.x / frame.physical_size.x * 2.0 - 1.0,
    1.0 - pixel.y / frame.physical_size.y * 2.0,
  );
}

@vertex
fn vertex_main(@location(0) position: vec2f, @location(1) uv: vec2f) -> VertexOutput {
  var output: VertexOutput;
  let ndc = logical_to_ndc(position);
  output.position = vec4f(ndc, 0.0, 1.0);
  output.uv = uv;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(video_texture, video_sampler, input.uv);
}

@vertex
fn solid_vertex_main(
  @location(0) position: vec2f,
  @location(1) color: vec4f,
) -> SolidVertexOutput {
  var output: SolidVertexOutput;
  output.position = vec4f(logical_to_ndc(position), 0.0, 1.0);
  output.color = color;
  return output;
}

@fragment
fn solid_fragment_main(input: SolidVertexOutput) -> @location(0) vec4f {
  return input.color;
}
