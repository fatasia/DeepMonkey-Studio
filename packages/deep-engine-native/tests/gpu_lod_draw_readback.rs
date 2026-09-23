#![allow(dead_code)]

#[path = "support/author_lod_draw.rs"]
mod author_lod_draw;

#[path = "../src/shadow_dirty.rs"]
mod shadow_dirty;
#[path = "support/surface_flags_draw.rs"]
mod surface_flags_draw;

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
#[path = "../src/gpu_occlusion.rs"]
mod gpu_occlusion;
#[path = "../src/gpu_occlusion_consume.rs"]
mod gpu_occlusion_consume;
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
#[path = "support/lod_draw_renderer.rs"]
mod lod_draw_renderer;
#[path = "../src/mesh_pass.rs"]
mod mesh_pass;
#[path = "../src/pipeline.rs"]
mod pipeline;
#[path = "../src/player_content.rs"]
mod player_content;
#[path = "../src/player_shader_plan.rs"]
mod player_shader_plan;
// player_shader_plan.rs 引用 bin 侧 player_picking（#[path] 重组装的 bin 模块族）。
#[path = "../src/player_picking.rs"]
mod player_picking;
#[path = "../src/render_graph.rs"]
mod render_graph;
#[path = "../src/runtime_lkg.rs"]
mod runtime_lkg;
#[path = "../src/shadow_map.rs"]
mod shadow_map;
#[path = "../src/shadow_pass.rs"]
mod shadow_pass;
#[path = "../src/telemetry.rs"]
mod telemetry;
#[path = "../src/telemetry_gpu.rs"]
mod telemetry_gpu;
// —— player_picking bin 模块族传递闭包（V5 预检同族修复：#[path] 重组装的 bin 侧
// 模块在测试 crate 根必须齐备，缺失见各模块文件内注释的依赖来源）——
#[path = "../src/player_state.rs"]
mod player_state; // player_state.rs 被 player_picking/publication_verification 等引用
#[path = "../src/player_measurement.rs"]
mod player_measurement; // player_measurement.rs 被 player_picking/publication_verification 等引用
#[path = "../src/player_annotations.rs"]
mod player_annotations;
// player_state 字段引用的验证记录数据（依赖倒置后无服务层依赖）。
#[path = "../src/publication_record.rs"]
mod publication_record; // runtime_package_startup.rs 被 player_picking/publication_verification 等引用
#[path = "../src/deep2d_gpu.rs"]
mod deep2d_gpu; // deep2d_gpu.rs 被 player_picking/publication_verification 等引用
#[path = "../src/deep2d_atlas_gpu.rs"]
mod deep2d_atlas_gpu; // deep2d_atlas_gpu.rs 被 player_picking/publication_verification 等引用
#[path = "../src/deep2d_gpu_cache.rs"]
mod deep2d_gpu_cache; // deep2d_gpu_cache.rs 被 player_picking/publication_verification 等引用
#[path = "../src/deep2d_scissor.rs"]
mod deep2d_scissor; // deep2d_scissor.rs 被 player_picking/publication_verification 等引用
#[path = "../src/dashboard_video_gpu.rs"]
mod dashboard_video_gpu; // dashboard_video_gpu.rs 被 player_picking/publication_verification 等引用


