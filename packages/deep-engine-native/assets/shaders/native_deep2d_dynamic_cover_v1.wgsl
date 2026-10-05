// Deep Engine native Deep2d dynamic path cover shader v1 (刀 3 stencil-then-cover).
//
// The stencil bracket of one dynamic path chunk runs three pipelines:
//   clear  — PathVertex bbox quad, stencil replace 0 (wipes the previous
//            chunk's stencil residue inside this chunk's own bbox);
//   cover  — fence triangles (per-edge "edge extruded to +Y infinity"),
//            increment/decrement winding into stencil (color writes masked);
//   fill   — reuses native_deep2d_v1.wgsl with a stencil test (nonzero:
//            NotEqual 0 / evenodd: Equal 0) and the v2 paint evaluation.
//
// Letterbox mapping mirrors native_deep2d_v1.wgsl (single source of truth for
// the logical→NDC transform; do not edit one without the other).

struct PainterFrame {
  logical_size: vec2f,
  physical_size: vec2f,
};

@group(0) @binding(0) var<uniform> frame: PainterFrame;

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

struct CoverOutput {
  @builtin(position) position: vec4f,
};

// Cover pass: fence triangle soup, positions only ([f32; 2] stride 8).
@vertex
fn vertex_edge(@location(0) position: vec2f) -> CoverOutput {
  return CoverOutput(vec4f(logical_to_ndc(position), 0.0, 1.0));
}

// Stencil-clear pass: consumes the PathVertex bbox quad (36-byte stride) so
// the clear region is exactly the chunk's own cover area.
struct PathVertexInput {
  @location(0) position: vec2f,
  @location(1) color: vec4f,
  @location(2) local: vec2f,
  @location(3) paint_index: f32,
};

@vertex
fn vertex_path(input: PathVertexInput) -> CoverOutput {
  return CoverOutput(vec4f(logical_to_ndc(input.position), 0.0, 1.0));
}

// Color output is masked off on both pipelines; a constant keeps the
// fragment stage trivial.
@fragment
fn fragment_cover() -> @location(0) vec4f {
  return vec4f(0.0);
}
