//! Backdrop blur chain, shared by the WGSL backdrop module and the CPU
//! oracle (`paint_reference`). Every stage uses integer weights and exact
//! tap positions so the only GPU/CPU divergence left is f32 arithmetic
//! rounding plus 8-bit store quantization (<= 0.5/255 per stage; the oracle
//! pairs this with a bounded channel tolerance, see
//! `deep2d_backdrop_gpu_tests`).

/// One blur sweep reaches `+-2` half-res texels = `+-4` physical pixels; a
/// padded capture keeps every tap inside the captured content instead of
/// clamping against the command's own edge. `+1` covers the bilinear margin.
pub const BACKDROP_CAPTURE_PAD_PER_ITERATION_PX: f64 = 4.0;
pub const BACKDROP_CAPTURE_BILINEAR_MARGIN_PX: f64 = 1.0;

/// Padded capture region for one backdrop command, in physical target
/// pixels: `(origin, size)`, clamped to the target and at least 1x1. Shared
/// verbatim by the GPU capture (`deep2d_backdrop_gpu`) and the CPU oracle so
/// both sides blur byte-identical source regions.
pub fn backdrop_capture_region(
    rect: [f32; 4],
    scale: f64,
    offset: [f64; 2],
    physical: [u32; 2],
    iterations: u32,
) -> ([u32; 2], [u32; 2]) {
    let pad = iterations as f64 * BACKDROP_CAPTURE_PAD_PER_ITERATION_PX
        + BACKDROP_CAPTURE_BILINEAR_MARGIN_PX;
    let x0 = f64::from(rect[0]) * scale + offset[0] - pad;
    let y0 = f64::from(rect[1]) * scale + offset[1] - pad;
    let x1 = (f64::from(rect[0]) + f64::from(rect[2])) * scale + offset[0] + pad;
    let y1 = (f64::from(rect[1]) + f64::from(rect[3])) * scale + offset[1] + pad;
    let clamp_axis =
        |value: f64, extent: u32| -> u32 { value.floor().clamp(0.0, f64::from(extent)) as u32 };
    let origin = [clamp_axis(x0, physical[0]), clamp_axis(y0, physical[1])];
    let end = [clamp_axis(x1, physical[0]), clamp_axis(y1, physical[1])];
    let size = [(end[0] - origin[0]).max(1), (end[1] - origin[1]).max(1)];
    (origin, size)
}

/// Half-resolution 2x2 box downsample: `out[x, y]` averages the four source
/// texels at `(2x..2x+1, 2y..2y+1)`. Odd tail texels clamp to the edge.
pub fn backdrop_downsample(
    source: &[[u8; 4]],
    source_size: [u32; 2],
    out: &mut [[u8; 4]],
) -> [u32; 2] {
    let half = [source_size[0].div_ceil(2), source_size[1].div_ceil(2)];
    let at = |x: u32, y: u32| -> [f32; 4] {
        let x = x.min(source_size[0] - 1);
        let y = y.min(source_size[1] - 1);
        let pixel = source[(y * source_size[0] + x) as usize];
        [
            f32::from(pixel[0]),
            f32::from(pixel[1]),
            f32::from(pixel[2]),
            f32::from(pixel[3]),
        ]
    };
    for y in 0..half[1] {
        for x in 0..half[0] {
            let a = at(2 * x, 2 * y);
            let b = at(2 * x + 1, 2 * y);
            let c = at(2 * x, 2 * y + 1);
            let d = at(2 * x + 1, 2 * y + 1);
            let mean = [0.0f32, 1.0, 2.0, 3.0].map(|channel| {
                (a[channel as usize]
                    + b[channel as usize]
                    + c[channel as usize]
                    + d[channel as usize])
                    / 4.0
            });
            out[(y * half[0] + x) as usize] = to_u8_rgba(mean);
        }
    }
    half
}

