//! I-C23 production RT layered PSOs, material binding, readiness and HDR parity.
//! Existing directional-shadow parity verifies the ray-query visibility kernel;
//! this fixture disables shadows to isolate material consumption from CSM bias.

use super::rt_raster_parity_gpu_tests::{decode_hdr, map_readback, parity_packet};
use crate::{
    forward_targets::ForwardTargets,
    frame_bindings::{
        create_frame_layouts, create_native_mesh_rt_shader, create_native_mesh_shader,
    },
    gpu_culling::GpuCulling,
    gpu_ibl::GpuIblEnvironment,
    gpu_resources::{create_shadow_map, frame_data_with_camera},
    gpu_scene::GpuScene,
    gpu_textures::{create_layered_material_layout, create_material_layout},
    mesh_pass::{encode_opaque_pass, encode_opaque_pass_rt},
    pipeline::{create_mesh_pipelines_with_layered, create_rt_mesh_pipelines_with_layered},
    player_shader_plan::scene_content_key,
    renderer::rt_residency::{RtSceneResidency, rt_opaque_ready},
};
use deep_engine_native::{
    contract::validate_packet, culling_contract::prepare_gpu_culling, fog::FogSettings,
    ibl::disabled_probe_environment, ies_shading::NativeIesShadingResource,
    pbr_texture::prepare_pbr_resources, player_view::PlayerView, scene::prepare_scene,
};
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;
use winit::dpi::PhysicalSize;

const SIZE: u32 = 256;

#[test]
#[ignore = "requires real ray-query GPU and >= 19 sampled textures; run explicitly"]
fn rt_layered_material_pipeline_matches_raster_and_consumes_layers() {
    run_layered_rt_parity(false);
}

#[test]
#[ignore = "requires real ray-query GPU and >= 19 sampled textures; run explicitly"]
fn rt_layer_clearcoat_pipeline_matches_raster() {
    run_layered_rt_parity(true);
}

