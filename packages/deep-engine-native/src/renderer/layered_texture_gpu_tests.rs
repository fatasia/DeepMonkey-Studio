//! Native original I23 textured-layer production acceptance. GPU belongs to root.
use super::{facing_wall_vertices, furnace_frame, render_material_frame};
use deep_engine_native::pbr_texture::{TextureEncoding, prepare_pbr_resources};
#[path = "layered_texture_fixture.rs"]
mod fixture;
use fixture::{expected, packet, parent};

#[test]
fn layered_texture_fixture_keeps_real_contract_and_encoding() {
    let value = fixture::fixture(facing_wall_vertices());
    // Author JSON round trip before typed material/resource preparation.
    let text = serde_json::to_string(&value).unwrap();
    let value = serde_json::from_str(&text).unwrap();
    let packet = packet(&value);
    let prepared = prepare_pbr_resources(&packet).unwrap();
    let layers = prepared.materials[0].layered.as_ref().unwrap();
    assert_eq!(layers.texture_indices, [Some(0), Some(1), Some(2), Some(3)]);
    assert_eq!(layers.block.len(), 76);
    for (index, texture) in prepared.textures.iter().enumerate() {
        assert_eq!(
            texture.encoding,
            if index % 2 == 0 {
                TextureEncoding::Srgb
            } else {
                TextureEncoding::Linear
            }
        );
    }
    for index in 0..2 {
        let parent = parent(&value, Some(index));
        let p = prepare_pbr_resources(&parent).unwrap();
        assert!(p.materials[0].layered.is_none());
        assert_eq!(p.materials[0].texture_indices[0], Some(index * 2));
        assert_eq!(p.materials[0].texture_indices[1], Some(index * 2 + 1));
    }
    let base = [[0.2, 0.3, 0.4]];
    let parents = [vec![[0.8, 0.1, 0.2]], vec![[0.5, 0.6, 0.7]]];
    let oracle = expected(&base, &parents);
    for c in 0..3 {
        let first = f64::from(base[0][c])
            + (f64::from(parents[0][0][c]) - f64::from(base[0][c])) * fixture::WEIGHTS[0];
        let second = first
            + (f64::from(parents[1][0][c]) - first)
                * fixture::WEIGHTS[1]
                * f64::from(parents[1][0][c]);
        assert!((oracle[0][c] - second).abs() < 1e-15);
    }
}

fn delta(a: &[[f32; 3]], b: &[[f32; 3]]) -> f64 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .flat_map(|(a, b)| a.iter().zip(b).map(|(a, b)| f64::from((a - b).abs())))
        .fold(0.0, f64::max)
}

/// Runtime proof of actual observer consumption and complete word reassembly:
/// the observed prestore f32 color, re-quantized through the same binary16
/// conversion as the render target, must reproduce the plain production pixel
/// within one binary16 ULP. An unconsumed or folded seam, or a missing chunk,
/// is off by whole grid steps; the reconstruction itself is far below half an
/// ULP from the true prestore color, so a legitimate one-ULP mismatch only
/// happens when the resolve's four-sample average sits on a rounding boundary.
fn assert_reconstruction_restores_production_pixels(
    true_color: &[[f32; 3]],
    stored: &[[f32; 3]],
    label: &str,
) {
    assert_eq!(true_color.len(), stored.len(), "{label} pixel count");
    let mut worst = 0.0f32;
    for (pixel, (prestore, rendered)) in true_color.iter().zip(stored).enumerate() {
        for (channel, (prestore, rendered)) in prestore.iter().zip(rendered).enumerate() {
            let requantized = deep_engine_native::half_decode::half_to_f32(
                super::texture_observer::binary16::f32_to_f16(*prestore),
            );
            let ulp = half_ulp(*rendered);
            let difference = (requantized - *rendered).abs();
            worst = worst.max(difference / ulp);
            assert!(
                difference <= ulp,
                "{label} prestore color {prestore} re-stores to {requantized} but production stored {rendered} ({difference} = {} ULP) at pixel {pixel} channel {channel}",
                difference / ulp
            );
        }
    }
    println!("layer_texture_restore_guard {label} worst_half_ulp={worst}");
}

/// Exact binary16 ULP spacing at a positive normal magnitude.
fn half_ulp(value: f32) -> f32 {
    let exponent = ((value.to_bits() >> 23) & 0xFF) as i32 - 127;
    2f32.powi(exponent - 10)
}

