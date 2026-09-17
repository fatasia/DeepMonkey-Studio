#![allow(dead_code)]

#[path = "../src/forward_targets.rs"]
mod forward_targets;
#[path = "../src/frame_bindings.rs"]
mod frame_bindings;
#[path = "../src/gpu_culling.rs"]
mod gpu_culling;
#[path = "../src/gpu_culling_readback.rs"]
mod gpu_culling_readback;
#[path = "../src/gpu_culling_resources.rs"]
mod gpu_culling_resources;
#[path = "../src/gpu_ibl.rs"]
mod gpu_ibl;
#[path = "../src/gpu_lod.rs"]
mod gpu_lod;
#[path = "../src/gpu_lod_resources.rs"]
mod gpu_lod_resources;
#[path = "../src/gpu_lod_views.rs"]
mod gpu_lod_views;
#[path = "../src/gpu_resources.rs"]
mod gpu_resources;
#[path = "../src/gpu_scene.rs"]
mod gpu_scene;
#[path = "../src/gpu_scene_draw.rs"]
mod gpu_scene_draw;
#[path = "../src/gpu_shader_materials.rs"]
mod gpu_shader_materials;
#[path = "../src/gpu_texture_types.rs"]
mod gpu_texture_types;
#[path = "../src/gpu_texture_upload.rs"]
mod gpu_texture_upload;
#[path = "../src/gpu_textures.rs"]
mod gpu_textures;
#[path = "../src/half_float.rs"]
mod half_float;
#[path = "support/lod_draw_readback.rs"]
mod lod_draw_readback;
#[path = "../src/mesh_pass.rs"]
mod mesh_pass;
#[path = "../src/pipeline.rs"]
mod pipeline;
#[path = "../src/player_content.rs"]
mod player_content;
#[path = "../src/player_shader_plan.rs"]
mod player_shader_plan;
#[path = "support/production_transparency_draw.rs"]
mod production_transparency_draw;
#[path = "../src/runtime_lkg.rs"]
mod runtime_lkg;
#[path = "support/shader_material_assertions.rs"]
mod shader_material_assertions;
#[path = "support/shader_material_renderer.rs"]
mod shader_material_renderer;
#[path = "support/shader_material_transactions.rs"]
mod shader_material_transactions;
#[path = "../src/shadow_map.rs"]
mod shadow_map;
#[path = "../src/shadow_pass.rs"]
mod shadow_pass;

use deep_engine_native::runtime_package::parse_and_validate_runtime_package;
use player_content::PlayerContent;
use production_transparency_draw::verify_production_transparency_pixels;
use shader_material_assertions::*;
use shader_material_renderer::{render, render_reported};
use std::sync::{Arc, Mutex};

