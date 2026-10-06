//! Paint storage entry and the f32 evaluation formulas shared by the WGSL
//! shader, the CPU reference oracle (`paint_reference`) and the prepare
//! stage. Every constant and branch here MUST stay formula-identical to
//! `native_deep2d_v1.wgsl` — the GPU readback tests diff the two.
//!
//! Paint kinds: `0` solid (fragment returns the vertex color), `1` linear
//! gradient, `2` radial gradient, `3` rounded-rect SDF quad (fill + stroke
//! band + box shadow composited analytically in one fragment).

/// Maximum gradient stops carried in one paint entry (wire budget mirror:
/// `DEEP_2D_DISPLAY_LIST_BUDGETS.gradient_stops_per_paint`).
pub const DEEP2D_MAX_GRADIENT_STOPS: usize = 16;

pub const DEEP2D_PAINT_KIND_SOLID: u32 = 0;
pub const DEEP2D_PAINT_KIND_LINEAR: u32 = 1;
pub const DEEP2D_PAINT_KIND_RADIAL: u32 = 2;
pub const DEEP2D_PAINT_KIND_QUAD: u32 = 3;

/// Blend-mode chunk encoding (mirrors `Deep2dBlendMode::as_u32`). Chunks
/// carry the mode and select a fixed-function blend pipeline family; the
/// paint storage entry layout stays untouched (byte-compatible).
pub const DEEP2D_BLEND_NORMAL: u32 = 0;
pub const DEEP2D_BLEND_MULTIPLY: u32 = 1;
pub const DEEP2D_BLEND_SCREEN: u32 = 2;
pub const DEEP2D_BLEND_DARKEN: u32 = 3;
pub const DEEP2D_BLEND_LIGHTEN: u32 = 4;
pub const DEEP2D_BLEND_OVERWRITE: u32 = 5;

/// Fixed-function mapping needs a premultiplied fragment output for exactly
/// these modes: the WGSL `fragment_main_premultiplied` entry point (selected
/// by the pipeline family) multiplies rgb by alpha before the blend stage.
pub fn blend_premultiplies(mode: u32) -> bool {
    mode == DEEP2D_BLEND_MULTIPLY || mode == DEEP2D_BLEND_SCREEN
}

/// CPU mirror of the per-mode fixed-function blend pipeline, straight-alpha
/// space end-to-end. `source` is the fragment output (straight color, exactly
/// what `fragment_main` evaluates); for multiply/screen the GPU pipeline
/// premultiplies it in-shader before the fixed-function stage, mirrored here
/// by folding `* sa` into the premultiplied terms. `destination` is the
/// straight-alpha target color in `[0, 1]`. The RGB operation mirrors the
/// pipeline color component exactly (on the premultiplied output where
/// marked):
/// - normal  `{SrcAlpha, OneMinusSrcAlpha, Add}`
/// - overwrite `{One, Zero, Add}`
/// - multiply `{Dst, OneMinusSrcAlpha, Add}` on premult output
///   = `s.a*s.rgb*d + d*(1 - s.a)`
/// - screen  `{One, OneMinusSrc, Add}` on premult output
///   = `s.a*s.rgb + d*(1 - s.a*s.rgb)`
/// - darken  `{One, One, Min}`, lighten `{One, One, Max}`
/// Alpha is `{One, OneMinusSrcAlpha, Add}` (normal over) for every mode
/// except overwrite, whose alpha stage is `{One, Zero, Add}` (the pipeline
/// replaces the target wholesale, rgb AND a). Multiply/screen are exact on
/// opaque backdrops and follow the same fixed-function approximation as
/// upstream GPUI where the backdrop is translucent.
pub fn blend_composite(mode: u32, source: [f32; 4], destination: [f32; 4]) -> [f32; 4] {
    let [sr, sg, sb, sa] = source;
    let alpha = if mode == DEEP2D_BLEND_OVERWRITE {
        sa
    } else {
        sa + destination[3] * (1.0 - sa)
    };
    let rgb = match mode {
        DEEP2D_BLEND_MULTIPLY => {
            // Premultiplied fragment output rgb = s.rgb * s.a.
            let [pr, pg, pb] = [sr * sa, sg * sa, sb * sa];
            [
                pr * destination[0] + destination[0] * (1.0 - sa),
                pg * destination[1] + destination[1] * (1.0 - sa),
                pb * destination[2] + destination[2] * (1.0 - sa),
            ]
        }
        DEEP2D_BLEND_SCREEN => {
            let [pr, pg, pb] = [sr * sa, sg * sa, sb * sa];
            [
                pr + destination[0] * (1.0 - pr),
                pg + destination[1] * (1.0 - pg),
                pb + destination[2] * (1.0 - pb),
            ]
        }
        DEEP2D_BLEND_DARKEN => [
            sr.min(destination[0]),
            sg.min(destination[1]),
            sb.min(destination[2]),
        ],
        DEEP2D_BLEND_LIGHTEN => [
            sr.max(destination[0]),
            sg.max(destination[1]),
            sb.max(destination[2]),
        ],
        DEEP2D_BLEND_OVERWRITE => [sr, sg, sb],
        _ => [
            sr * sa + destination[0] * (1.0 - sa),
            sg * sa + destination[1] * (1.0 - sa),
            sb * sa + destination[2] * (1.0 - sa),
        ],
    };
    [rgb[0], rgb[1], rgb[2], alpha]
}

