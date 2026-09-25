#![cfg(windows)]
#![allow(dead_code)]

#[path = "../src/player_content.rs"]
mod player_content;
#[path = "../src/player_shader_plan.rs"]
mod player_shader_plan;
// player_shader_plan.rs 引用 bin 侧 player_picking（#[path] 重组装的 bin 模块族）。
#[path = "../src/player_picking.rs"]
mod player_picking;
// player_picking.rs 依赖 bin 侧 player_state；player_content.rs 依赖 player_measurement。
#[path = "../src/player_measurement.rs"]
mod player_measurement;
#[path = "../src/player_state.rs"]
mod player_state;
#[path = "../src/runtime_lkg.rs"]
mod runtime_lkg;
// —— player_picking bin 模块族传递闭包（V5 预检同族修复：#[path] 重组装的 bin 侧
// 模块在测试 crate 根必须齐备，缺失见各模块文件内注释的依赖来源）——
#[path = "../src/player_annotations.rs"]
mod player_annotations;
// player_state 字段引用的验证记录数据（依赖倒置后无服务层依赖）。
#[path = "../src/dashboard_video_gpu.rs"]
mod dashboard_video_gpu; // dashboard_video_gpu.rs 被 player_picking/publication_verification 等引用
#[path = "../src/deep2d_atlas_gpu.rs"]
mod deep2d_atlas_gpu; // deep2d_atlas_gpu.rs 被 player_picking/publication_verification 等引用
#[path = "../src/deep2d_gpu.rs"]
mod deep2d_gpu; // deep2d_gpu.rs 被 player_picking/publication_verification 等引用
#[path = "../src/deep2d_gpu_cache.rs"]
mod deep2d_gpu_cache; // deep2d_gpu_cache.rs 被 player_picking/publication_verification 等引用
#[path = "../src/deep2d_scissor.rs"]
mod deep2d_scissor; // deep2d_scissor.rs 被 player_picking/publication_verification 等引用
#[path = "../src/gpu_resources.rs"]
mod gpu_resources; // gpu_resources.rs 被 player_picking/publication_verification 等引用
#[path = "../src/publication_record.rs"]
mod publication_record; // runtime_package_startup.rs 被 player_picking/publication_verification 等引用
#[path = "../src/shadow_map/mod.rs"]
mod shadow_map; // shadow_map.rs 被 player_picking/publication_verification 等引用

use deep_engine_native::{
    runtime_package::parse_and_validate_runtime_package,
    shadow_cache::{ShadowCache, ShadowVersion},
};
use player_content::PlayerContent;
use player_shader_plan::{plan_shader_materials, scene_content_key};

fn content() -> PlayerContent {
    PlayerContent::from_package(
        parse_and_validate_runtime_package(include_bytes!(
            "fixtures/runtime-package-shader-v2.json"
        ))
        .unwrap(),
    )
    .unwrap()
}

fn plan(
    value: &PlayerContent,
) -> Result<Vec<Option<player_shader_plan::MaterialShaderPlan>>, String> {
    plan_shader_materials(
        value.packet(),
        &value.shader_packages,
        &value.material_bindings,
    )
}

#[test]
fn mixed_materials_select_texture_normal_mirror_double_and_shadow_capabilities() {
    let value = content();
    let plans = plan(&value).unwrap();
    assert_eq!(plans.iter().flatten().count(), 3);
    for (material, plan) in value.packet().materials.iter().zip(plans) {
        let Some(plan) = plan else { continue };
        let package = &value.shader_packages[plan.package_index];
        for forward in plan.forward.iter().flatten() {
            assert_eq!(
                package
                    .passes
                    .iter()
                    .find(|pass| &pass.id == forward)
                    .unwrap()
                    .pipeline
                    .pass_variant_id,
                "forward-normal"
            );
        }
        match material.id.as_str() {
            "mask" => {
                assert!(plan.forward[1].is_some());
                assert!(plan.shadow[1].is_some());
            }
            "blend.near" => {
                assert!(plan.forward[2].is_some());
                assert!(plan.shadow.iter().all(Option::is_none));
            }
            "shader.opaque" => {
                assert!(plan.forward[0].is_some());
                assert!(plan.shadow[0].is_some());
            }
            id => panic!("unexpected custom material {id}"),
        }
    }
}

