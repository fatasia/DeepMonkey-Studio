//! D09: CPU reference rasterizer and pixel-comparison contract. The
//! reference implements the same logical→physical letterbox mapping as the
//! WGSL shader and rasterizes triangles with a top-left-ish conservative
//! rule, so a GPU readback can be diffed against it with a tolerance that
//! only covers edge antialiasing — interior divergence means the mapping or
//! geometry contract broke. The Browser executor consumes the same fixture
//! JSON, closing the three-way Browser/Native/Reference triangle.

/// Logical→physical mapping, mirrored from native_deep2d_v1.wgsl.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LetterboxMapping {
    pub logical: [f64; 2],
    pub physical: [f64; 2],
    pub scale: f64,
    pub offset: [f64; 2],
}

impl LetterboxMapping {
    pub fn new(logical: [f64; 2], physical: [f64; 2]) -> Self {
        let scale = (physical[0] / logical[0]).min(physical[1] / logical[1]);
        let offset = [
            (physical[0] - logical[0] * scale) * 0.5,
            (physical[1] - logical[1] * scale) * 0.5,
        ];
        Self {
            logical,
            physical,
            scale,
            offset,
        }
    }

    pub fn logical_to_physical(&self, point: [f64; 2]) -> [f64; 2] {
        [
            point[0] * self.scale + self.offset[0],
            point[1] * self.scale + self.offset[1],
        ]
    }

    pub fn physical_to_logical(&self, point: [f64; 2]) -> [f64; 2] {
        [
            (point[0] - self.offset[0]) / self.scale,
            (point[1] - self.offset[1]) / self.scale,
        ]
    }
}

/// One flat triangle in physical pixels with a straight-alpha color.
#[derive(Debug, Clone, Copy)]
pub struct ReferenceTriangle {
    pub vertices: [[f64; 2]; 3],
    pub color: [f32; 4],
}

/// CPU rasterizes triangles into an RGBA8 target (non-premultiplied match of
/// the GPU target format Rgba8Unorm with straight-alpha blending semantics
/// for single-layer draws).
pub fn rasterize(width: u32, height: u32, triangles: &[ReferenceTriangle]) -> Vec<[u8; 4]> {
    let mut pixels = vec![[0u8, 0, 0, 0]; (width * height) as usize];
    for triangle in triangles {
        let xs = [
            triangle.vertices[0][0],
            triangle.vertices[1][0],
            triangle.vertices[2][0],
        ];
        let ys = [
            triangle.vertices[0][1],
            triangle.vertices[1][1],
            triangle.vertices[2][1],
        ];
        let min_x = xs
            .iter()
            .cloned()
            .fold(f64::INFINITY, f64::min)
            .floor()
            .max(0.0) as u32;
        let max_x = xs
            .iter()
            .cloned()
            .fold(f64::NEG_INFINITY, f64::max)
            .ceil()
            .min(f64::from(width - 1)) as u32;
        let min_y = ys
            .iter()
            .cloned()
            .fold(f64::INFINITY, f64::min)
            .floor()
            .max(0.0) as u32;
        let max_y = ys
            .iter()
            .cloned()
            .fold(f64::NEG_INFINITY, f64::max)
            .ceil()
            .min(f64::from(height - 1)) as u32;
        for y in min_y..=max_y {
            for x in min_x..=max_x {
                let center = [f64::from(x) + 0.5, f64::from(y) + 0.5];
                if !point_in_triangle(center, &triangle.vertices) {
                    continue;
                }
                let index = (y * width + x) as usize;
                pixels[index] = blend_over(pixels[index], triangle.color);
            }
        }
    }
    pixels
}

fn point_in_triangle(point: [f64; 2], vertices: &[[f64; 2]; 3]) -> bool {
    let d1 = cross(point, vertices[0], vertices[1]);
    let d2 = cross(point, vertices[1], vertices[2]);
    let d3 = cross(point, vertices[2], vertices[0]);
    let has_negative = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_positive = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_negative && has_positive)
}

fn cross(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

fn blend_over(destination: [u8; 4], source: [f32; 4]) -> [u8; 4] {
    let alpha = source[3];
    let blended = [
        source[0] * alpha + destination[0] as f32 / 255.0 * (1.0 - alpha),
        source[1] * alpha + destination[1] as f32 / 255.0 * (1.0 - alpha),
        source[2] * alpha + destination[2] as f32 / 255.0 * (1.0 - alpha),
        alpha + destination[3] as f32 / 255.0 * (1.0 - alpha),
    ];
    [
        (blended[0] * 255.0).round().clamp(0.0, 255.0) as u8,
        (blended[1] * 255.0).round().clamp(0.0, 255.0) as u8,
        (blended[2] * 255.0).round().clamp(0.0, 255.0) as u8,
        (blended[3] * 255.0).round().clamp(0.0, 255.0) as u8,
    ]
}

/// Comparison report: interior agreement with an edge tolerance band.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PixelComparison {
    pub total_pixels: usize,
    pub exact_matches: usize,
    pub near_matches: usize,
    pub edge_band: usize,
    pub divergent: usize,
}

