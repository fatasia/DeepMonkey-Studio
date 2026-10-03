use super::{SIZE, furnace_frame, render_material_frame, wall_packet};
use deep_engine_native::contract::{RenderPacket, validate_packet};
use serde_json::{Value, json};

fn row(metal: bool, coverage: f32, mode: &str) -> Value {
    if metal {
        json!({"responseModel":"microfacet-metal-reflection","coverage":coverage,"mode":mode,
          "params":{"anisotropy":{"strength":0.8,"rotation":0.4}},
          "surface":{"baseColor":[0.9,0.5,0.2],"metallic":1,"roughness":0.6}})
    } else {
        json!({"coverage":coverage,"mode":mode,"params":{"clearcoat":{"factor":0.7,"roughness":0.4}},
          "surface":{"baseColor":[0.8,0.6,0.4],"metallic":0,"roughness":0.7}})
    }
}

fn packet(rows: Vec<Value>) -> RenderPacket {
    let mut packet = wall_packet();
    let material = &mut packet.materials[0];
    material.base_color = [0.35, 0.45, 0.6];
    material.metallic = 0.1;
    material.roughness = 0.8;
    material.double_sided = Some(true);
    material.emissive_factor = Some([0.03, 0.015, 0.007]);
    if !rows.is_empty() {
        material.layered = Some(serde_json::from_value(json!({"layers":rows})).unwrap());
    }
    validate_packet(&packet).unwrap();
    packet
}

#[test]
#[ignore = "requires >=19 sampled textures and a real GPU; run explicitly twice"]
fn layered_coat_metal_combinations_match_complete_parent_response() {
    let Some((device, queue)) = super::layered_gpu_tests::request_layered_furnace_device() else {
        panic!("layered_combination_executed=false reason=adapter_or_texture_limit");
    };
    let (mut frame, view) = furnace_frame();
    let normal = view.basis()[2].map(|v| -v);
    frame[9][3] = 1.0;
    frame[11] = [normal[0], normal[1], normal[2], 0.0];
    frame[13] = [1.0, 1.0, 1.0, 2.0];
    let parents = [
        render_material_frame(
            &device,
            &queue,
            &packet(vec![]),
            "combination stock",
            false,
            frame,
            view,
        ),
        render_material_frame(
            &device,
            &queue,
            &packet(vec![row(false, 1.0, "replace")]),
            "combination coat",
            true,
            frame,
            view,
        ),
        render_material_frame(
            &device,
            &queue,
            &packet(vec![row(true, 1.0, "replace")]),
            "combination metal",
            true,
            frame,
            view,
        ),
    ];
    for (index, parent) in parents.iter().enumerate() {
        assert_eq!(parent.len(), (SIZE * SIZE) as usize);
        assert!(parent.iter().flatten().all(|v| v.is_finite() && *v >= 0.0));
        println!(
            "combination_parent={index} hdr_sha256={}",
            super::metal_reflection_gpu_tests::hash(parent)
        );
    }
    let mut max_error = 0.0f64;
    let mut outputs = Vec::new();
    for reverse in [false, true] {
        for first in ["replace", "overlay"] {
            for second in ["replace", "overlay"] {
                let coverage = if reverse {
                    [0.7f32, 0.6]
                } else {
                    [0.6f32, 0.7]
                };
                let rows = vec![
                    row(reverse, coverage[0], first),
                    row(!reverse, coverage[1], second),
                ];
                let label = format!("combination reverse={reverse} first={first} second={second}");
                let pixels = render_material_frame(
                    &device,
                    &queue,
                    &packet(rows),
                    "combination layer stack",
                    true,
                    frame,
                    view,
                );
                assert_eq!(pixels.len(), parents[0].len());
                let parent_order = if reverse { [0, 2, 1] } else { [0, 1, 2] };
                let mut error = 0.0f64;
                // Each parent is a complete actual production response (main + IBL + emission).
                // This helper has no local-light binding and is not a lobe-isolation experiment.
                for (index, actual) in pixels.iter().enumerate() {
                    for channel in 0..3 {
                        assert!(actual[channel].is_finite() && actual[channel] >= 0.0);
                        let mut expected = f64::from(parents[0][index][channel]);
                        for (layer, mode) in [first, second].iter().enumerate() {
                            let parent =
                                f64::from(parents[parent_order[layer + 1]][index][channel]);
                            let w = f64::from(coverage[layer])
                                * if *mode == "overlay" {
                                    parent.clamp(0.0, 1.0)
                                } else {
                                    1.0
                                };
                            expected = (1.0 - w) * expected + w * parent;
                        }
                        error = error.max((f64::from(actual[channel]) - expected).abs());
                    }
                }
                assert!(
                    error <= 0.002,
                    "complete parent combination {label} error {error}"
                );
                max_error = max_error.max(error);
                println!(
                    "combination_case reverse={reverse} first={first} second={second} pixels={} max_error={error} hdr_sha256={}",
                    pixels.len(),
                    super::metal_reflection_gpu_tests::hash(&pixels)
                );
                outputs.push(pixels);
            }
        }
    }
    let mut min_order_delta = f32::INFINITY;
    for index in [0, 3] {
        let delta = outputs[index]
            .iter()
            .zip(&outputs[index + 4])
            .flat_map(|(a, b)| (0..3).map(move |channel| (a[channel] - b[channel]).abs()))
            .fold(0.0f32, f32::max);
        min_order_delta = min_order_delta.min(delta);
    }
    assert!(
        min_order_delta > 0.001,
        "layer order must alter actual pixels {min_order_delta}"
    );
    let zero = render_material_frame(
        &device,
        &queue,
        &packet(vec![row(false, 0.0, "replace"), row(true, 0.0, "overlay")]),
        "combination zero",
        true,
        frame,
        view,
    );
    assert_eq!(
        zero, parents[0],
        "zero layers preserve the complete ordinary HDR field"
    );
    println!(
        "layered_combination_executed=true frames=12 pixels_per_frame={} max_error={max_error} min_order_delta={min_order_delta} zero_identity=true local_lights=0 main_ibl_emission=true zero_hdr_sha256={}",
        SIZE * SIZE,
        super::metal_reflection_gpu_tests::hash(&zero)
    );
}