/// One gradient stop padded to a 32-byte WGSL row
/// (`{ offset: f32, pad: vec3f, color: vec4f }`).
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(C)]
pub struct Deep2dPaintStop {
    pub offset: f32,
    pub pad: [f32; 3],
    pub color: [f32; 4],
}

impl Deep2dPaintStop {
    pub fn new(offset: f64, color: [f64; 4]) -> Self {
        Self {
            offset: offset as f32,
            pad: [0.0; 3],
            color: [
                color[0] as f32,
                color[1] as f32,
                color[2] as f32,
                color[3] as f32,
            ],
        }
    }
}

impl Default for Deep2dPaintStop {
    fn default() -> Self {
        DEEP2D_ZERO_STOP
    }
}

/// GPU storage entry (`PaintEntry` in `native_deep2d_v1.wgsl`), 624 bytes,
/// 16-byte row aligned. Field order must match the WGSL struct exactly.
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(C)]
pub struct Deep2dPaintData {
    /// One of `DEEP2D_PAINT_KIND_*`.
    pub kind: u32,
    /// Physical pixels per local unit; drives the 0.5px analytic AA feather.
    pub aa_scale: f32,
    /// Gradient stops in use (`stops[0..stop_count]`, sorted by offset).
    pub stop_count: u32,
    /// Element opacity applied to every composited layer.
    pub opacity: f32,
    /// Quad fill paint slot; `0` means "solid, use `color`".
    pub fill_index: u32,
    /// Quad stroke band width in local units; `0` disables the stroke.
    pub stroke_width: f32,
    /// Quad corner radius already clamped to the half extents.
    pub radius: f32,
    /// Shadow corner radius already clamped to the inflated half extents.
    pub shadow_radius: f32,
    /// Linear start / radial center / quad rect origin (local units).
    pub p0: [f32; 2],
    /// Linear end / (unused) / quad half extents (local units).
    pub p1: [f32; 2],
    /// Solid fallback color (quad fill when `fill_index == 0`; gradient
    /// first-stop color for informational vertex uploads).
    pub color: [f32; 4],
    /// Quad stroke band color (straight alpha).
    pub stroke_color: [f32; 4],
    /// Shadow offset in local units + blur radius (>= 0) + spread.
    pub shadow_offset: [f32; 2],
    pub shadow_blur: f32,
    pub shadow_spread: f32,
    /// Shadow color (straight alpha).
    pub shadow_color: [f32; 4],
    /// Gradient stops, sorted by offset, trailing entries zeroed.
    pub stops: [Deep2dPaintStop; DEEP2D_MAX_GRADIENT_STOPS],
}