#[test]
#[ignore = "requires >=19 sampled textures and a real GPU; run explicitly"]
fn layered_texture_production_matches_independent_parents_and_uv_mr_controls() {
    let (device, queue) = super::layered_gpu_tests::request_layered_furnace_device()
        .expect("layered_texture_executed=false adapter_or_texture_limit");
    let value = fixture::fixture(facing_wall_vertices());
    let (mut frame, view) = furnace_frame();
    let normal = view.basis()[2].map(|v| -v);
    frame[11] = [normal[0], normal[1], normal[2], 0.0];
    frame[13] = [0.8, 0.7, 0.6, 2.0]; // incident radiance, plus the unchanged furnace environment.
    let render = |packet: &deep_engine_native::contract::RenderPacket, layered: bool| {
        render_material_frame(
            &device,
            &queue,
            packet,
            "original I23 layer texture",
            layered,
            frame,
            view,
        )
    };
    let base = render(&parent(&value, None), false);
    let base_raw = super::texture_observer::unquantized(
        &device,
        &queue,
        &parent(&value, None),
        false,
        frame,
        view,
    );
    assert_reconstruction_restores_production_pixels(&base_raw, &base, "base");
    let parents_plain = [
        render(&parent(&value, Some(0)), false),
        render(&parent(&value, Some(1)), false),
    ];
    let parents = [
        super::texture_observer::unquantized(
            &device,
            &queue,
            &parent(&value, Some(0)),
            false,
            frame,
            view,
        ),
        super::texture_observer::unquantized(
            &device,
            &queue,
            &parent(&value, Some(1)),
            false,
            frame,
            view,
        ),
    ];
    assert_reconstruction_restores_production_pixels(&parents[0], &parents_plain[0], "parent0");
    assert_reconstruction_restores_production_pixels(&parents[1], &parents_plain[1], "parent1");
    let raw_oracle = expected(&base_raw, &parents);
    let stored_oracle = super::texture_observer::hardware_store(&device, &queue, &raw_oracle);
    let oracle: Vec<[f64; 3]> = stored_oracle.iter().map(|p| p.map(f64::from)).collect();
    let actual = render(&packet(&value), true);
    let mut max_error = 0.0f64;
    for (actual, expected) in actual.iter().zip(&oracle) {
        for c in 0..3 {
            assert!(actual[c].is_finite() && actual[c] >= 0.0);
            max_error = max_error.max((f64::from(actual[c]) - expected[c]).abs());
        }
    }
    let mut worst: Vec<_> = actual
        .iter()
        .zip(&oracle)
        .enumerate()
        .map(|(pixel, (a, e))| {
            let error = (0..3)
                .map(|c| (f64::from(a[c]) - e[c]).abs())
                .fold(0.0, f64::max);
            (pixel, error)
        })
        .collect();
    worst.sort_by(|a, b| b.1.total_cmp(&a.1));
    let bad = worst.iter().filter(|(_, error)| *error > 0.002).count();
    for (pixel, error) in worst.iter().take(10) {
        println!(
            "layer_texture_worst pixel={} xy=({}, {}) error={} actual={:?} oracle={:?} base={:?} p0={:?} p1={:?}",
            pixel,
            pixel % super::SIZE as usize,
            pixel / super::SIZE as usize,
            error,
            actual[*pixel],
            oracle[*pixel],
            base[*pixel],
            parents[0][*pixel],
            parents[1][*pixel]
        );
    }
    println!("layer_texture_bad_pixels={bad}");
    let actual_raw =
        super::texture_observer::unquantized(&device, &queue, &packet(&value), true, frame, view);
    assert_reconstruction_restores_production_pixels(&actual_raw, &actual, "layered");
    let mut raw_error = 0.0f64;
    for (a, e) in actual_raw.iter().zip(&raw_oracle) {
        for c in 0..3 {
            raw_error = raw_error.max((f64::from(a[c]) - e[c]).abs());
        }
    }
    assert!(
        raw_error <= 0.002,
        "original I23 unquantized response error {raw_error}"
    );
    println!(
        "layer_texture_precision raw_max_error={raw_error} original_hdr16_max_error={max_error} parents_unquantized=true oracle_hardware_store=true observer=exact_f32_word_chunks"
    );
    assert!(
        max_error <= 0.002,
        "original I23 texture parent response error {max_error}"
    );
    let mut controls = Vec::new();
    for control in ["untextured", "wrong-uv", "swapped-mr"] {
        let mut changed = value.clone();
        for layer in changed["materials"][0]["layered"]["layers"]
            .as_array_mut()
            .unwrap()
        {
            let surface = layer["surface"].as_object_mut().unwrap();
            for slot in ["baseColorTexture", "metallicRoughnessTexture"] {
                if control == "untextured" {
                    surface.remove(slot);
                } else if control == "wrong-uv" {
                    let old = surface[slot]["texCoord"].as_u64().unwrap();
                    surface.get_mut(slot).unwrap()["texCoord"] = serde_json::json!(1 - old);
                }
            }
        }
        if control == "swapped-mr" {
            for index in [1, 3] {
                changed["textures"][index]["id"] =
                    serde_json::json!(format!("layer-mr{index}-swapped"));
                changed["materials"][0]["layered"]["layers"][index / 2]["surface"]["metallicRoughnessTexture"]
                    ["texture"] = changed["textures"][index]["id"].clone();
                for pixel in changed["textures"][index]["data"]
                    .as_array_mut()
                    .unwrap()
                    .chunks_exact_mut(4)
                {
                    pixel.swap(1, 2);
                }
            }
        }
        let difference = delta(&actual, &render(&packet(&changed), true));
        assert!(
            difference > 0.001,
            "{control} negative control insensitive: {difference}"
        );
        controls.push((control, difference));
    }
    let mut zero = value.clone();
    for layer in zero["materials"][0]["layered"]["layers"]
        .as_array_mut()
        .unwrap()
    {
        layer["coverage"] = serde_json::json!(0);
    }
    assert_eq!(base, render(&packet(&zero), true));
    let mut alpha0 = value.clone();
    for index in [0, 2] {
        for pixel in alpha0["textures"][index]["data"]
            .as_array_mut()
            .unwrap()
            .chunks_exact_mut(4)
        {
            pixel[3] = serde_json::json!(0);
        }
    }
    assert_eq!(base, render(&packet(&alpha0), true));
    println!(
        "layered_texture_executed=true pixels={} max_parent_error={max_error} controls={controls:?} coverage0_identity=true alpha0_identity=true",
        actual.len()
    );
}
