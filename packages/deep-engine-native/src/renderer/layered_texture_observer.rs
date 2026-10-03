//! Test-only prestore observation and hardware store oracle; no lighting substitute.
//!
//! The prestore f32 color is read back by emitting the three IEEE word chunks
//! (bits 0..10, 11..21, 22..31) as plain integers through the real
//! rgba16float 4x-MSAA store path. Integers up to 2047 are exactly
//! representable in binary16, so the chunks survive storage and resolve
//! (four identical samples average back exactly) and the three frames
//! reassemble the original f32 word; rare cross-sample low-bit differences can
//! only move a mantissa chunk within the binary16 grid, which the guards below
//! bound while exponent/sign chunks stay strictly exact. This is
//! deliberately not a hi/lo half-residual split: the real compiler folds
//! `unpack2x16float(pack2x16float(x))` back to `x` (measured 2026-10-01: the
//! residual frame returned zero for every pixel), so any scheme relying on the
//! half round trip not being folded is structurally invalid. A bitcast cannot
//! be folded, and the per-chunk guards reject any silent corruption.
use super::render_material_frame_with_shader;
#[path = "../shader_package/hash.rs"]
mod observer_hash;
use deep_engine_native::{
    contract::RenderPacket, mesh_abi::FRAME_UNIFORM_FLOATS, player_view::PlayerView,
};

fn observer_source(source: &str, shift: u32) -> String {
    assert!([0, 11, 22].contains(&shift));
    let seam = "vec4f(color, output_alpha)";
    assert_eq!(
        source.matches(seam).count(),
        4,
        "all four actual color return expressions"
    );
    let mask = if shift == 22 { 1023 } else { 2047 };
    let replacement = format!(
        "vec4f(vec3f((bitcast<vec3u>(color) >> vec3u({shift}u)) & vec3u({mask}u)), output_alpha)"
    );
    let patched = source.replace(seam, &replacement);
    assert_eq!(
        patched.replace(&replacement, seam),
        source,
        "original color arithmetic changed"
    );
    patched
}

pub(super) fn unquantized(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    packet: &RenderPacket,
    layered: bool,
    frame: [[f32; 4]; FRAME_UNIFORM_FLOATS / 4],
    view: PlayerView,
) -> Vec<[f32; 3]> {
    let source = deep_engine_native::native_mesh_wgsl::native_mesh_shader_source();
    let mut observations = Vec::new();
    for shift in [0, 11, 22] {
        let code = observer_source(&source, shift);
        println!(
            "layer_texture_observer shift={shift} original_wgsl_sha256={} observed_wgsl_sha256={} original_arithmetic_restored=true",
            observer_hash::sha256(source.as_bytes()),
            observer_hash::sha256(code.as_bytes())
        );
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("I23 exact f32 word chunks"),
            source: wgpu::ShaderSource::Wgsl(code.into()),
        });
        let pixels = render_material_frame_with_shader(
            device,
            queue,
            packet,
            "I23 prestore word chunks",
            layered,
            frame,
            view,
            Some(&shader),
        );
        let limit = if shift == 22 { 1023.0 } else { 2047.0 };
        let mut nonzero = 0usize;
        let mut max = 0.0f32;
        let mut inexact = 0usize;
        let mut examples: Vec<(usize, f32)> = Vec::new();
        for (pixel, rgb) in pixels.iter().enumerate() {
            for value in rgb {
                assert!(
                    value.is_finite() && *value >= 0.0 && *value <= limit,
                    "corrupt bit chunk at {pixel}/{shift}: {value}"
                );
                // The resolve averages the four samples in implementation
                // defined precision, so a chunk whose low sample bits differ
                // can come back averaged on the binary16 grid instead of as an
                // exact integer. Measured: exponent/sign chunks stay 100%
                // integer while only rare mantissa chunks average, so
                // exponent/sign chunks must be exact and mantissa chunks may
                // be any binary16 grid point; anything else is real corruption.
                let on_binary16_grid =
                    deep_engine_native::half_decode::half_to_f32(binary16::f32_to_f16(*value))
                        == *value;
                let exact = if shift == 22 {
                    value.fract() == 0.0
                } else {
                    on_binary16_grid
                };
                if !exact {
                    inexact += 1;
                    if examples.len() < 8 {
                        examples.push((pixel, *value));
                    }
                }
                if *value != 0.0 {
                    nonzero += 1;
                }
                max = max.max(*value);
            }
        }
        assert!(
            inexact == 0,
            "inexact bit chunks at shift {shift}: count={inexact} examples={examples:?}"
        );
        println!(
            "layer_texture_observer_chunk shift={shift} nonzero={nonzero} max={max} hdr_sha256={}",
            super::metal_reflection_gpu_tests::hash(&pixels)
        );
        assert!(nonzero > 0, "actual bit observer not consumed");
        observations.push(pixels);
    }
    (0..observations[0].len())
        .map(|p| {
            std::array::from_fn(|c| {
                let bits = (observations[0][p][c].round() as u32)
                    | ((observations[1][p][c].round() as u32) << 11)
                    | ((observations[2][p][c].round() as u32) << 22);
                f32::from_bits(bits)
            })
        })
        .collect()
}

#[path = "layered_texture_store.rs"]
mod store;
pub(super) fn hardware_store(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    colors: &[[f64; 3]],
) -> Vec<[f32; 3]> {
    store::hardware_store(device, queue, colors)
}

/// Shared with the GPU leaf, which re-quantizes the observed prestore f32
/// color through this same conversion and requires it to reproduce the
/// production pixel within one binary16 ULP — proving actual consumption and
/// complete word reassembly against the real pipeline.
#[path = "../half_float.rs"]
pub(super) mod binary16;

#[cfg(test)]
#[test]
fn layered_texture_observer_keeps_original_arithmetic_and_exact_word_chunks() {
    let source = deep_engine_native::native_mesh_wgsl::native_mesh_shader_source();
    for shift in [0, 11, 22] {
        let generated = observer_source(&source, shift);
        for entry in [
            "fragment_main",
            "fragment_main_layered",
            "fragment_normal_capture",
            "fragment_normal_capture_layered",
        ] {
            let prefix = format!("@fragment fn {entry}(");
            let body = generated
                .split(&prefix)
                .nth(1)
                .expect("actual fragment entry")
                .split("\n}")
                .next()
                .unwrap();
            assert!(
                body.contains("bitcast<vec3u>(color)"),
                "observer missing actual entry {entry}"
            );
            if entry.contains("capture") {
                assert!(
                    body.contains("vec4f(shaded.normal * 0.5 + 0.5, shaded.rough)"),
                    "normal capture changed"
                );
            }
        }
    }
    // Every chunk value must survive the actual rgba16float store path exactly
    // (binary16 holds integers up to 2048), and the three frames must
    // reassemble the original f32 word bit-for-bit.
    for value in [0.0f32, 0.09564209, 26.049, 0.2631836, -0.005, 1e-8] {
        let bits = value.to_bits();
        let mut restored = 0u32;
        for shift in [0, 11, 22] {
            let mask = if shift == 22 { 1023 } else { 2047 };
            let chunk = ((bits >> shift) & mask) as f32;
            let actual = deep_engine_native::half_decode::half_to_f32(binary16::f32_to_f16(chunk));
            assert_eq!(chunk, actual);
            restored |= (actual as u32) << shift;
        }
        assert_eq!(value.to_bits(), restored);
    }
    let store_source = include_str!("layered_texture_store.rs");
    assert!(store_source.contains("textureLoad(reference,vec2i(p.xy),0)"));
    assert!(!store_source.contains("deepLayer") && !store_source.contains("brdf"));
}