impl Default for Deep2dPaintData {
    fn default() -> Self {
        Self {
            kind: DEEP2D_PAINT_KIND_SOLID,
            aa_scale: 1.0,
            stop_count: 0,
            opacity: 1.0,
            fill_index: 0,
            stroke_width: 0.0,
            radius: 0.0,
            shadow_radius: 0.0,
            p0: [0.0; 2],
            p1: [0.0; 2],
            color: [0.0; 4],
            stroke_color: [0.0; 4],
            shadow_offset: [0.0; 2],
            shadow_blur: 0.0,
            shadow_spread: 0.0,
            shadow_color: [0.0; 4],
            stops: [DEEP2D_ZERO_STOP; DEEP2D_MAX_GRADIENT_STOPS],
        }
    }
}

const DEEP2D_ZERO_STOP: Deep2dPaintStop = Deep2dPaintStop {
    offset: 0.0,
    pad: [0.0; 3],
    color: [0.0; 4],
};

const _: () = assert!(std::mem::size_of::<Deep2dPaintStop>() == 32);
const _: () = assert!(
    std::mem::size_of::<Deep2dPaintData>()
        == 112 + DEEP2D_MAX_GRADIENT_STOPS * std::mem::size_of::<Deep2dPaintStop>()
);
const _: () = assert!(std::mem::size_of::<Deep2dPaintData>().is_multiple_of(16));

// SAFETY: `Deep2dPaintData` is a plain-data struct of f32/u32 fields with no
// padding beyond the declared layout (checked by the size asserts above), so
// any bit pattern is valid and bytemuck casts are sound.
unsafe impl bytemuck::Pod for Deep2dPaintData {}
unsafe impl bytemuck::Zeroable for Deep2dPaintData {}

/// Analytic rounded-box signed distance, uniform radius. `q` is the point
/// relative to the box center, `half` the half extents, `radius` the clamped
/// corner radius. Negative inside; exact for `radius == 0` (sharp box).
/// Derived as the sharp-box SDF of the box shrunk by `radius`, minus
/// `radius`: `q = |p| - (half - r)`; `min(max(q.x,q.y),0) + |max(q,0)| - r`.
pub fn sd_rounded_box(q: [f32; 2], half: [f32; 2], radius: f32) -> f32 {
    let inner = [half[0] - radius, half[1] - radius];
    let d = [q[0].abs() - inner[0], q[1].abs() - inner[1]];
    let inside = d[0].max(d[1]).min(0.0);
    let outside = d[0].max(0.0).hypot(d[1].max(0.0));
    outside + inside - radius
}

/// Clamps a corner radius to the half extents (GPUI: radius can never exceed
/// the box, oversized radii clamp down).
pub fn clamp_corner_radius(radius: f32, half: [f32; 2]) -> f32 {
    radius.clamp(0.0, half[0].min(half[1]).max(0.0))
}

/// Linear-gradient ramp position for a point; `p0`/`p1` are the ramp ends.
pub fn linear_gradient_t(p: [f32; 2], p0: [f32; 2], p1: [f32; 2]) -> f32 {
    let dir = [p1[0] - p0[0], p1[1] - p0[1]];
    let length_squared = dir[0] * dir[0] + dir[1] * dir[1];
    if length_squared <= 1e-12 {
        return 0.0;
    }
    let rel = [p[0] - p0[0], p[1] - p0[1]];
    (rel[0] * dir[0] + rel[1] * dir[1]) / length_squared
}

/// Radial-gradient ramp position (GPUI semantic: circle in local space).
pub fn radial_gradient_t(p: [f32; 2], center: [f32; 2], radius: f32) -> f32 {
    if radius <= 0.0 {
        return 0.0;
    }
    let rel = [p[0] - center[0], p[1] - center[1]];
    rel[0].hypot(rel[1]) / radius
}

