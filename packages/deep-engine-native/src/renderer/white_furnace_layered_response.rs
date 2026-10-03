//! Independent parent-response oracle and unchanged furnace acceptance bounds.
use deep_engine_native::white_furnace::{FURNACE_ENVIRONMENT_RADIANCE, FURNACE_TOLERANCES};

/// Independent oracle: ordinary parent frames supply lit responses at each pixel.
/// Overlay weights use those responses, not albedo: blend(E*A) != E*blend(A).
/// Parent frames also retain the white dielectric specular contribution.
pub(super) fn layered_parent_response_oracle(
    base_pixels: &[[f32; 3]],
    layer_pixels: &[Vec<[f32; 3]>],
    layers: &[([f32; 3], f32, bool)],
) -> (Vec<[f64; 3]>, Vec<[f64; 3]>) {
    assert_eq!(layer_pixels.len(), layers.len());
    for parent in layer_pixels {
        assert_eq!(parent.len(), base_pixels.len());
    }
    let mut expected = Vec::with_capacity(base_pixels.len());
    let mut upper_bounds = Vec::with_capacity(base_pixels.len());
    for (index, base) in base_pixels.iter().enumerate() {
        let mut result = base.map(f64::from);
        let mut upper = result;
        for (parent, (_, coverage, overlay)) in layer_pixels.iter().zip(layers) {
            for channel in 0..3 {
                let response = f64::from(parent[index][channel]);
                let weight = f64::from(*coverage)
                    * if *overlay {
                        response.clamp(0.0, 1.0)
                    } else {
                        1.0
                    };
                result[channel] = (1.0 - weight) * result[channel] + weight * response;
                upper[channel] = upper[channel].max(response);
            }
        }
        expected.push(result);
        upper_bounds.push(upper);
    }
    (expected, upper_bounds)
}

/// Response-level oracle and per-pixel parent convex hull, with the existing
/// furnace mean/max tolerances unchanged. The absolute E bound stays independent
/// of the parent frames so parent energy drift cannot be absorbed by the oracle.
pub(super) fn assert_layered_furnace_pixels(
    pixels: &[[f32; 3]],
    expected: &[[f64; 3]],
    max_parent_response: &[[f64; 3]],
    label: &str,
) {
    assert!(!pixels.is_empty(), "{label}: readback must not be empty");
    assert_eq!(pixels.len(), expected.len());
    assert_eq!(pixels.len(), max_parent_response.len());
    let mut sums = [0.0f64; 3];
    let mut expected_sums = [0.0f64; 3];
    let mut max_rel = 0.0f64;
    for (pixel, prediction) in pixels.iter().zip(expected) {
        for (channel, value) in pixel.iter().enumerate() {
            let value = f64::from(*value);
            assert!(value.is_finite() && prediction[channel].is_finite());
            assert!(prediction[channel] > 0.0);
            sums[channel] += value;
            expected_sums[channel] += prediction[channel];
            let rel = (value - prediction[channel]) / prediction[channel];
            max_rel = max_rel.max(rel.abs());
        }
    }
    let count = pixels.len() as f64;
    let means: [f64; 3] = sums.map(|sum| sum / count);
    let expected_means: [f64; 3] = expected_sums.map(|sum| sum / count);
    for (channel, mean) in means.iter().enumerate() {
        let rel = (mean - expected_means[channel]) / expected_means[channel];
        assert!(
            rel.abs() <= FURNACE_TOLERANCES.geometry_mean_relative,
            "{label}: channel {channel} mean {mean:.6} vs predicted {:.6} exceeds \
             the furnace mean tolerance ({:.4}%)",
            expected_means[channel],
            100.0 * rel
        );
    }
    assert!(
        max_rel <= FURNACE_TOLERANCES.geometry_max_relative,
        "{label}: per-pixel deviation {:.4} exceeds the furnace max tolerance",
        max_rel
    );
    let energy_bound =
        FURNACE_ENVIRONMENT_RADIANCE * (1.0 + FURNACE_TOLERANCES.geometry_max_relative);
    for (pixel, parent) in pixels.iter().zip(max_parent_response) {
        for (channel, value) in pixel.iter().enumerate() {
            let bound = parent[channel] * (1.0 + FURNACE_TOLERANCES.geometry_max_relative);
            assert!(
                f64::from(*value) <= bound,
                "{label}: channel {channel} value {value} escapes the furnace \
                 convex hull bound {bound}"
            );
            assert!(
                f64::from(*value) <= energy_bound,
                "{label}: channel {channel} value {value} exceeds absolute furnace energy {energy_bound}"
            );
        }
    }
    println!(
        "layered white furnace [{label}]: means=[{:.6}, {:.6}, {:.6}] \
         predicted=[{:.6}, {:.6}, {:.6}] maxRel={:.4}%",
        means[0],
        means[1],
        means[2],
        expected_means[0],
        expected_means[1],
        expected_means[2],
        100.0 * max_rel
    );
}