fn run_layered_rt_parity(clearcoat: bool) {
    let Some((device, queue)) = super::request_layered_ray_query_device() else {
        println!("rt_layered_executed=false clearcoat={clearcoat} reason=adapter_or_texture_limit scope=not_executed");
        return;
    };
    let errors = Arc::new(Mutex::new(Vec::new()));
    device.on_uncaptured_error(Arc::new({
        let errors = errors.clone();
        move |error| errors.lock().unwrap().push(error.to_string())
    }));
    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut packet = parity_packet();
    for material in &mut packet.materials {
        material.layered = Some(serde_json::from_value(serde_json::json!({ "layers": [
            { "coverage": 0.75, "mode": "overlay", "surface": { "baseColor": [0.1,0.8,0.25], "metallic": 0.0, "roughness": 0.8 } },
            { "coverage": 0.6, "mode": "replace", "surface": { "baseColor": [0.15,0.25,0.9], "metallic": 0.0, "roughness": 0.6 } }
        ] })).unwrap());
        if clearcoat {
            material.layered.as_mut().unwrap().layers[0].params = Some(
                serde_json::from_value(
                    serde_json::json!({"clearcoat":{"factor":0.75,"roughness":0.35}}),
                )
                .unwrap(),
            );
        }
    }
    validate_packet(&packet).unwrap();
    let mut base_packet = packet.clone();
    for material in &mut base_packet.materials {
        material.layered = None;
    }
    let size = PhysicalSize::new(SIZE, SIZE);
    let view = PlayerView {
        yaw: 0.55,
        ..Default::default()
    };
    let mut frame = frame_data_with_camera(size, view, FogSettings::default());
    frame[9][3] = 0.0; // IBL disabled; isolate the authored direct material response.
    frame[13] = [3.2, 3.0, 2.8, 2.0];
    frame[14] = [1.0, 0.0, 0.0, 0.0]; // exposure 1, no CSM/RT shadow differences.
    let layouts = create_frame_layouts(&device);
    let frame_rt = layouts.frame_rt.as_ref().unwrap();
    let material_layout = create_material_layout(&device);
    let layered_layout = create_layered_material_layout(&device);
    let raster_pipelines = create_mesh_pipelines_with_layered(
        &device,
        &layouts.frame,
        &layouts.shadow,
        &material_layout,
        &layered_layout,
        &create_native_mesh_shader(&device),
    );
    let rt_pipelines = create_rt_mesh_pipelines_with_layered(
        &device,
        frame_rt,
        &material_layout,
        &layered_layout,
        &create_native_mesh_rt_shader(&device),
    );
    assert!(rt_pipelines.supports_layered());
    for normal_mapped in [false, true] {
        for (mirrored, double_sided) in [(false, false), (true, false), (false, true)] {
            assert!(
                rt_pipelines
                    .select_layered(mirrored, double_sided, normal_mapped)
                    .is_some()
            );
        }
    }
    let shadows = create_shadow_map(&device, &layouts.shadow, size, &frame, None, view).unwrap();
    let prepared = prepare_scene(&packet).unwrap();
    let pbr = prepare_pbr_resources(&packet).unwrap();
    let scene = GpuScene::new(
        &device,
        &queue,
        &material_layout,
        Some(&layered_layout),
        &packet,
        scene_content_key(&packet),
        &prepared,
        &pbr,
    )
    .unwrap();
    let base_scene = GpuScene::new(
        &device,
        &queue,
        &material_layout,
        None,
        &base_packet,
        scene_content_key(&base_packet),
        &prepare_scene(&base_packet).unwrap(),
        &prepare_pbr_resources(&base_packet).unwrap(),
    )
    .unwrap();
    let mut culling = GpuCulling::new(
        &device,
        &scene.instance_buffer,
        &prepare_gpu_culling(&packet, &prepared).unwrap(),
        &frame,
        &shadows,
        false,
    )
    .unwrap();
    let (mut residency, blas, tlas) = RtSceneResidency::build(&device, &scene).unwrap();
    queue.submit([blas.finish(), tlas.finish()]);
    residency.install_pixel_pipelines(rt_pipelines);
    let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("I-C23 RT layered frame"),
        contents: bytemuck::cast_slice(&frame),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let ies = NativeIesShadingResource::prepare(&[], None).unwrap();
    let ies_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("I-C23 RT layered IES identity"),
        contents: ies.bytes(),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let ibl = GpuIblEnvironment::new(&device, &queue, &disabled_probe_environment()).unwrap();
    let probe = deep_engine_native::probe_gi_storage::disabled_frame_buffer(&device);
    let frame_group = ibl.create_frame_bind_group(
        &device,
        &layouts.frame,
        &frame_buffer,
        Some(&ies_buffer),
        &shadows,
        Some(&probe),
        "I-C23 layered raster frame",
        true,
    );
    let rt_group = ibl.create_rt_frame_bind_group(
        &device,
        frame_rt,
        &frame_buffer,
        Some(&ies_buffer),
        &shadows,
        residency.tlas(),
        Some(&probe),
        "I-C23 layered RT frame",
    );
    let (ready_pipelines, ready_group) =
        rt_opaque_ready(Some(&residency), Some(&rt_group), false, true)
            .expect("layered PSOs must admit the layered scene to the production RT pass");
    assert!(rt_opaque_ready(Some(&residency), Some(&rt_group), true, true).is_none());
    let raster_target = ForwardTargets::new(&device, size, false);
    let rt_target = ForwardTargets::new(&device, size, false);
    let base_target = ForwardTargets::new(&device, size, false);
    let make_readback = || {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("I-C23 RT layered HDR readback"),
            size: u64::from(SIZE * SIZE) * 8,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        })
    };
    let buffers = [make_readback(), make_readback(), make_readback()];
    let mut encoder = device.create_command_encoder(&Default::default());
    culling.encode(&queue, &mut encoder);
    encode_opaque_pass(
        &mut encoder,
        &raster_target,
        &frame_group,
        &scene,
        &culling,
        None,
        &raster_pipelines,
        false,
    );
    encode_opaque_pass_rt(
        &mut encoder,
        &rt_target,
        ready_group,
        &scene,
        &culling,
        None,
        ready_pipelines,
        false,
    );
    // Base instance words, batch order and geometry are unchanged; the same
    // compacted instance stream is valid for this independent ordinary frame.
    encode_opaque_pass(
        &mut encoder,
        &base_target,
        &frame_group,
        &base_scene,
        &culling,
        None,
        &raster_pipelines,
        false,
    );
    for (target, buffer) in [&raster_target, &rt_target, &base_target]
        .into_iter()
        .zip(&buffers)
    {
        encoder.copy_texture_to_buffer(
            target.resolved_texture().as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(SIZE * 8),
                    rows_per_image: Some(SIZE),
                },
            },
            target.resolved_texture().size(),
        );
    }
    queue.submit([encoder.finish()]);
    culling.commit_submission();
    let [raster, rt, base] = buffers
        .each_ref()
        .map(|buffer| decode_hdr(&map_readback(&device, buffer)));
    let mut max_delta = 0.0f32;
    let mut layer_delta = 0.0f32;
    let mut changed_pixels = 0usize;
    for ((raster, rt), base) in raster.iter().zip(&rt).zip(&base) {
        let mut changed = false;
        for channel in 0..3 {
            assert!(rt[channel].is_finite() && raster[channel].is_finite());
            max_delta = max_delta.max((rt[channel] - raster[channel]).abs());
            let delta = (rt[channel] - base[channel]).abs();
            layer_delta = layer_delta.max(delta);
            changed |= delta > 0.01;
        }
        changed_pixels += usize::from(changed);
    }
    assert!(
        max_delta <= 0.002,
        "layered RT/raster HDR max delta {max_delta}"
    );
    assert!(
        layer_delta > 0.05 && changed_pixels > 500,
        "layers must change actual material pixels: delta={layer_delta} count={changed_pixels}"
    );
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    assert!(pollster::block_on(validation.pop()).is_none());
    assert!(
        errors.lock().unwrap().is_empty(),
        "uncaptured GPU errors: {:?}",
        errors.lock().unwrap()
    );
    println!(
        "rt_layered_executed=true layered_pipeline_variants=6 pixels={} max_hdr_delta={max_delta} layer_delta={layer_delta} changed_pixels={changed_pixels} clearcoat={clearcoat}",
        rt.len()
    );
}