fn lerp_color(a: [f32; 4], b: [f32; 4], k: f32) -> [f32; 4] {
    [
        a[0] + (b[0] - a[0]) * k,
        a[1] + (b[1] - a[1]) * k,
        a[2] + (b[2] - a[2]) * k,
        a[3] + (b[3] - a[3]) * k,
    ]
}

/// Piecewise-linear straight-RGBA stop evaluation. `t` is clamped into
/// `[stops[0].offset, stops[n-1].offset]`; identically-offset segments pick
/// the later stop (`k = 1`). Mirrored branch-for-branch in WGSL.
pub fn gradient_stops_color(stops: &[Deep2dPaintStop], stop_count: u32, t: f32) -> [f32; 4] {
    let count = stop_count as usize;
    if count == 0 {
        return [0.0; 4];
    }
    if count == 1 {
        return stops[0].color;
    }
    let first = stops[0];
    let last = stops[count - 1];
    let tc = t.clamp(first.offset, last.offset);
    if tc <= first.offset {
        return first.color;
    }
    let mut index = 1usize;
    while index < count - 1 && tc > stops[index].offset {
        index += 1;
    }
    // CSS hard-cut convention: at a run of equal offsets the LAST one wins.
    while index + 1 < count && stops[index + 1].offset == stops[index].offset {
        index += 1;
    }
    let lower = stops[index - 1];
    let upper = stops[index];
    let denom = upper.offset - lower.offset;
    let k = if denom <= 0.0 {
        1.0
    } else {
        ((tc - lower.offset) / denom).clamp(0.0, 1.0)
    };
    lerp_color(lower.color, upper.color, k)
}

/// Evaluates a gradient paint entry (`kinds 1|2`) at a local-space point,
/// fading by the entry opacity (path fills carry the command opacity there).
/// Kind `0` returns the entry color. Mirrored in WGSL `paint_color`.
pub fn paint_color(entry: &Deep2dPaintData, local: [f32; 2]) -> [f32; 4] {
    let mut color = match entry.kind {
        DEEP2D_PAINT_KIND_LINEAR => {
            let t = linear_gradient_t(local, entry.p0, entry.p1);
            gradient_stops_color(&entry.stops, entry.stop_count, t)
        }
        DEEP2D_PAINT_KIND_RADIAL => {
            let t = radial_gradient_t(local, entry.p0, entry.radius);
            gradient_stops_color(&entry.stops, entry.stop_count, t)
        }
        _ => entry.color,
    };
    if entry.kind == DEEP2D_PAINT_KIND_LINEAR || entry.kind == DEEP2D_PAINT_KIND_RADIAL {
        color[3] *= entry.opacity;
    }
    color
}

/// Analytic fragment coverage of an SDF edge: a half-pixel feather scaled by
/// `aa` (physical pixels per local unit).
pub fn sdf_coverage(d: f32, aa: f32) -> f32 {
    (0.5 * aa - d * aa).clamp(0.0, 1.0)
}

/// Box-shadow coverage: CSS-like analytic falloff. `blur > 0` smoothsteps
/// from 1 at the shadow box edge to 0 exactly `blur` local units away;
/// `blur == 0` degrades to the crisp AA edge. Mirrored in WGSL.
pub fn shadow_coverage(d: f32, blur: f32, aa: f32) -> f32 {
    if blur > 0.0 {
        let t = ((blur - d) / blur).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    } else {
        sdf_coverage(d, aa)
    }
}

