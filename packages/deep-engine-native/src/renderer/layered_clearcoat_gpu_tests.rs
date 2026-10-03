use super::{SIZE, furnace_frame, render_material_frame, wall_packet};
use deep_engine_native::contract::{RenderPacket, validate_packet};

fn coat_packet(factor: f32, roughness: f32, coverage: f32) -> RenderPacket {
    let mut packet = wall_packet();
    let material = &mut packet.materials[0];
    material.base_color = [0.7, 0.4, 0.2];
    material.roughness = 0.8;
    material.layered = Some(serde_json::from_value(serde_json::json!({"layers":[{
        "coverage":coverage,"mode":"replace","params":{"clearcoat":{"factor":factor,"roughness":roughness}}
    }]})).unwrap());
    validate_packet(&packet).unwrap();
    packet
}

/// f64 closed response for a flat camera-facing wall, normal-aligned light.
/// This does not invoke the production BRDF/clearcoat shader or a copied shader.
fn expected_rgb(x: u32, y: u32, focal: f64) -> [f64; 3] {
    let px = ((f64::from(x) + 0.5) / f64::from(SIZE) * 2.0 - 1.0) / focal;
    let py = ((f64::from(y) + 0.5) / f64::from(SIZE) * 2.0 - 1.0) / focal;
    let nv = 1.0 / (1.0 + px * px + py * py).sqrt();
    let nh = ((1.0 + nv) / 2.0).sqrt(); // nl=1, vh=nh
    let f = 0.04 + 0.96 * (1.0 - nh).powi(5);
    let spec = |roughness: f64| {
        let alpha2 = roughness.powi(4);
        let q = nh * nh * (alpha2 - 1.0) + 1.0;
        let d = alpha2 / (std::f64::consts::PI * q * q).max(1e-6);
        let k = (roughness + 1.0).powi(2) / 8.0;
        let g = nv / (nv * (1.0 - k) + k).max(1e-4);
        f * d * g / (4.0 * nv).max(1e-4)
    };
    let attenuation = 1.0 - 0.75 * f;
    let coat = 0.75 * spec(f64::from(0.35f32));
    [0.7f32, 0.4, 0.2].map(|base| {
        ((1.0 - f) * f64::from(base) / std::f64::consts::PI + spec(f64::from(0.8f32))) * attenuation
            + coat
    })
}

#[test]
#[ignore = "requires >=19 sampled textures and a real GPU; run explicitly"]
fn layered_clearcoat_main_light_matches_closed_response_and_zero_identity() {
    let Some((device, queue)) = super::layered_gpu_tests::request_layered_furnace_device() else {
        println!(
            "layered_clearcoat_executed=false reason=adapter_or_texture_limit scope=not_executed"
        );
        return;
    };
    let (mut frame, view) = furnace_frame();
    let normal = view.basis()[2].map(|value| -value);
    frame[9][3] = 0.0; // isolate direct light from the existing IBL response
    frame[11] = [normal[0], normal[1], normal[2], 0.0];
    frame[13] = [1.0, 1.0, 1.0, 2.0];
    let active = coat_packet(0.75, 0.35, 1.0);
    let mut plain = active.clone();
    plain.materials[0].layered = None;
    let stock = render_material_frame(&device, &queue, &plain, "coat stock", false, frame, view);
    let zero = render_material_frame(
        &device,
        &queue,
        &coat_packet(0.0, 1.0, 1.0),
        "coat factor0",
        true,
        frame,
        view,
    );
    let pruned = render_material_frame(
        &device,
        &queue,
        &coat_packet(0.75, 0.35, 0.0),
        "coat coverage0",
        true,
        frame,
        view,
    );
    let pixels = render_material_frame(&device, &queue, &active, "coat active", true, frame, view);
    println!("legacy_coat_stock_hdr_sha256={} legacy_coat_active_hdr_sha256={}",
      super::metal_reflection_gpu_tests::hash(&stock), super::metal_reflection_gpu_tests::hash(&pixels));
    assert_eq!(stock, zero, "factor0 must preserve stock pixels");
    assert_eq!(stock, pruned, "coverage0 must preserve ordinary pixels");
    let mut auxiliary = plain.clone();
    auxiliary.materials[0].emissive_factor = Some([0.13, 0.07, 0.02]);
    let mut auxiliary_coat = active.clone();
    auxiliary_coat.materials[0].emissive_factor = auxiliary.materials[0].emissive_factor;
    let mut auxiliary_frame = frame;
    auxiliary_frame[9][3] = 1.0;
    auxiliary_frame[13] = [0.0, 0.0, 0.0, 2.0];
    auxiliary_frame[deep_engine_native::mesh_abi::FRAME_FOG_PROJECTION_ROW][3] = 2.0;
    let auxiliary_stock = render_material_frame(
        &device,
        &queue,
        &auxiliary,
        "coat auxiliary stock",
        false,
        auxiliary_frame,
        view,
    );
    let auxiliary_active = render_material_frame(
        &device,
        &queue,
        &auxiliary_coat,
        "coat auxiliary active",
        true,
        auxiliary_frame,
        view,
    );
    assert_eq!(
        auxiliary_stock, auxiliary_active,
        "clearcoat preserves IBL/GI/emission when main light is zero"
    );
    let mut max_error = 0.0f64;
    let mut delta = 0.0f32;
    let mut changed = 0usize;
    for (index, (actual, previous)) in pixels.iter().zip(&stock).enumerate() {
        let expected = expected_rgb(
            index as u32 % SIZE,
            index as u32 / SIZE,
            f64::from(view.focal),
        );
        let mut different = false;
        for channel in 0..3 {
            assert!(actual[channel].is_finite());
            max_error = max_error.max((f64::from(actual[channel]) - expected[channel]).abs());
            delta = delta.max((actual[channel] - previous[channel]).abs());
            different |= (actual[channel] - previous[channel]).abs() > 0.01;
        }
        changed += usize::from(different);
    }
    assert!(
        max_error <= 0.002,
        "clearcoat direct closed error {max_error}"
    );
    assert!(
        delta > 0.02 && changed > 500,
        "clearcoat must alter real HDR pixels delta={delta} changed={changed}"
    );
    println!(
        "layered_clearcoat_executed=true pixels={} max_closed_error={max_error} delta={delta} changed={changed} factor0_identity=true coverage0_identity=true auxiliary_identity=true",
        pixels.len()
    );
}
