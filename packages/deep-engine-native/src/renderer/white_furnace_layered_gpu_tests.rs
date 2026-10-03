//! Layered-only GPU assembly; the parent retains the registered test and shared private fixtures.
use super::{assert_all_checks_pass, facing_wall_vertices, render_furnace_frame, wall_packet};
use deep_engine_native::{
    contract::{RenderPacket, validate_packet},
    pbr_layered::{LAYERED_MATERIAL_REQUIRED_TEXTURES, LayerResponse, blend_layer_stack},
    white_furnace::{
        FURNACE_ENVIRONMENT_RADIANCE, FurnaceRegion, evaluate_furnace_checks, region_stats,
    },
};
use std::sync::{Arc, Mutex};
#[path = "white_furnace_layered_response.rs"]
mod response;
use response::{assert_layered_furnace_pixels, layered_parent_response_oracle};
/// 分层白炉腿设备:在普通白炉设备合同之上追加 I-C23 采样纹理能力门
/// (max_sampled_textures_per_shader_stage ≥ 19,与 gpu_context 同一合同
/// 常量)。适配器不足 19 时返回 None——分层管线在该设备本就 fail-closed,
/// 此腿跳过,而不是请求一个必然被拒的 limits。
pub(super) fn request_layered_furnace_device() -> Option<(wgpu::Device, wgpu::Queue)> {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12 | wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).ok()?;
    if adapter.limits().max_sampled_textures_per_shader_stage < LAYERED_MATERIAL_REQUIRED_TEXTURES {
        return None;
    }
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_limits: wgpu::Limits {
            max_sampled_textures_per_shader_stage: LAYERED_MATERIAL_REQUIRED_TEXTURES,
            ..Default::default()
        },
        ..Default::default()
    }))
    .expect("layered-capable adapter must create a device");
    Some((device, queue))
}

/// 白炉分层墙:几何与墙腿同款(全帧覆盖 Lambert 面);材质 = 白炉基材
/// (`base`)+ 纯色层栈(`layers`:rgb + overlay 标志,metal 0 / rough 1,
/// 无层纹理 → 走 baseRow 纯色路径)。`coverages` 逐层覆盖实际请求的
/// coverage;全零时层被 GPU 剪枝,退回基材身份帧。
fn layered_furnace_wall_packet(base: [f32; 3], layers: &[([f32; 3], f32, bool)]) -> RenderPacket {
    let vertices = facing_wall_vertices();
    let packet: RenderPacket = serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [{
            "id": "furnace-layered-wall", "revision": 1,
            "vertices": vertices, "uv0": vec![0.0f32; 8],
            "indices": [0, 1, 2, 0, 2, 3],
        }],
        "materials": [{
            "id": "furnace-layered-lambert", "baseColor": base,
            "metallic": 0.0, "roughness": 1.0, "alphaMode": "OPAQUE",
            "layered": {
                "layers": layers
                    .iter()
                    .map(|(rgb, coverage, overlay)| serde_json::json!({
                        "coverage": coverage,
                        "mode": if *overlay { "overlay" } else { "replace" },
                        "surface": { "baseColor": rgb, "metallic": 0.0, "roughness": 1.0 },
                    }))
                    .collect::<Vec<_>>(),
            },
        }],
        "instances": [{
            "id": "furnace-layered-wall", "geometry": "furnace-layered-wall",
            "material": "furnace-layered-lambert",
            "transform": [1.0,0.0,0.0,0.0, 0.0,1.0,0.0,0.0, 0.0,0.0,1.0,0.0, 0.0,0.0,0.0,1.0]
        }],
        "textures": []
    }))
    .expect("layered furnace wall packet JSON must deserialize");
    validate_packet(&packet).expect("layered furnace wall packet must pass contract validation");
    packet
}

