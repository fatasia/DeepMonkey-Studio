// Deep Engine native Deep2d backdrop shader contract v1.
//
// Deep Engine native Deep2d backdrop blur chain (刀 4 frosted glass).
//
// Captures the composited target below a backdrop command, downsamples it to
// half resolution and runs `iterations` separable [1,4,6,4,1]/16 binomial
// sweeps, then the base draw samples the blurred capture through the analytic
// rounded-box SDF mask as the command's base color.
//
// Rust mirrors of every formula live in `deep2d/backdrop.rs` and the CPU
// oracle `paint_reference::rasterize_backdrop_chunk`; the GPU readback tests
// diff the two, so these must stay branch-identical.
//
// Stage semantics pinned to the CPU mirror:
//  - downsample: FOUR explicit taps at exact full-res texel centers with
//    clamp-to-edge (odd tails clamp like the CPU, a single linear sample
//    would not), averaged /4;
//  - sweeps: five taps at exact texel centers (nearest sampler), weights
//    1/4/6/4/1 over 16, clamped to the border texel;
//  - every stage stores Rgba8Unorm, matching the CPU `to_u8_rgba`
//    quantization step;
//  - base: bilinear (linear sampler) sample at `(physical - origin) * 0.5`
//    texel units, masked by `sdf_coverage` of the rounded-box SDF.

struct StageParams {
  // Half-resolution (downsample output / sweep) target size in texels.
  half_size: vec2f,
  // Full-resolution source size in texels (downsample input).
  full_size: vec2f,
};

@group(0) @binding(0) var<uniform> stage: StageParams;
@group(0) @binding(1) var source_tex: texture_2d<f32>;
@group(0) @binding(2) var point_sampler: sampler;

struct FullVertexOutput {
  @builtin(position) position: vec4f,
};

// Fullscreen triangle-pair: six vertices of the unit quad (NDC).
@vertex
fn stage_vertex(@location(0) corner: vec2f) -> FullVertexOutput {
  var output: FullVertexOutput;
  output.position = vec4f(corner, 0.0, 1.0);
  return output;
}

fn texel_clamp(texel: i32, size: u32) -> u32 {
  return u32(clamp(texel, 0, i32(size) - 1));
}

@fragment
fn downsample_fragment(input: FullVertexOutput) -> @location(0) vec4f {
  // Target texel center -> the four full-res texels it averages.
  let out_texel = floor(input.position.xy);
  let base = vec2f(out_texel.x * 2.0, out_texel.y * 2.0);
  let size = vec2u(stage.full_size);
  var sum = vec4f(0.0);
  for (var dy = 0u; dy < 2u; dy++) {
    for (var dx = 0u; dx < 2u; dx++) {
      let texel = vec2u(texel_clamp(i32(base.x) + i32(dx), size.x), texel_clamp(i32(base.y) + i32(dy), size.y));
      sum += textureLoad(source_tex, texel, 0);
    }
  }
  return sum / 4.0;
}

@fragment
fn sweep_h_fragment(input: FullVertexOutput) -> @location(0) vec4f {
  let center = floor(input.position.xy) + vec2f(0.5);
  let texel_uv = center / stage.half_size;
  var sum = vec4f(0.0);
  sum += textureSampleLevel(source_tex, point_sampler, (center - vec2f(2.0, 0.0)) / stage.half_size, 0.0);
  sum += textureSampleLevel(source_tex, point_sampler, (center - vec2f(1.0, 0.0)) / stage.half_size, 0.0) * 4.0;
  sum += textureSampleLevel(source_tex, point_sampler, texel_uv, 0.0) * 6.0;
  sum += textureSampleLevel(source_tex, point_sampler, (center + vec2f(1.0, 0.0)) / stage.half_size, 0.0) * 4.0;
  sum += textureSampleLevel(source_tex, point_sampler, (center + vec2f(2.0, 0.0)) / stage.half_size, 0.0);
  return sum / 16.0;
}

