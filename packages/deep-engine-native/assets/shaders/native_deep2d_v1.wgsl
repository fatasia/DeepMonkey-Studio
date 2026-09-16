// Deep Engine native Deep2d painter shader contract v1.
struct PainterFrame {
  logical_size: vec2f,
  // Physical target size in pixels; drives aspect-fit letterboxing so the
  // logical canvas never stretches across mismatched aspect ratios (D08).
  physical_size: vec2f,
};

@group(0) @binding(0) var<uniform> frame: PainterFrame;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

// Maps logical canvas coordinates to physical NDC. The canvas is uniformly
// scaled (min of the per-axis ratios) and centered: mismatched aspect ratios
// letterbox instead of stretching, matching Browser canvas behavior.
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
  @location(1) color: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  let ndc = logical_to_ndc(position);
  output.position = vec4f(ndc.x, ndc.y, 0.0, 1.0);
  output.color = color;
  return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  return input.color;
}