use deep_engine_native::runtime_package::parse_and_validate_runtime_package;
use lod_draw_renderer::render;
use std::sync::{Arc, Mutex};

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn production_lod_indirect_draw_matches_low_geometry_color_and_cascade_depth() {
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
        println!("LOD production draw adapter: {:?}", adapter.get_info());
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        let errors = Arc::new(Mutex::new(Vec::new()));
        let uncaptured = Arc::clone(&errors);
        device.on_uncaptured_error(Arc::new(move |error| {
            uncaptured.lock().unwrap().push(error.to_string())
        }));
        let loaded = parse_and_validate_runtime_package(include_bytes!(
            "fixtures/runtime-package-lod-v1.json"
        ))
        .unwrap();
        let mut packet = loaded.render_packet;
        let authored = render(&device, &queue, &packet, &loaded.environment).await;
        let prepared = deep_engine_native::scene::prepare_scene(&packet).unwrap();
        let lod_plan =
            deep_engine_native::lod_contract::prepare_gpu_lod(&packet, &prepared).unwrap();
        let per_view: Vec<_> = authored
            .commands
            .iter()
            .map(|commands| {
                commands
                    .iter()
                    .map(|command| command[1])
                    .collect::<Vec<_>>()
            })
            .collect();
        println!("Authored LOD main + CSM counts: {per_view:?}");
        let distinct_cascade = prepared.batches.iter().enumerate().any(|(batch, source)| {
            if source.instance_count != 1 {
                return false;
            }
            let chosen = |view: usize| {
                lod_plan.batches[batch]
                    .iter()
                    .enumerate()
                    .find_map(|(level, draw)| {
                        (authored.commands[view][draw.indirect_index as usize][1] == 1)
                            .then_some(level)
                    })
            };
            let Some(main_level) = chosen(0) else {
                return false;
            };
            (1..5).any(|view| chosen(view).is_some_and(|shadow_level| shadow_level != main_level))
        });
        assert!(
            distinct_cascade,
            "same visible object must choose a different LOD in a production CSM view"
        );
        drop(authored);
        for instance in &mut packet.instances {
            let profile = instance.lod.as_mut().unwrap();
            profile.levels[0].min_projected_diameter_pixels = 0.002;
            profile.levels[1].min_projected_diameter_pixels = 0.001;
        }
        let high = render(&device, &queue, &packet, &loaded.environment).await;
        assert_eq!(
            high.commands[0]
                .iter()
                .map(|command| command[1])
                .sum::<u32>(),
            7
        );
        assert!(
            high.commands
                .iter()
                .flatten()
                .filter(|command| command[1] > 0)
                .all(|command| command[0] == 12)
        );
        for instance in &mut packet.instances {
            instance.lod.as_mut().unwrap().levels[0].min_projected_diameter_pixels = 1e8;
        }
        let fallback = render(&device, &queue, &packet, &loaded.environment).await;
        assert!(fallback.nonzero_vertex_offsets >= 4);
        assert_eq!(fallback.commands.len(), 5);
        for commands in &fallback.commands {
            for (index, command) in commands.iter().enumerate() {
                assert_eq!(command[2..], [0, 0, 0]);
                if index % 3 != 2 {
                    assert_eq!(command[1], 0, "finer geometry survived fallback");
                }
                if command[1] > 0 {
                    assert_eq!(command[0], 3, "must draw actual low triangle indices");
                }
            }
        }
        assert_eq!(
            fallback.commands[0]
                .iter()
                .map(|command| command[1])
                .sum::<u32>(),
            7
        );
        for instance in &mut packet.instances {
            instance.geometry = instance
                .lod
                .take()
                .unwrap()
                .levels
                .last()
                .unwrap()
                .geometry
                .clone();
        }
        let direct_low = render(&device, &queue, &packet, &loaded.environment).await;
        assert_eq!(fallback.hdr.len(), 256 * 256 * 8);
        assert_eq!(fallback.hdr.len(), direct_low.hdr.len());
        assert_eq!(
            fallback.depths.len(),
            4 * fallback.shadow_size as usize * fallback.shadow_size as usize
        );
        assert_eq!(fallback.depths.len(), direct_low.depths.len());
        let color_mismatches = fallback
            .hdr
            .iter()
            .zip(&direct_low.hdr)
            .filter(|(a, b)| a != b)
            .count();
        assert_eq!(
            color_mismatches, 0,
            "GPU-selected low color differs from direct low geometry"
        );
        let depth_mismatches = fallback
            .depths
            .iter()
            .zip(&direct_low.depths)
            .filter(|(a, b)| a != b)
            .count();
        assert_eq!(
            depth_mismatches, 0,
            "GPU-selected CSM low casters differ from direct low geometry"
        );
        let color_changes = high
            .hdr
            .chunks_exact(8)
            .zip(fallback.hdr.chunks_exact(8))
            .filter(|(a, b)| a != b)
            .count();
        assert!(
            color_changes > 100,
            "LOD geometry switch did not change visible color coverage"
        );
        let layer_size = fallback.shadow_size as usize * fallback.shadow_size as usize;
        let depth_changes: Vec<_> = high
            .depths
            .chunks_exact(layer_size)
            .zip(fallback.depths.chunks_exact(layer_size))
            .map(|(a, b)| {
                a.iter()
                    .zip(b)
                    .filter(|(x, y)| (**x - **y).abs() > 1e-7)
                    .count()
            })
            .collect();
        assert_eq!(depth_changes.len(), 4);
        assert!(
            depth_changes.iter().all(|&changes| changes > 100),
            "LOD casters did not change every CSM layer: {depth_changes:?}"
        );
        assert!(fallback.depths.iter().any(|&depth| depth < 1.0));
        assert!(
            errors.lock().unwrap().is_empty(),
            "uncaptured GPU errors: {:?}",
            errors.lock().unwrap()
        );
        println!(
            "LOD production low-draw pixels passed: changed_color={color_changes}, changed_depth_by_cascade={depth_changes:?}, main_instances=7, indirect_first_instance=0, nonzero_vertex_offsets={}",
            fallback.nonzero_vertex_offsets
        );
    });
}