@fragment
fn sweep_v_fragment(input: FullVertexOutput) -> @location(0) vec4f {
  let center = floor(input.position.xy) + vec2f(0.5);
  let texel_uv = center / stage.half_size;
  var sum = vec4f(0.0);
  sum += textureSampleLevel(source_tex, point_sampler, (center - vec2f(0.0, 2.0)) / stage.half_size, 0.0);
  sum += textureSampleLevel(source_tex, point_sampler, (center - vec2f(0.0, 1.0)) / stage.half_size, 0.0) * 4.0;
  sum += textureSampleLevel(source_tex, point_sampler, texel_uv, 0.0) * 6.0;
  sum += textureSampleLevel(source_tex, point_sampler, (center + vec2f(0.0, 1.0)) / stage.half_size, 0.0) * 4.0;
  sum += textureSampleLevel(source_tex, point_sampler, (center + vec2f(0.0, 2.0)) / stage.half_size, 0.0);
  return sum / 16.0;
}

// ---------------------------------------------------------------------------
// Base draw: blurred capture under the command's rounded-box SDF mask.

struct BaseParams {
  // Canvas-space rect of the glass: [x, y, width, height].
  rect: vec4f,
  // Capture region origin in physical target pixels.
  capture_origin: vec2f,
  // Half-resolution capture size in texels (uv conversion).
  capture_half: vec2f,
  // Physical pixels per logical unit (letterbox ratio, analytic AA scale).
  aa: f32,
  corner_radius: f32,
  // Letterbox mapping duplicated from the main frame uniform.
  logical_size: vec2f,
  physical_size: vec2f,
};

@group(0) @binding(0) var<uniform> base: BaseParams;
@group(0) @binding(1) var blur_tex: texture_2d<f32>;
@group(0) @binding(2) var linear_sampler: sampler;

struct BaseVertexOutput {
  @builtin(position) position: vec4f,
  // Canvas-space position (logical units), interpolated per fragment.
  @location(0) canvas: vec2f,
};

// Same letterbox mapping as the main painter shader (`logical_to_ndc`).
fn logical_to_ndc(point: vec2f) -> vec2f {
  let ratio = min(
    base.physical_size.x / base.logical_size.x,
    base.physical_size.y / base.logical_size.y,
  );
  let scaled = point * ratio;
  let offset = (base.physical_size - base.logical_size * ratio) * 0.5;
  let pixel = scaled + offset;
  return vec2f(
    pixel.x / base.physical_size.x * 2.0 - 1.0,
    1.0 - pixel.y / base.physical_size.y * 2.0,
  );
}

@vertex
fn base_vertex(@location(0) canvas: vec2f) -> BaseVertexOutput {
  var output: BaseVertexOutput;
  output.position = vec4f(logical_to_ndc(canvas), 0.0, 1.0);
  output.canvas = canvas;
  return output;
}

fn sd_rounded_box(q: vec2f, half: vec2f, radius: f32) -> f32 {
  let d = abs(q) - (half - vec2f(radius));
  let inside = min(max(d.x, d.y), 0.0);
  let outside = length(max(d, vec2f(0.0)));
  return outside + inside - radius;
}

fn sdf_coverage(d: f32, aa: f32) -> f32 {
  return clamp(0.5 * aa - d * aa, 0.0, 1.0);
}

@fragment
fn base_fragment(input: BaseVertexOutput) -> @location(0) vec4f {
  let ratio = min(
    base.physical_size.x / base.logical_size.x,
    base.physical_size.y / base.logical_size.y,
  );
  let offset = (base.physical_size - base.logical_size * ratio) * 0.5;
  // Physical pixel center under this fragment (matches the CPU oracle's
  // `physical = canvas * ratio + offset` at pixel centers).
  let physical = input.canvas * ratio + offset;
  // Half-res capture texel coordinate: half-res texel i covers physical
  // texels [2i, 2i+1], so texel units = (physical - origin) * 0.5.
  let coord = (physical - base.capture_origin) * 0.5;
  let blurred = textureSampleLevel(blur_tex, linear_sampler, coord / base.capture_half, 0.0);
  // Rounded-box SDF mask on the rect (canvas space), half-pixel AA feather.
  let half = vec2f(base.rect.z, base.rect.w) * 0.5;
  let center = base.rect.xy + half;
  let d = sd_rounded_box(input.canvas - center, half, base.corner_radius);
  let coverage = sdf_coverage(d, base.aa);
  return vec4f(blurred.rgb, blurred.a * coverage);
}
