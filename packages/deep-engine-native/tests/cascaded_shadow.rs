use deep_engine_native::cascaded_shadow::{
    CASCADED_SHADOW_UNIFORM_BYTES, CascadedShadowCamera, CascadedShadowOptions, CascadedShadowPlan,
    plan_cascaded_shadows, plan_cascaded_shadows_for_scene,
};
use deep_engine_native::scene_bounds::SceneWorldBounds;

fn camera(x: f32) -> CascadedShadowCamera {
    CascadedShadowCamera {
        eye: [x, 2.0, 8.0],
        target: [x, 1.0, 0.0],
        up: [0.0, 1.0, 0.0],
        vertical_fov_radians: std::f32::consts::FRAC_PI_3,
        aspect: 16.0 / 9.0,
        near: 0.1,
        far: 200.0,
    }
}

#[test]
fn plans_two_through_four_monotonic_blended_cascades() {
    for cascade_count in 2..=4 {
        let options = CascadedShadowOptions {
            cascade_count,
            max_shadow_distance: 100.0,
            ..Default::default()
        };
        let plan = plan_cascaded_shadows(camera(0.0), [1.0, -2.0, 1.0], options).unwrap();
        assert_eq!(plan.cascades.len(), cascade_count);
        assert_eq!(plan.cascades.last().unwrap().far, 100.0);
        for (index, cascade) in plan.cascades.iter().enumerate() {
            assert!(cascade.near < cascade.blend_start && cascade.blend_start < cascade.far);
            assert!(
                cascade
                    .view_projection
                    .iter()
                    .flatten()
                    .all(|value| value.is_finite())
            );
            if index > 0 {
                assert!(plan.cascades[index - 1].far <= cascade.near);
            }
        }
    }
}

#[test]
fn packs_a_fixed_336_byte_sampling_abi_with_active_count() {
    assert_eq!(CASCADED_SHADOW_UNIFORM_BYTES, 336);
    let plan = plan_cascaded_shadows(
        camera(0.0),
        [1.0, -2.0, 1.0],
        CascadedShadowOptions {
            cascade_count: 3,
            ..Default::default()
        },
    )
    .unwrap();
    let uniform = plan.uniform(0.00075).unwrap();
    assert_eq!(uniform[19], [3.0, 0.00075, 1.0 / 2_048.0, 0.0]);
    assert_eq!(uniform[16][3], uniform[16][2]);
    assert!(uniform.iter().flatten().all(|value| value.is_finite()));
}

