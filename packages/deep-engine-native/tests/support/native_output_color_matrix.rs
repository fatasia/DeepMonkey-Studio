//! Native output color matrix; reuse the integration target's GPU/readback helpers.
use super::{draw_variant, source_texture_rgba};
use deep_engine_native::author_grading::AuthorGrading;

/// Compare the original CPU equations with all four production output variants.
/// Inputs are exactly representable in Rgba16Float, isolating shader arithmetic.
pub(super) async fn verify_native_output_matrix(device: &wgpu::Device, queue: &wgpu::Queue) {
    let profiles = [
        AuthorGrading::NEUTRAL,
        AuthorGrading::new(30.0, 0.5, -0.25, 0.1, 0.8, -0.4).unwrap(),
        AuthorGrading::new(-45.0, -0.6, 0.2, -0.3, -1.0, 1.0).unwrap(),
        AuthorGrading::new(180.0, 1.0, 1.0, 1.0, 1.0, 1.0).unwrap(),
    ];
    let inputs = [[0.0, 0.0, 0.0], [4.0, 0.125, 0.0625], [16.0, 4.0, 0.25]];
    let mut max_cpu_error = 0.0_f32;
    let mut previous_round = Vec::new();
    for round in 0..2 {
        let mut pixels = Vec::new();
        for input in inputs {
            let source = source_texture_rgba(device, queue, [input[0], input[1], input[2], 0.5]);
            let view = source.create_view(&Default::default());
            for grading in profiles {
                let expected = grading.apply(input).map(legacy_display_channel);
                let baseline =
                    draw_variant(device, queue, &view, Some(grading.pack()), false, false).await;
                for (bloom, fog) in [(false, false), (true, false), (false, true), (true, true)] {
                    let pixel =
                        draw_variant(device, queue, &view, Some(grading.pack()), bloom, fog).await;
                    assert_eq!(
                        pixel, baseline,
                        "disabled bloom/fog variants must agree exactly"
                    );
                    assert_eq!(pixel[3], 0.5, "output must preserve source alpha");
                    for (actual, expected) in pixel[..3].iter().zip(expected) {
                        let error = (actual - expected).abs();
                        max_cpu_error = max_cpu_error.max(error);
                        // Existing Rgba16Float probe tolerance, fixed before extraction.
                        assert!(
                            error < 0.002,
                            "round={round} bloom={bloom} fog={fog} input={input:?} grading={grading:?} pixel={pixel:?} expected={expected:?}"
                        );
                    }
                    pixels.push(pixel);
                }
            }
        }
        if round > 0 {
            assert_eq!(pixels, previous_round, "repeat rounds must be byte-stable");
        }
        previous_round = pixels;
    }
    println!(
        "native output matrix: rounds=2 profiles=4 inputs=3 variants=4 samples=96 max_cpu_error={max_cpu_error} variant_error=0 alpha_error=0"
    );
}

/// Frozen scalar ACES / sRGB equations from the previous Native output shaders.
fn legacy_display_channel(color: f32) -> f32 {
    let linear =
        ((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14)).clamp(0.0, 1.0);
    if linear <= 0.0031308 {
        linear * 12.92
    } else {
        1.055 * linear.powf(1.0 / 2.4) - 0.055
    }
}