impl PixelComparison {
    pub fn agreement_ratio(&self) -> f64 {
        if self.total_pixels == 0 {
            return 1.0;
        }
        (self.exact_matches + self.near_matches) as f64 / self.total_pixels as f64
    }

    pub fn interior_agreement_ratio(&self) -> f64 {
        if self.total_pixels - self.edge_band == 0 {
            return 1.0;
        }
        (self.exact_matches + self.near_matches) as f64
            / (self.total_pixels - self.edge_band) as f64
    }
}

/// Diffs reference vs GPU pixels. A pixel counts as `near` when every
/// channel is within `channel_tolerance` (8/255 ≈ blend rounding); pixels
/// adjacent to any color boundary are counted as edge band, since AA makes
/// single-pixel differences there legitimate.
pub fn compare(
    reference: &[[u8; 4]],
    gpu: &[[u8; 4]],
    width: u32,
    height: u32,
    channel_tolerance: u8,
) -> PixelComparison {
    let mut report = PixelComparison {
        total_pixels: reference.len(),
        exact_matches: 0,
        near_matches: 0,
        edge_band: 0,
        divergent: 0,
    };
    let w = width as i64;
    let h = height as i64;
    for (index, (reference_pixel, gpu_pixel)) in reference.iter().zip(gpu.iter()).enumerate() {
        let x = (index as i64) % w;
        let y = (index as i64) / w;
        let near_boundary = (x > 0
            && differs(reference[index - 1], *reference_pixel, channel_tolerance))
            || (x + 1 < w && differs(reference[index + 1], *reference_pixel, channel_tolerance))
            || (y > 0
                && differs(
                    reference[index - w as usize],
                    *reference_pixel,
                    channel_tolerance,
                ))
            || (y + 1 < h
                && differs(
                    reference[index + w as usize],
                    *reference_pixel,
                    channel_tolerance,
                ));
        if near_boundary {
            report.edge_band += 1;
        }
        let channels_equal = reference_pixel
            .iter()
            .zip(gpu_pixel.iter())
            .all(|(a, b)| a.abs_diff(*b) == 0);
        let channels_near = reference_pixel
            .iter()
            .zip(gpu_pixel.iter())
            .all(|(a, b)| a.abs_diff(*b) <= channel_tolerance);
        if channels_equal {
            report.exact_matches += 1;
        } else if channels_near {
            report.near_matches += 1;
        } else if !near_boundary {
            report.divergent += 1;
        }
    }
    report
}

fn differs(a: [u8; 4], b: [u8; 4], tolerance: u8) -> bool {
    a.iter()
        .zip(b.iter())
        .any(|(x, y)| x.abs_diff(*y) > tolerance)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mapping_letterboxes_and_roundtrips() {
        let mapping = LetterboxMapping::new([4.0, 2.0], [8.0, 8.0]);
        assert_eq!(mapping.scale, 2.0, "min ratio binds");
        let top_left = mapping.logical_to_physical([0.0, 0.0]);
        assert_eq!(
            top_left,
            [0.0, 2.0],
            "x fills fully, y centers with 2px bars"
        );
        let back = mapping.physical_to_logical(top_left);
        assert!(back[0].abs() < 1e-9 && back[1].abs() < 1e-9);
    }

    #[test]
    fn rasterizer_and_comparison_agree_on_a_known_square() {
        // A single quad (two triangles) covering logical [1,3]x[1,3] on a
        // 4x4 logical canvas mapped 1:1 to 4x4 physical.
        let mapping = LetterboxMapping::new([4.0, 4.0], [4.0, 4.0]);
        let to_physical = |p: [f64; 2]| mapping.logical_to_physical(p);
        let v = [
            to_physical([1.0, 1.0]),
            to_physical([3.0, 1.0]),
            to_physical([3.0, 3.0]),
            to_physical([1.0, 3.0]),
        ];
        let color = [1.0f32, 0.0, 0.0, 1.0];
        let triangles = vec![
            ReferenceTriangle {
                vertices: [v[0], v[1], v[2]],
                color,
            },
            ReferenceTriangle {
                vertices: [v[0], v[2], v[3]],
                color,
            },
        ];
        let pixels = rasterize(4, 4, &triangles);
        let center = pixels[4 + 2];
        assert_eq!(center, [255, 0, 0, 255], "interior fully covered");
        let corner = pixels[0];
        assert_eq!(corner, [0, 0, 0, 0], "outside untouched");

        let report = compare(&pixels, &pixels, 4, 4, 8);
        assert_eq!(report.exact_matches, 16);
        assert_eq!(report.divergent, 0);
        assert!((report.agreement_ratio() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn comparison_flags_true_interior_divergence() {
        let reference = vec![[255u8, 0, 0, 255]; 16];
        let mut gpu = reference.clone();
        gpu[5] = [0, 255, 0, 255];
        gpu[10] = [0, 0, 255, 255];
        let report = compare(&reference, &gpu, 4, 4, 8);
        assert!(report.divergent >= 1, "interior divergence must count");
    }
}