#[test]
fn missing_required_pass_never_falls_back_to_builtin_or_incompatible_capability() {
    for (material, kind, variant) in [
        ("mask", "forward", "forward-normal"),
        ("mask", "shadow", "shadow-mask-material"),
        ("shader.opaque", "shadow", "shadow-solid"),
    ] {
        let mut value = content();
        let binding = value
            .material_bindings
            .iter()
            .find(|binding| binding.material_id == material)
            .unwrap();
        let package = value
            .shader_packages
            .iter_mut()
            .find(|package| package.package_id == binding.package_id)
            .unwrap();
        package
            .passes
            .retain(|pass| pass.pipeline.pass_variant_id != variant);
        let error = plan(&value).unwrap_err();
        assert!(
            error.contains(material) && error.contains(kind) && error.contains(variant),
            "{error}"
        );
    }
}

#[test]
fn ambiguous_and_unbound_packages_fail_with_material_diagnostics() {
    let mut value = content();
    let pass = value.shader_packages[0]
        .passes
        .iter()
        .find(|pass| pass.kind == "forward")
        .unwrap();
    let duplicate = serde_json::from_value(serde_json::to_value(pass).unwrap()).unwrap();
    value.shader_packages[0].passes.push(duplicate);
    assert!(plan(&value).unwrap_err().contains("ambiguous"));
    let mut value = content();
    value.material_bindings.remove(0);
    assert!(
        plan(&value)
            .unwrap_err()
            .contains("has no material binding")
    );
    let mut value = content();
    value.material_bindings[0].package_id = "missing-package".into();
    assert!(
        plan(&value)
            .unwrap_err()
            .contains("missing shader package missing-package")
    );
}

#[test]
fn scene_compatibility_key_covers_material_slots_lod_geometry_and_texture_payloads() {
    let original = scene_content_key(content().packet());
    assert_eq!(original, scene_content_key(content().packet()));
    let mut value = content();
    value.mutate_packet_for_test(|packet| packet.materials.swap(0, 1));
    assert_ne!(original, scene_content_key(value.packet()));
    let mut value = content();
    value.mutate_packet_for_test(|packet| {
        packet
            .materials
            .iter_mut()
            .find(|material| material.normal_texture.is_some())
            .unwrap()
            .normal_texture = None;
    });
    assert_ne!(original, scene_content_key(value.packet()));
    let mut value = content();
    value.mutate_packet_for_test(|packet| {
        packet.instances[0].lod.as_mut().unwrap().levels[0].min_projected_diameter_pixels += 1.0;
    });
    assert_ne!(original, scene_content_key(value.packet()));
    let mut value = content();
    value.mutate_packet_for_test(|packet| {
        packet.geometries[0].tangents.as_mut().unwrap()[0] += 0.01
    });
    assert_ne!(original, scene_content_key(value.packet()));
    let mut value = content();
    value.mutate_packet_for_test(|packet| packet.textures[0].data[0] ^= 1);
    assert_ne!(original, scene_content_key(value.packet()));
}

#[test]
#[ignore = "performance evidence; run explicitly with --ignored"]
fn cached_scene_key_removes_the_shader_reload_packet_walk() {
    use std::{hint::black_box, time::Instant};

    let value = content();
    let iterations = 2_000;
    let started = Instant::now();
    for _ in 0..iterations {
        black_box(scene_content_key(black_box(value.packet())));
    }
    let walked = started.elapsed();
    let started = Instant::now();
    for _ in 0..iterations {
        black_box(value.scene_content_key());
    }
    let cached = started.elapsed();
    assert_eq!(value.scene_content_key(), scene_content_key(value.packet()));
    assert!(
        cached.as_nanos() * 20 < walked.as_nanos(),
        "cached={cached:?}, packet_walk={walked:?}"
    );
    println!("scene key x{iterations}: cached={cached:?}, packet_walk={walked:?}");
}

#[test]
fn shader_revision_invalidates_cached_casters_without_a_scene_or_light_change() {
    let mut cache = ShadowCache::default();
    let mut version = ShadowVersion::INITIAL;
    cache.commit(version);
    assert!(!cache.needs_render(version));
    version.shader = 1;
    assert!(cache.needs_render(version));
    cache.commit(version);
    assert!(!cache.needs_render(version));
}