/// One separable `[1, 4, 6, 4, 1] / 16` binomial sweep. `horizontal` picks
/// the axis; edges clamp to the border texel. In-place ping-pong buffers.
pub fn backdrop_blur_sweep(
    source: &[[u8; 4]],
    size: [u32; 2],
    horizontal: bool,
    out: &mut [[u8; 4]],
) {
    let at = |x: i64, y: i64| -> [f32; 4] {
        let x = x.clamp(0, i64::from(size[0]) - 1) as u32;
        let y = y.clamp(0, i64::from(size[1]) - 1) as u32;
        let pixel = source[(y * size[0] + x) as usize];
        [
            f32::from(pixel[0]),
            f32::from(pixel[1]),
            f32::from(pixel[2]),
            f32::from(pixel[3]),
        ]
    };
    for y in 0..size[1] {
        for x in 0..size[0] {
            let (dx, dy) = if horizontal { (1i64, 0) } else { (0, 1) };
            let (cx, cy) = (i64::from(x), i64::from(y));
            let taps = [
                (1.0f32, at(cx - 2 * dx, cy - 2 * dy)),
                (4.0, at(cx - dx, cy - dy)),
                (6.0, at(cx, cy)),
                (4.0, at(cx + dx, cy + dy)),
                (1.0, at(cx + 2 * dx, cy + 2 * dy)),
            ];
            let mut sum = [0.0f32; 4];
            for (weight, tap) in taps {
                for (channel, value) in sum.iter_mut().enumerate() {
                    *value += weight * tap[channel];
                }
            }
            let pixel = [0.0f32, 1.0, 2.0, 3.0].map(|channel| sum[channel as usize] / 16.0);
            out[(y * size[0] + x) as usize] = to_u8_rgba(pixel);
        }
    }
}

/// Bilinear sample of a texture at a fractional texel coordinate, matching
/// wgpu's linear filtering: `t = coord - 0.5`, weights `floor`/`frac`, both
/// axes clamped to the border texel. `coord` is in texel units of `size`.
pub fn backdrop_sample_bilinear(texture: &[[u8; 4]], size: [u32; 2], coord: [f32; 2]) -> [f32; 4] {
    let clamp_coord = |axis: usize, value: f32| -> f32 {
        value.clamp(0.0, (size[axis].saturating_sub(1)) as f32)
    };
    let t = [
        clamp_coord(0, coord[0] - 0.5),
        clamp_coord(1, coord[1] - 0.5),
    ];
    let i0 = [t[0].floor(), t[1].floor()];
    let frac = [t[0] - i0[0], t[1] - i0[1]];
    let tap = |x: u32, y: u32| -> [f32; 4] {
        let pixel = texture[(y * size[0] + x) as usize];
        [
            f32::from(pixel[0]),
            f32::from(pixel[1]),
            f32::from(pixel[2]),
            f32::from(pixel[3]),
        ]
    };
    let x0 = i0[0] as u32;
    let y0 = i0[1] as u32;
    let x1 = (x0 + 1).min(size[0] - 1);
    let y1 = (y0 + 1).min(size[1] - 1);
    let top = [
        tap(x0, y0)[0] * (1.0 - frac[0]) + tap(x1, y0)[0] * frac[0],
        tap(x0, y0)[1] * (1.0 - frac[0]) + tap(x1, y0)[1] * frac[0],
        tap(x0, y0)[2] * (1.0 - frac[0]) + tap(x1, y0)[2] * frac[0],
        tap(x0, y0)[3] * (1.0 - frac[0]) + tap(x1, y0)[3] * frac[0],
    ];
    let bottom = [
        tap(x0, y1)[0] * (1.0 - frac[0]) + tap(x1, y1)[0] * frac[0],
        tap(x0, y1)[1] * (1.0 - frac[0]) + tap(x1, y1)[1] * frac[0],
        tap(x0, y1)[2] * (1.0 - frac[0]) + tap(x1, y1)[2] * frac[0],
        tap(x0, y1)[3] * (1.0 - frac[0]) + tap(x1, y1)[3] * frac[0],
    ];
    [
        top[0] * (1.0 - frac[1]) + bottom[0] * frac[1],
        top[1] * (1.0 - frac[1]) + bottom[1] * frac[1],
        top[2] * (1.0 - frac[1]) + bottom[2] * frac[1],
        top[3] * (1.0 - frac[1]) + bottom[3] * frac[1],
    ]
}