pub(super) fn white_furnace_layered_stack_matches_cpu_convexity() {
    let Some((device, queue)) = request_layered_furnace_device() else {
        println!(
            "layered white furnace GPU leg skipped: no DX12/Vulkan adapter with \
             >= {LAYERED_MATERIAL_REQUIRED_TEXTURES} sampled-texture stages"
        );
        return;
    };
    let errors = Arc::new(Mutex::new(Vec::new()));
    device.on_uncaptured_error(Arc::new({
        let errors = errors.clone();
        move |error| errors.lock().unwrap().push(error.to_string())
    }));

    // This fixture locks pure response-blend arithmetic. Its RGBs become material
    // albedos below, so furnace.blended itself is not the rendered light oracle.
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../deep-engine/fixtures/i-c23-native-layered-block-v1.json"
    ))
    .expect("layered fixture parses");
    let furnace = &fixture["furnace"];
    let rgb3 = |value: &serde_json::Value| -> [f32; 3] {
        let values: Vec<f64> = value
            .as_array()
            .expect("rgb triple")
            .iter()
            .map(|v| v.as_f64().expect("finite rgb"))
            .collect();
        [values[0] as f32, values[1] as f32, values[2] as f32]
    };
    let base = rgb3(&furnace["base"]);
    let layers: Vec<([f32; 3], f32, bool)> = furnace["layers"]
        .as_array()
        .expect("furnace layers")
        .iter()
        .map(|layer| {
            (
                rgb3(&layer["rgb"]),
                layer["coverage"].as_f64().expect("coverage") as f32,
                layer["overlay"].as_bool().expect("layer mode flag"),
            )
        })
        .collect();
    let blended = rgb3(&furnace["blended"]);
    let blended_cpu = blend_layer_stack(
        base,
        &layers
            .iter()
            .map(|(rgb, coverage, overlay)| {
                (
                    *rgb,
                    LayerResponse {
                        coverage: *coverage,
                        overlay: *overlay,
                    },
                )
            })
            .collect::<Vec<_>>(),
    );
    assert_eq!(
        blended_cpu, blended,
        "fixture blended must match the CPU closed form"
    );
    // Ordinary parents are independent of deep_layer_stack and its 304B binding.
    // Keep identical geometry, view, environment, ior and material flags.
    let mut parent_packet = layered_furnace_wall_packet(base, &[]);
    parent_packet.materials[0].layered = None;
    let base_pixels = render_furnace_frame(
        &device,
        &queue,
        &parent_packet,
        "layered furnace base parent",
        false,
    );
    let mut layer_pixels = Vec::with_capacity(layers.len());
    for (rgb, _, _) in &layers {
        parent_packet.materials[0].base_color = *rgb;
        layer_pixels.push(render_furnace_frame(
            &device,
            &queue,
            &parent_packet,
            "layered furnace layer parent",
            false,
        ));
    }
    // Independently anchor the parent light path to the existing white-wall gate.
    let white_pixels = render_furnace_frame(
        &device,
        &queue,
        &wall_packet(),
        "layered furnace white reference",
        false,
    );
    let white_region = region_stats(
        &white_pixels,
        None,
        FURNACE_ENVIRONMENT_RADIANCE,
        FurnaceRegion::Geometry,
    )
    .expect("full-frame white parent region");
    assert_all_checks_pass(&evaluate_furnace_checks(None, Some(white_region)));
    let (expected, max_parent_response) =
        layered_parent_response_oracle(&base_pixels, &layer_pixels, &layers);

    // ① 全栈分层帧:层 0 overlay(coverage 0.75)先混,层 1 replace(0.5)
    //    作用于其结果;oracle mixes actual lit parent responses per pixel.
    let packet = layered_furnace_wall_packet(base, &layers);
    let pixels = render_furnace_frame(
        &device,
        &queue,
        &packet,
        "layered white furnace frame",
        true,
    );
    assert_layered_furnace_pixels(&pixels, &expected, &max_parent_response, "layered stack");

    // ② Zero coverage must match the ordinary base frame bit for bit, including
    // its dielectric specular response. Albedo*E is not an identity reference.
    let packet_off = layered_furnace_wall_packet(
        base,
        &layers
            .iter()
            .map(|(rgb, _, overlay)| (*rgb, 0.0f32, *overlay))
            .collect::<Vec<_>>(),
    );
    let pixels_off = render_furnace_frame(
        &device,
        &queue,
        &packet_off,
        "layered-off white furnace frame",
        true,
    );
    let base_expected: Vec<[f64; 3]> = base_pixels.iter().map(|rgb| rgb.map(f64::from)).collect();
    assert_layered_furnace_pixels(
        &pixels_off,
        &base_expected,
        &max_parent_response,
        "zero-coverage identity",
    );
    assert_eq!(pixels_off.len(), base_pixels.len());
    for (pixel, base_pixel) in pixels_off.iter().zip(&base_pixels) {
        assert_eq!(
            pixel.map(f32::to_bits),
            base_pixel.map(f32::to_bits),
            "zero-coverage layered frame must preserve ordinary base identity"
        );
    }

    let uncaptured = errors.lock().unwrap().clone();
    assert!(
        uncaptured.is_empty(),
        "uncaptured device errors: {uncaptured:?}"
    );
}