fn fixture() -> PlayerContent {
    PlayerContent::from_package(
        parse_and_validate_runtime_package(include_bytes!(
            "fixtures/runtime-package-shader-v2.json"
        ))
        .unwrap(),
    )
    .unwrap()
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn production_player_shader_materials_preserve_lod_cascades_and_transparency() {
    pollster::block_on(async {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        println!(
            "ShaderPackage production draw adapter: {:?}",
            adapter.get_info()
        );
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        let errors = Arc::new(Mutex::new(Vec::new()));
        let uncaptured = Arc::clone(&errors);
        device.on_uncaptured_error(Arc::new(move |error| {
            uncaptured.lock().unwrap().push(error.to_string());
        }));
        verify_material_draws(&device, &queue).await;
        let content = fixture();
        let baseline = render(&device, &queue, &content, false).await;
        let (foreign, foreign_queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        let after_failed_updates = shader_material_renderer::render_checked(
            &device,
            &queue,
            &content,
            false,
            Some(&foreign),
        )
        .await;
        assert_eq!(
            color_changes(&baseline, &after_failed_updates),
            0,
            "failed candidate changed the retained frame"
        );
        assert_eq!(depth_changes(&baseline, &after_failed_updates), [0; 4]);
        let rebuilt = render(&foreign, &foreign_queue, &content, false).await;
        assert_eq!(
            color_changes(&baseline, &rebuilt),
            0,
            "device rebuild lost CPU ShaderPackage content"
        );
        assert_eq!(depth_changes(&baseline, &rebuilt), [0; 4]);
        println!(
            "ShaderPackage failed candidates/no-op/device ownership passed; last-good and new-device HDR/4CSM exact"
        );
        assert!(
            errors.lock().unwrap().is_empty(),
            "uncaptured GPU errors: {:?}",
            errors.lock().unwrap()
        );
    });
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_broken_package_is_isolated_and_dependents_fall_back_to_builtin() {
    pollster::block_on(async {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        println!("ShaderPackage isolation adapter: {:?}", adapter.get_info());
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        let errors = Arc::new(Mutex::new(Vec::new()));
        let uncaptured = Arc::clone(&errors);
        device.on_uncaptured_error(Arc::new(move |error| {
            uncaptured.lock().unwrap().push(error.to_string());
        }));

        let mut content = fixture();
        assert_eq!(content.shader_packages.len(), 3);
        let (baseline, healthy) = render_reported(&device, &queue, &content, false, None).await;
        assert!(
            healthy.isolated.is_empty(),
            "healthy fixture must not isolate"
        );
        assert_eq!(healthy.fallback_materials, 0);

        // Break one package after contract validation: only its dependents may
        // fall back to builtin PBR; the remaining packages stay bound.
        let broken_id = content.shader_packages[0].package_id.clone();
        content.shader_packages[0].modules[0].source = "broken wgsl that cannot compile".into();
        let (isolated_render, report) =
            render_reported(&device, &queue, &content, false, None).await;
        assert_eq!(report.isolated, vec![broken_id]);
        assert!(report.fallback_materials >= 1, "dependents must fall back");
        assert!(
            report.custom_materials >= 1,
            "surviving packages must keep their custom materials"
        );
        assert_eq!(
            report.custom_materials + report.fallback_materials,
            healthy.custom_materials + healthy.fallback_materials,
            "material count must be conserved"
        );

        let changed = color_changes(&baseline, &isolated_render);
        assert!(
            changed > 0,
            "builtin fallback must be visible where the isolated package drew"
        );
        assert!(
            errors.lock().unwrap().is_empty(),
            "uncaptured GPU errors: {:?}",
            errors.lock().unwrap()
        );
        println!(
            "ShaderPackage isolation OK: isolated={:?} fallback={} custom={} changed_pixels={changed}",
            report.isolated, report.fallback_materials, report.custom_materials
        );
    });
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn production_transparency_pixels_match_frozen_blend_and_raster_semantics() {
    pollster::block_on(async {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        println!("C03 transparency pixel adapter: {:?}", adapter.get_info());
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        verify_production_transparency_pixels(&device, &queue).await;
    });
}

async fn verify_material_draws(device: &wgpu::Device, queue: &wgpu::Queue) {
    let mut content = fixture();
    assert_eq!(content.shader_packages.len(), 3);
    assert_eq!(content.material_bindings.len(), 3);
    assert_eq!(content.packet().instances.len(), 7);
    force_high(&mut content);
    let mut builtin = fixture();
    builtin.shader_packages.clear();
    builtin.material_bindings.clear();
    force_high(&mut builtin);
    let baseline = render(device, queue, &builtin, false).await;
    let high = render(device, queue, &content, false).await;
    verify_commands(&high, 0, 12);
    let material_changes = color_changes(&high, &baseline);
    assert!(
        material_changes > 100,
        "custom materials silently rendered through builtin pipelines"
    );
    println!("ShaderPackage vs builtin changed pixels: {material_changes}");
    drop(baseline);

    force_low(&mut content);
    let low = render(device, queue, &content, false).await;
    verify_commands(&low, 2, 3);
    let changed_color = color_changes(&high, &low);
    let changed_depth = depth_changes(&high, &low);
    assert!(
        changed_color > 100,
        "custom shader LOD changed counts without changing pixels"
    );
    assert!(
        changed_depth.iter().all(|&count| count > 100),
        "custom shader LOD must change every CSM layer: {changed_depth:?}"
    );
    println!("Custom high vs low: color={changed_color}, CSM={changed_depth:?}");
    drop(high);

    let reused = render(device, queue, &content, true).await;
    let wrong_cascade_changes = depth_changes(&low, &reused);
    assert_eq!(
        wrong_cascade_changes[0], 0,
        "negative control must keep cascade zero unchanged"
    );
    assert!(
        wrong_cascade_changes[1..].iter().all(|&count| count > 100),
        "readback must detect reused first-cascade frames: {wrong_cascade_changes:?}"
    );
    println!("First-cascade reuse negative control: CSM={wrong_cascade_changes:?}");
    drop(reused);

    let near = content
        .packet()
        .instances
        .iter()
        .position(|instance| instance.id == "blend.near")
        .unwrap();
    let far = content
        .packet()
        .instances
        .iter()
        .position(|instance| instance.id == "blend.far")
        .unwrap();
    content.mutate_packet_for_test(|packet| packet.instances.swap(near, far));
    let reordered = render(device, queue, &content, false).await;
    assert_eq!(
        color_changes(&low, &reordered),
        0,
        "custom and builtin BLEND ordering depends on authored input order"
    );
    assert_eq!(depth_changes(&low, &reordered), [0; 4]);
    drop(reordered);
    direct_low(&mut content);
    let direct = render(device, queue, &content, false).await;
    verify_low_matches_direct(&low, &direct);
    println!("Custom LOD low/direct low HDR and four CSM layers exact; BLEND reorder exact");
}