/// Full quad fragment composite: shadow (bottom) <- fill <- stroke band
/// (top), every layer faded by `entry.opacity`. `local` is the interpolated
/// pre-transform point. Mirrored in WGSL `quad_fragment`.
pub fn quad_fragment(entry: &Deep2dPaintData, paints: &[Deep2dPaintData], local: [f32; 2]) -> [f32; 4] {
    let aa = entry.aa_scale;
    let opacity = entry.opacity;
    // Shadow layer (only when a shadow was authored: shadow_color.a > 0 or
    // offset/blur/spread present — validated by the producer, guarded here by
    // alpha so zero shadows are exact no-ops).
    let shadow_rel = [
        local[0] - entry.p0[0] - entry.shadow_offset[0],
        local[1] - entry.p0[1] - entry.shadow_offset[1],
    ];
    let half = [
        (entry.p1[0] + entry.shadow_spread).max(0.0),
        (entry.p1[1] + entry.shadow_spread).max(0.0),
    ];
    let shadow_d = sd_rounded_box(shadow_rel, half, clamp_corner_radius(entry.shadow_radius, half));
    let shadow_alpha = entry.shadow_color[3]
        * shadow_coverage(shadow_d, entry.shadow_blur, aa)
        * opacity;
    // Fill layer (paint slot or entry solid).
    let fill_rel = [local[0] - entry.p0[0], local[1] - entry.p0[1]];
    let fill_d = sd_rounded_box(fill_rel, entry.p1, entry.radius);
    let fill_cov = sdf_coverage(fill_d, aa);
    let fill_color = if entry.fill_index == 0 {
        entry.color
    } else {
        paints
            .get(entry.fill_index as usize)
            .map_or([0.0; 4], |paint| paint_color(paint, local))
    };
    let fill_alpha = fill_color[3] * fill_cov * opacity;
    // Stroke band straddling the shape edge (canvas semantics: centered on
    // the path, so it follows the rounded corners).
    let stroke_alpha = if entry.stroke_width > 0.0 {
        let band = fill_d.abs() - entry.stroke_width * 0.5;
        entry.stroke_color[3] * sdf_coverage(band, aa) * opacity
    } else {
        0.0
    };
    // Composite bottom-up in PREMULTIPLIED space, then convert back to
    // straight alpha: the GPU blend stage multiplies by alpha once more, so
    // returning straight color here keeps total coverage exact.
    let shadow = [
        entry.shadow_color[0] * shadow_alpha,
        entry.shadow_color[1] * shadow_alpha,
        entry.shadow_color[2] * shadow_alpha,
        shadow_alpha,
    ];
    let fill = [
        fill_color[0] * fill_alpha,
        fill_color[1] * fill_alpha,
        fill_color[2] * fill_alpha,
        fill_alpha,
    ];
    let stroke = [
        entry.stroke_color[0] * stroke_alpha,
        entry.stroke_color[1] * stroke_alpha,
        entry.stroke_color[2] * stroke_alpha,
        stroke_alpha,
    ];
    // fill over shadow
    let rgb = [
        fill[0] + shadow[0] * (1.0 - fill_alpha),
        fill[1] + shadow[1] * (1.0 - fill_alpha),
        fill[2] + shadow[2] * (1.0 - fill_alpha),
    ];
    let mut alpha = fill_alpha + shadow_alpha * (1.0 - fill_alpha);
    // stroke over (fill over shadow)
    let rgb = [
        stroke[0] + rgb[0] * (1.0 - stroke_alpha),
        stroke[1] + rgb[1] * (1.0 - stroke_alpha),
        stroke[2] + rgb[2] * (1.0 - stroke_alpha),
    ];
    alpha = stroke_alpha + alpha * (1.0 - stroke_alpha);
    if alpha <= 0.0 {
        return [0.0; 4];
    }
    [rgb[0] / alpha, rgb[1] / alpha, rgb[2] / alpha, alpha]
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f32 = 1e-6;

    fn assert_close(actual: [f32; 4], expected: [f32; 4]) {
        for (a, e) in actual.iter().zip(expected.iter()) {
            assert!((a - e).abs() < 1e-4, "{actual:?} vs {expected:?}");
        }
    }

    #[test]
    fn rounded_box_distance_matches_analytic_values() {
        let half = [10.0, 5.0];
        // Center: nearest edge is 5 units away.
        assert!((sd_rounded_box([0.0, 0.0], half, 0.0) - (-5.0f32)).abs() < EPS);
        // Exactly on the top edge.
        assert!(sd_rounded_box([0.0, 5.0], half, 0.0).abs() < EPS);
        // Corner arc with radius 5: corner circle center is (5, 0); the point
        // (11, 8) sits 10 units from it, so the SDF is 10 - 5 = 5.
        assert!((sd_rounded_box([11.0, 8.0], half, 5.0) - 5.0f32).abs() < 1e-4);
        // Inside the same arc: distance hypot(3,3) from the corner center,
        // SDF = hypot(3,3) - 5.
        let inside = sd_rounded_box([8.0, 3.0], half, 5.0);
        assert!((inside - (3.0f32.hypot(3.0) - 5.0)).abs() < 1e-4);
    }

    #[test]
    fn clamp_corner_radius_never_exceeds_half_extents() {
        assert_eq!(clamp_corner_radius(50.0, [10.0, 5.0]), 5.0);
        assert_eq!(clamp_corner_radius(-1.0, [10.0, 5.0]), 0.0);
        assert_eq!(clamp_corner_radius(3.0, [10.0, 5.0]), 3.0);
    }

    #[test]
    fn linear_t_is_the_projected_ramp_position() {
        assert_eq!(linear_gradient_t([2.5, 7.0], [0.0, 0.0], [10.0, 0.0]), 0.25);
        // Outside the ramp keeps going (stops clamp later).
        assert_eq!(linear_gradient_t([-5.0, 0.0], [0.0, 0.0], [10.0, 0.0]), -0.5);
        // Degenerate ramp pins to 0.
        assert_eq!(linear_gradient_t([3.0, 3.0], [1.0, 1.0], [1.0, 1.0]), 0.0);
    }

    #[test]
    fn radial_t_is_distance_over_radius() {
        assert_eq!(radial_gradient_t([13.0, 4.0], [5.0, 4.0], 4.0), 2.0);
        assert_eq!(radial_gradient_t([5.0, 4.0], [5.0, 4.0], 4.0), 0.0);
    }

    #[test]
    fn stops_evaluate_piecewise_and_clamp() {
        let stops = [
            Deep2dPaintStop::new(0.0, [0.0, 0.0, 0.0, 1.0]),
            Deep2dPaintStop::new(0.5, [1.0, 0.0, 0.0, 0.5]),
            Deep2dPaintStop::new(1.0, [0.0, 0.0, 1.0, 0.0]),
            DEEP2D_ZERO_STOP,
        ];
        assert_close(gradient_stops_color(&stops, 3, -1.0), [0.0, 0.0, 0.0, 1.0]);
        assert_close(gradient_stops_color(&stops, 3, 0.25), [0.5, 0.0, 0.0, 0.75]);
        assert_close(gradient_stops_color(&stops, 3, 1.5), [0.0, 0.0, 1.0, 0.0]);
        // Identical offsets pick the later stop.
        let equal = [
            Deep2dPaintStop::new(0.0, [0.0, 0.0, 0.0, 1.0]),
            Deep2dPaintStop::new(0.5, [1.0, 1.0, 1.0, 1.0]),
            Deep2dPaintStop::new(0.5, [0.0, 1.0, 0.0, 1.0]),
            DEEP2D_ZERO_STOP,
        ];
        assert_close(gradient_stops_color(&equal, 3, 0.5), [0.0, 1.0, 0.0, 1.0]);
        assert_close(gradient_stops_color(&stops, 1, 0.7), stops[0].color);
    }

    #[test]
    fn shadow_coverage_falls_off_over_the_blur_band() {
        // blur 4: at the edge full, halfway smooth, at the band end zero.
        assert!((shadow_coverage(0.0, 4.0, 1.0) - 1.0).abs() < EPS);
        assert!((shadow_coverage(2.0, 4.0, 1.0) - 0.5).abs() < 1e-4);
        assert!(shadow_coverage(4.0, 4.0, 1.0).abs() < EPS);
        assert!(shadow_coverage(6.0, 4.0, 1.0).abs() < EPS);
        // blur 0 degrades to the crisp AA edge rule.
        assert!((shadow_coverage(-0.2, 0.0, 1.0) - 0.7).abs() < 1e-4);
        assert!(shadow_coverage(0.6, 0.0, 1.0).abs() < EPS);
    }

    #[test]
    fn quad_fragment_composites_shadow_fill_stroke_in_order() {
        let mut entry = Deep2dPaintData {
            kind: DEEP2D_PAINT_KIND_QUAD,
            aa_scale: 1.0,
            opacity: 1.0,
            radius: 0.0,
            p0: [0.0, 0.0],
            p1: [10.0, 10.0],
            color: [1.0, 0.0, 0.0, 1.0],
            stroke_color: [0.0, 0.0, 0.0, 0.0],
            shadow_offset: [0.0, 0.0],
            shadow_blur: 0.0,
            shadow_spread: 0.0,
            shadow_radius: 0.0,
            shadow_color: [0.0, 0.0, 0.0, 0.0],
            ..Default::default()
        };
        // Interior: opaque fill wins.
        assert_close(quad_fragment(&entry, &[], [5.0, 5.0]), [1.0, 0.0, 0.0, 1.0]);
        // Far outside: transparent.
        assert_close(quad_fragment(&entry, &[], [50.0, 50.0]), [0.0, 0.0, 0.0, 0.0]);
        // Exactly on the edge: half a pixel of coverage each way.
        assert_close(quad_fragment(&entry, &[], [10.0, 5.0]), [1.0, 0.0, 0.0, 0.5]);
        assert_close(quad_fragment(&entry, &[], [10.5, 5.0]), [0.0, 0.0, 0.0, 0.0]);

        // Shadow behind an opaque fill: interior stays fill, the band outside
        // shows shadow, far outside stays transparent.
        entry.shadow_color = [0.0, 0.0, 1.0, 1.0];
        entry.shadow_offset = [2.0, 0.0];
        assert_close(quad_fragment(&entry, &[], [5.0, 5.0]), [1.0, 0.0, 0.0, 1.0]);
        assert_close(quad_fragment(&entry, &[], [11.0, 5.0]), [0.0, 0.0, 1.0, 1.0]);
        assert_close(quad_fragment(&entry, &[], [25.0, 5.0]), [0.0, 0.0, 0.0, 0.0]);

        // Stroke over fill: a 2-unit band centered on the edge is black on
        // both sides, the interior keeps the fill.
        entry.shadow_color = [0.0; 4];
        entry.stroke_color = [0.0, 0.0, 0.0, 1.0];
        entry.stroke_width = 2.0;
        assert_close(quad_fragment(&entry, &[], [5.0, 5.0]), [1.0, 0.0, 0.0, 1.0]);
        assert_close(quad_fragment(&entry, &[], [9.5, 5.0]), [0.0, 0.0, 0.0, 1.0]);
        assert_close(quad_fragment(&entry, &[], [10.0, 5.0]), [0.0, 0.0, 0.0, 1.0]);
        assert_close(quad_fragment(&entry, &[], [11.5, 5.0]), [0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn pod_layout_is_stable() {
        assert_eq!(std::mem::size_of::<Deep2dPaintStop>(), 32);
        assert_eq!(std::mem::size_of::<Deep2dPaintData>() % 16, 0);
        // One entry must round-trip through bytes untouched.
        let entry = Deep2dPaintData {
            kind: DEEP2D_PAINT_KIND_RADIAL,
            stop_count: 2,
            stops: {
                let mut stops = [DEEP2D_ZERO_STOP; DEEP2D_MAX_GRADIENT_STOPS];
                stops[0] = Deep2dPaintStop::new(0.0, [1.0, 0.0, 0.0, 1.0]);
                stops[1] = Deep2dPaintStop::new(1.0, [0.0, 0.0, 1.0, 1.0]);
                stops
            },
            ..Default::default()
        };
        let bytes = bytemuck::bytes_of(&entry);
        assert_eq!(bytes.len(), std::mem::size_of::<Deep2dPaintData>());
        let back: Deep2dPaintData = *bytemuck::from_bytes(bytes);
        assert_eq!(back, entry);
    }

    #[test]
    fn blend_composite_matches_the_fixed_function_state() {
        let dst = [0.6f32, 0.4, 0.2, 1.0];
        // Opaque source: multiply = s*d per channel.
        let opaque = [1.0f32, 0.5, 0.0, 1.0];
        let out = blend_composite(DEEP2D_BLEND_MULTIPLY, opaque, dst);
        for channel in 0..3 {
            assert!((out[channel] - opaque[channel] * dst[channel]).abs() < 1e-6);
        }
        // CSS multiply on an opaque backdrop also preserves the backdrop
        // where the source is white (s = 1 keeps d).
        let white = [1.0f32, 1.0, 1.0, 1.0];
        let out = blend_composite(DEEP2D_BLEND_MULTIPLY, white, dst);
        for channel in 0..3 {
            assert!((out[channel] - dst[channel]).abs() < 1e-6);
        }
        // Premultiplied screen: s' + d*(1 - s') sends white sources to white.
        let out = blend_composite(DEEP2D_BLEND_SCREEN, white, dst);
        for channel in 0..3 {
            assert!((out[channel] - 1.0).abs() < 1e-6);
        }
        let dark = [0.2f32, 0.2, 0.2, 1.0];
        let out = blend_composite(DEEP2D_BLEND_SCREEN, dark, dst);
        for channel in 0..3 {
            let expected = dark[channel] + dst[channel] * (1.0 - dark[channel]);
            assert!((out[channel] - expected).abs() < 1e-6);
        }
        // darken/lighten are the exact per-channel min/max on opaque dst.
        let src = [0.9f32, 0.1, 0.5, 1.0];
        let out = blend_composite(DEEP2D_BLEND_DARKEN, src, dst);
        for channel in 0..3 {
            assert_eq!(out[channel], src[channel].min(dst[channel]));
        }
        let out = blend_composite(DEEP2D_BLEND_LIGHTEN, src, dst);
        for channel in 0..3 {
            assert_eq!(out[channel], src[channel].max(dst[channel]));
        }
        // overwrite replaces rgb+alpha; normal matches the classic over.
        let translucent = [1.0f32, 0.0, 0.0, 0.5];
        let out = blend_composite(DEEP2D_BLEND_OVERWRITE, translucent, dst);
        assert_eq!(out, [1.0, 0.0, 0.0, 0.5]);
        let out = blend_composite(DEEP2D_BLEND_NORMAL, translucent, dst);
        assert!((out[0] - 0.8).abs() < 1e-6);
        assert!((out[1] - 0.2).abs() < 1e-6);
        assert!((out[3] - 1.0).abs() < 1e-6);
        // Semi-transparent multiply: exact on an opaque backdrop
        // (premult s' = s.a*s.rgb drives the CSS formula).
        let out = blend_composite(DEEP2D_BLEND_MULTIPLY, translucent, dst);
        for channel in 0..3 {
            let expected =
                translucent[channel] * translucent[3] * dst[channel] + dst[channel] * (1.0 - translucent[3]);
            assert!((out[channel] - expected).abs() < 1e-6);
        }
    }

    #[test]
    fn blend_premultiplies_only_multiply_and_screen() {
        assert!(!blend_premultiplies(DEEP2D_BLEND_NORMAL));
        assert!(blend_premultiplies(DEEP2D_BLEND_MULTIPLY));
        assert!(blend_premultiplies(DEEP2D_BLEND_SCREEN));
        assert!(!blend_premultiplies(DEEP2D_BLEND_DARKEN));
        assert!(!blend_premultiplies(DEEP2D_BLEND_LIGHTEN));
        assert!(!blend_premultiplies(DEEP2D_BLEND_OVERWRITE));
    }

}