#[test]
fn texel_snapping_stabilizes_sub_texel_lateral_camera_motion() {
    let first = plan_cascaded_shadows(
        camera(0.0),
        [0.0, -1.0, -1.0],
        CascadedShadowOptions {
            cascade_count: 2,
            ..Default::default()
        },
    )
    .unwrap();
    let movement = first.cascades[0].texel_world_size * 0.2;
    let second = plan_cascaded_shadows(
        camera(movement),
        [0.0, -1.0, -1.0],
        CascadedShadowOptions {
            cascade_count: 2,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        first.cascades[0].view_projection,
        second.cascades[0].view_projection
    );
}

#[test]
fn scene_bounds_trim_receiver_distance_and_cover_caster_depth() {
    let flat = SceneWorldBounds {
        minimum: [-1.0, -1.0, -1.0],
        maximum: [1.0, 1.0, 1.0],
    };
    let tall = SceneWorldBounds {
        minimum: [-1.0, -20.0, -1.0],
        maximum: [1.0, 20.0, 1.0],
    };
    let legacy = plan_cascaded_shadows(camera(0.0), [0.0, -1.0, -1.0], Default::default()).unwrap();
    let flat_plan = plan_cascaded_shadows_for_scene(
        camera(0.0),
        [0.0, -1.0, -1.0],
        Default::default(),
        Some(flat),
    )
    .unwrap();
    let tall_plan = plan_cascaded_shadows_for_scene(
        camera(0.0),
        [0.0, -1.0, -1.0],
        Default::default(),
        Some(tall),
    )
    .unwrap();
    assert!(flat_plan.cascades.last().unwrap().far < legacy.cascades.last().unwrap().far);
    assert!(tall_plan.cascades[0].light_far > flat_plan.cascades[0].light_far + 20.0);
    assert!(tall_plan.cascades.iter().all(|cascade| {
        cascade.light_far.is_finite()
            && cascade.light_far > 0.0
            && cascade
                .view_projection
                .iter()
                .flatten()
                .all(|v| v.is_finite())
    }));
}

#[test]
fn scene_fitted_plan_keeps_texel_snapping_stable() {
    let bounds = SceneWorldBounds {
        minimum: [-1.0; 3],
        maximum: [1.0; 3],
    };
    let first = plan_cascaded_shadows_for_scene(
        camera(0.0),
        [0.0, -1.0, -1.0],
        Default::default(),
        Some(bounds),
    )
    .unwrap();
    let movement = first.cascades[0].texel_world_size * 0.2;
    let second = plan_cascaded_shadows_for_scene(
        camera(movement),
        [0.0, -1.0, -1.0],
        Default::default(),
        Some(bounds),
    )
    .unwrap();
    assert_eq!(
        first.cascades[0].view_projection,
        second.cascades[0].view_projection
    );

    let mut resized = camera(0.0);
    resized.aspect = 1.0;
    let resized = plan_cascaded_shadows_for_scene(
        resized,
        [0.0, -1.0, -1.0],
        Default::default(),
        Some(bounds),
    )
    .unwrap();
    assert_ne!(
        first.cascades[0].view_projection, resized.cascades[0].view_projection,
        "aspect resize must update the scene-fitted shadow view"
    );
}

#[test]
fn scene_fitting_survives_extremes_empty_scenes_and_rejects_out_of_range() {
    let light = [0.0, -1.0, -1.0];
    let finite_cascades = |plan: &CascadedShadowPlan| {
        plan.cascades.iter().all(|slice| {
            slice
                .view_projection
                .iter()
                .flatten()
                .all(|value| value.is_finite())
        })
    };

    // A one-millimetre slab must fit without degenerate depth or non-finite matrices.
    let thin = SceneWorldBounds {
        minimum: [2.0, -1.0, -1.0],
        maximum: [2.001, 1.0, 1.0],
    };
    let thin_plan =
        plan_cascaded_shadows_for_scene(camera(0.0), light, Default::default(), Some(thin))
            .expect("thin slab fits");
    assert!(finite_cascades(&thin_plan));

    // Extreme span inside the native fitting range stays valid and deterministic.
    let huge = SceneWorldBounds {
        minimum: [-40_000.0; 3],
        maximum: [40_000.0; 3],
    };
    let huge_plan =
        plan_cascaded_shadows_for_scene(camera(0.0), light, Default::default(), Some(huge))
            .expect("huge span fits");
    assert!(finite_cascades(&huge_plan));
    let huge_again =
        plan_cascaded_shadows_for_scene(camera(0.0), light, Default::default(), Some(huge))
            .expect("huge span refit");
    assert_eq!(
        huge_plan.cascades[0].view_projection, huge_again.cascades[0].view_projection,
        "a static scene must refit to identical matrices"
    );

    // Empty scenes (no bounds) fall back to the camera-driven default plan.
    let empty_plan = plan_cascaded_shadows_for_scene(camera(0.0), light, Default::default(), None)
        .expect("empty scene fits");
    assert!(finite_cascades(&empty_plan));

    // Bounds beyond the native fitting range fail closed instead of producing
    // degenerate shadow matrices.
    let overflow = SceneWorldBounds {
        minimum: [-60_000.0; 3],
        maximum: [60_000.0; 3],
    };
    assert!(
        plan_cascaded_shadows_for_scene(camera(0.0), light, Default::default(), Some(overflow))
            .is_err(),
        "span beyond the fitting budget must be rejected"
    );
}

#[test]
fn rejects_invalid_counts_camera_and_bias() {
    for cascade_count in [1, 5] {
        assert!(
            plan_cascaded_shadows(
                camera(0.0),
                [0.0, -1.0, 0.0],
                CascadedShadowOptions {
                    cascade_count,
                    ..Default::default()
                }
            )
            .is_err()
        );
    }
    assert!(plan_cascaded_shadows(camera(0.0), [0.0; 3], Default::default()).is_err());
    let plan = plan_cascaded_shadows(camera(0.0), [0.0, -1.0, 0.0], Default::default()).unwrap();
    assert!(plan.uniform(f32::NAN).is_err());
}

#[test]
fn runtime_contract_uses_array_sampling_dynamic_caster_offsets_and_blending() {
    let sampling_shader = include_str!("../assets/shaders/native_cascaded_shadow_v1.wgsl");
    let mesh_shader = include_str!("../assets/shaders/native_mesh_v1.wgsl");
    let frame_bindings = include_str!("../src/frame_bindings.rs");
    let shadow_map = include_str!("../src/shadow_map.rs");
    let shadow_pass = include_str!("../src/shadow_pass.rs");

    for contract in [
        "@group(0) @binding(1) var shadow_map: texture_depth_2d_array",
        "@group(0) @binding(7) var<uniform> cascaded_shadow",
        "textureSampleCompareLevel",
        "smoothstep(blend_start, split, view_depth)",
    ] {
        assert!(
            sampling_shader.contains(contract),
            "missing CSM shader contract {contract}"
        );
    }
    assert!(mesh_shader.contains("shadow_visibility(input.world, normal"));
    assert!(frame_bindings.contains("view_dimension: wgpu::TextureViewDimension::D2Array"));
    assert!(frame_bindings.contains("has_dynamic_offset: true"));
    assert!(
        shadow_map.contains(
            "let layer_count = options.cascade_count as u32 + local_matrices.len() as u32"
        )
    );
    assert!(shadow_map.contains("depth_or_array_layers: layer_count"));
    assert!(shadow_map.contains("if layer_count > device.limits().max_texture_array_layers"));
    assert!(shadow_map.contains("let layer_views = (0..layer_count)"));
    assert!(shadow_map.contains("base_array_layer: layer"));
    // 波次5 重构后,串行参照与并行编码共用单个级联编码体 encode_cascade:
    // 合同升级为「逐级联循环 + 每级联各自 layer_view + 动态 offset +
    // 并行入口按级联升序产出 command buffer」。
    assert!(shadow_pass.contains("for (cascade_index, layer_view)"));
    assert!(shadow_pass.contains("fn encode_cascade("));
    assert!(shadow_pass.contains("layer_view: &wgpu::TextureView"));
    assert!(shadow_pass.contains("shadow_map.dynamic_offset(cascade_index)"));
    assert!(shadow_pass.contains("pub fn encode_shadow_cascades_parallel"));
}
