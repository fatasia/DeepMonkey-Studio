// Deep Engine native Deep2d painter shader contract v2.
//
// v2 adds the GPUI visual trio on top of the v1 flat-color path pipeline:
//  - gradient fills (linear + radial) evaluated per fragment from a paint
//    storage buffer, in the command's LOCAL pre-transform space;
//  - analytic rounded-rect quads (PathCommand cornerRadius) shaded through a
//    rounded-box SDF with a half-pixel AA feather — zero CPU arc geometry;
//  - box shadows as an analytic smoothstep falloff of the same SDF
//    (blur == 0 degrades to the crisp edge rule), composited under the fill.
//
// Rust mirrors of every formula live in `deep2d/paint_data.rs`; the GPU
// readback tests diff the two, so these must stay branch-identical.
struct PainterFrame {
  logical_size: vec2f,
  // Physical target size in pixels; drives aspect-fit letterboxing so the
  // logical canvas never stretches across mismatched aspect ratios (D08).
  physical_size: vec2f,
};

// 32-byte stop row: four f32s keep `color` at offset 16 (a vec3f pad would
// force 16-byte alignment and grow the stride to 48, desyncing the Rust
// `Deep2dPaintStop` layout).
struct PaintStop {
  offset: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
  color: vec4f,
};

const PAINT_KIND_SOLID: u32 = 0u;
const PAINT_KIND_LINEAR: u32 = 1u;
const PAINT_KIND_RADIAL: u32 = 2u;
const PAINT_KIND_QUAD: u32 = 3u;
const MAX_STOPS: u32 = 16u;

struct PaintEntry {
  kind: u32,
  aa_scale: f32,
  stop_count: u32,
  opacity: f32,
  fill_index: u32,
  stroke_width: f32,
  radius: f32,
  shadow_radius: f32,
  p0: vec2f,
  p1: vec2f,
  color: vec4f,
  stroke_color: vec4f,
  shadow_offset: vec2f,
  shadow_blur: f32,
  shadow_spread: f32,
  shadow_color: vec4f,
  stops: array<PaintStop, 16>,
};

@group(0) @binding(0) var<uniform> frame: PainterFrame;
@group(0) @binding(1) var<storage, read> paints: array<PaintEntry>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) local: vec2f,
  @location(2) @interpolate(flat) paint_index: u32,
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
  @location(2) local: vec2f,
  @location(3) paint_index: f32,
) -> VertexOutput {
  var output: VertexOutput;
  let ndc = logical_to_ndc(position);
  output.position = vec4f(ndc.x, ndc.y, 0.0, 1.0);
  output.color = color;
  output.local = local;
  output.paint_index = u32(paint_index + 0.5);
  return output;
}

// Analytic rounded-box signed distance, uniform radius: the sharp-box SDF of
// the box shrunk by `radius`, minus `radius`. Negative inside.
fn sd_rounded_box(q: vec2f, half: vec2f, radius: f32) -> f32 {
  let d = abs(q) - (half - vec2f(radius));
  let inside = min(max(d.x, d.y), 0.0);
  let outside = length(max(d, vec2f(0.0)));
  return outside + inside - radius;
}

fn clamp_corner_radius(radius: f32, half: vec2f) -> f32 {
  return clamp(radius, 0.0, max(min(half.x, half.y), 0.0));
}

// Piecewise-linear straight-RGBA stop evaluation, clamped into the stop
// range; a run of equal offsets hard-cuts to the LAST stop (CSS convention).
// Branch-identical to `paint_data::gradient_stops_color`.
fn gradient_stops_color(entry: PaintEntry, t: f32) -> vec4f {
  if (entry.stop_count == 0u) {
    return vec4f(0.0);
  }
  if (entry.stop_count == 1u) {
    return entry.stops[0].color;
  }
  let first = entry.stops[0];
  let last = entry.stops[entry.stop_count - 1u];
  let tc = clamp(t, first.offset, last.offset);
  if (tc <= first.offset) {
    return first.color;
  }
  var index = 1u;
  while (index < entry.stop_count - 1u && tc > entry.stops[index].offset) {
    index++;
  }
  while (index + 1u < entry.stop_count && entry.stops[index + 1u].offset == entry.stops[index].offset) {
    index++;
  }
  let lower = entry.stops[index - 1u];
  let upper = entry.stops[index];
  let denom = upper.offset - lower.offset;
  let k = select(clamp((tc - lower.offset) / denom, 0.0, 1.0), 1.0, denom <= 0.0);
  return lower.color + (upper.color - lower.color) * k;
}

