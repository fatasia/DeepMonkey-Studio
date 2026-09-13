// Deep Engine native Deep2d painter shader contract v1.
struct PainterFrame {
  logical_size: vec2f,
  reserved: vec2f,
};

@group(0) @binding(0) var<uniform> frame: PainterFrame;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vertex_main(
  @location(0) position: vec2f,
  @location(1) color: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(
    position.x / frame.logical_size.x * 2.0 - 1.0,
    1.0 - position.y / frame.logical_size.y * 2.0,
    0.0,
    1.0,
  );
  output.color = color;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  return input.color;
}