/// Rounds f32 channels to RGBA8 exactly like an Unorm store (round-half-up,
/// clamped). Mirrored by the GPU's `unpack4x8unorm`/store pairing within the
/// oracle tolerance.
pub fn to_u8_rgba(value: [f32; 4]) -> [u8; 4] {
    [
        (value[0] + 0.5).floor().clamp(0.0, 255.0) as u8,
        (value[1] + 0.5).floor().clamp(0.0, 255.0) as u8,
        (value[2] + 0.5).floor().clamp(0.0, 255.0) as u8,
        (value[3] + 0.5).floor().clamp(0.0, 255.0) as u8,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backdrop_downsample_averages_four_texels() {
        let source = vec![
            [0u8, 0, 0, 255],
            [100, 0, 0, 255],
            [200, 0, 0, 255],
            [255, 0, 0, 255],
        ];
        let mut out = vec![[0u8, 0, 0, 0]; 1];
        let half = backdrop_downsample(&source, [2, 2], &mut out);
        assert_eq!(half, [1, 1]);
        assert_eq!(
            out[0],
            [139, 0, 0, 255],
            "(0+100+200+255)/4 = 138.75 -> 139"
        );
    }

    #[test]
    fn backdrop_blur_sweep_preserves_flat_fields_and_blurs_edges() {
        let size = [8u32, 4];
        let source = vec![[200u8, 100, 50, 255]; (size[0] * size[1]) as usize];
        let mut out = vec![[0u8, 0, 0, 0]; (size[0] * size[1]) as usize];
        backdrop_blur_sweep(&source, size, true, &mut out);
        // Flat field: every output texel keeps the value (weights sum to 1).
        assert!(out.iter().all(|pixel| *pixel == [200, 100, 50, 255]));
        // A single bright column bleeds into its neighbors symmetrically.
        let mut spiked = vec![[0u8, 0, 0, 255]; (size[0] * size[1]) as usize];
        for y in 0..size[1] {
            spiked[(y * size[0] + 4) as usize] = [255, 255, 255, 255];
        }
        backdrop_blur_sweep(&spiked, size, true, &mut out);
        assert_eq!(
            out[(2 * size[0] + 4) as usize][0],
            96,
            "center = 6/16*255 = 95.625, to_u8_rgba rounds half-up"
        );
        assert_eq!(
            out[(2 * size[0] + 3) as usize][0],
            64,
            "left tap = 4/16*255"
        );
        assert_eq!(
            out[(2 * size[0] + 1) as usize][0],
            0,
            "outside the 5-tap reach"
        );
    }

    #[test]
    fn backdrop_sample_bilinear_matches_manual_interpolation() {
        let size = [2u32, 2];
        let texture = vec![
            [0u8, 0, 0, 255],
            [200, 0, 0, 255],
            [100, 0, 0, 255],
            [255, 0, 0, 255],
        ];
        // Texel center (0.5, 0.5) returns the texel exactly.
        let center = backdrop_sample_bilinear(&texture, size, [0.5, 0.5]);
        assert!((center[0] - 0.0).abs() < 1e-4);
        // Midpoint between the four texels is the 2D bilinear mean:
        // (0 + 200 + 100 + 255) / 4 = 138.75.
        let mid = backdrop_sample_bilinear(&texture, size, [1.0, 1.0]);
        assert!((mid[0] - 138.75).abs() < 1e-4, "mid = {}", mid[0]);
        // Clamped sampling beyond the border stays on the border texel.
        let edge = backdrop_sample_bilinear(&texture, size, [10.0, 10.0]);
        assert!((edge[0] - 255.0).abs() < 1e-4);
    }
}