// Gradient paint evaluation (kinds 1|2), alpha faded by the entry opacity.
fn paint_color(entry: PaintEntry, local: vec2f) -> vec4f {
  var color: vec4f;
  if (entry.kind == PAINT_KIND_LINEAR) {
    let dir = entry.p1 - entry.p0;
    let length_squared = dot(dir, dir);
    var t = 0.0;
    if (length_squared > 1e-12) {
      t = dot(local - entry.p0, dir) / length_squared;
    }
    color = gradient_stops_color(entry, t);
  } else if (entry.kind == PAINT_KIND_RADIAL) {
    var t = 0.0;
    if (entry.radius > 0.0) {
      t = length(local - entry.p0) / entry.radius;
    }
    color = gradient_stops_color(entry, t);
  } else {
    color = entry.color;
  }
  if (entry.kind == PAINT_KIND_LINEAR || entry.kind == PAINT_KIND_RADIAL) {
    color.a = color.a * entry.opacity;
  }
  return color;
}

// Analytic fragment coverage: a half-pixel feather scaled by `aa`
// (physical pixels per local unit).
fn sdf_coverage(d: f32, aa: f32) -> f32 {
  return clamp(0.5 * aa - d * aa, 0.0, 1.0);
}

// Box-shadow coverage: smoothstep from 1 at the box edge to 0 exactly `blur`
// local units away; blur == 0 degrades to the crisp AA edge rule.
fn shadow_coverage(d: f32, blur: f32, aa: f32) -> f32 {
  if (blur > 0.0) {
    let t = clamp((blur - d) / blur, 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  }
  return sdf_coverage(d, aa);
}

fn over(source: vec4f, destination: vec4f) -> vec4f {
  return vec4f(
    source.rgb * source.a + destination.rgb * (1.0 - source.a),
    source.a + destination.a * (1.0 - source.a),
  );
}

// Full quad composite: shadow (bottom) <- fill <- stroke band (top), every
// layer faded by the entry opacity.
fn quad_fragment(entry: PaintEntry, local: vec2f) -> vec4f {
  let aa = entry.aa_scale;
  let half_inflated = max(entry.p1 + vec2f(entry.shadow_spread), vec2f(0.0));
  let shadow_rel = local - entry.p0 - entry.shadow_offset;
  let shadow_d = sd_rounded_box(shadow_rel, half_inflated, clamp_corner_radius(entry.shadow_radius, half_inflated));
  let shadow_alpha = entry.shadow_color.a * shadow_coverage(shadow_d, entry.shadow_blur, aa) * entry.opacity;

  let fill_d = sd_rounded_box(local - entry.p0, entry.p1, entry.radius);
  let fill_cov = sdf_coverage(fill_d, aa);
  var fill_color: vec4f;
  if (entry.fill_index == 0u) {
    fill_color = entry.color;
  } else {
    fill_color = paint_color(paints[entry.fill_index], local);
  }
  let fill_alpha = fill_color.a * fill_cov * entry.opacity;

  var stroke_alpha = 0.0;
  if (entry.stroke_width > 0.0) {
    let band = abs(fill_d) - entry.stroke_width * 0.5;
    stroke_alpha = entry.stroke_color.a * sdf_coverage(band, aa) * entry.opacity;
  }

  // Composite bottom-up in PREMULTIPLIED space, then convert back to
  // straight alpha: the ALPHA_BLENDING stage multiplies by alpha once more,
  // so returning straight color keeps total coverage exact. Branch-identical
  // to `paint_data::quad_fragment`.
  let shadow_rgb = entry.shadow_color.rgb * shadow_alpha;
  let fill_rgb = fill_color.rgb * fill_alpha;
  var rgb = fill_rgb + shadow_rgb * (1.0 - fill_alpha);
  var alpha = fill_alpha + shadow_alpha * (1.0 - fill_alpha);
  rgb = entry.stroke_color.rgb * stroke_alpha + rgb * (1.0 - stroke_alpha);
  alpha = stroke_alpha + alpha * (1.0 - stroke_alpha);
  if (alpha <= 0.0) {
    return vec4f(0.0);
  }
  return vec4f(rgb / alpha, alpha);
}

// 刀 4 fixed-function blend family:multiply/screen 管线族绑定 premul
// 入口——在混合阶段前把(straight)片元输出预乘,正是
// `paint_data::blend_composite` 那两个模式的前提。WGSL 禁止调用入口
// 函数,求值体抽成普通函数,两个入口各自包一层。
fn fragment_color(input: VertexOutput) -> vec4f {
  if (input.paint_index == 0u) {
    return input.color;
  }
  let entry = paints[input.paint_index];
  if (entry.kind == PAINT_KIND_QUAD) {
    return quad_fragment(entry, input.local);
  }
  return paint_color(entry, input.local);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  return fragment_color(input);
}

// 刀 4 fixed-function blend family: multiply/screen pipelines bind this
// entry point, which premultiplies the (straight) fragment output before the
// blend stage — the exact precondition of `paint_data::blend_composite` for
// those modes. normal/darken/lighten/overwrite keep `fragment_main`.
@fragment
fn fragment_main_premultiplied(input: VertexOutput) -> @location(0) vec4f {
  let color = fragment_color(input);
  return vec4f(color.rgb * color.a, color.a);
}
