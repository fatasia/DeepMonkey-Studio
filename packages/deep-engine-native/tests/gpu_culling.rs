use deep_engine_native::{
    contract::{default_alpha_fixture_path, load_and_validate},
    culling_contract::{
        GPU_CULLING_INDIRECT_BYTES, GPU_CULLING_INSTANCE_BYTES, MAIN_SOLID_MASK,
        SHADOW_CASTER_MASK, frustum_planes, prepare_gpu_culling, sphere_visible,
    },
    scene::{PackedInstance, prepare_scene},
};

fn identity_instance() -> PackedInstance {
    let mut instance = [0.0; 36];
    instance[0] = 1.0;
    instance[5] = 1.0;
    instance[10] = 1.0;
    instance
}

#[test]
fn prepares_local_spheres_batch_metadata_and_20_byte_indirect_templates() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/render_packet_shadow_v1.json");
    let (packet, _) = load_and_validate(&path).unwrap();
    let scene = prepare_scene(&packet).unwrap();
    let culling = prepare_gpu_culling(&packet, &scene).unwrap();
    assert_eq!(GPU_CULLING_INSTANCE_BYTES, 144);
    assert_eq!(GPU_CULLING_INDIRECT_BYTES, 20);
    assert_eq!(culling.bounds.len(), scene.instances.len());
    assert_eq!(culling.metadata.len(), scene.instances.len());
    assert_eq!(culling.indirect_template.len(), scene.batches.len());
    for (batch_index, batch) in scene.batches.iter().enumerate() {
        assert_eq!(
            culling.indirect_template[batch_index],
            [
                packet.geometries[batch.geometry_index].indices.len() as u32,
                0,
                0,
                0,
                0,
            ]
        );
        for metadata in &culling.metadata
            [batch.instance_start as usize..(batch.instance_start + batch.instance_count) as usize]
        {
            assert_eq!(metadata[0], batch_index as u32);
            assert_eq!(metadata[1], MAIN_SOLID_MASK | SHADOW_CASTER_MASK);
            assert_eq!(metadata[2], batch.instance_start);
        }
    }
}

#[test]
fn blend_instances_stay_on_the_ordered_direct_path() {
    let (packet, _) = load_and_validate(default_alpha_fixture_path()).unwrap();
    let scene = prepare_scene(&packet).unwrap();
    let culling = prepare_gpu_culling(&packet, &scene).unwrap();
    for batch in scene
        .batches
        .iter()
        .filter(|batch| batch.alpha_mode == deep_engine_native::contract::AlphaMode::Blend)
    {
        let range =
            batch.instance_start as usize..(batch.instance_start + batch.instance_count) as usize;
        assert!(
            culling.metadata[range]
                .iter()
                .all(|metadata| metadata[1] == 0)
        );
    }
}

#[test]
fn normalized_webgpu_frustum_accepts_inside_spheres_and_rejects_outside_ones() {
    let identity = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let planes = frustum_planes(identity).unwrap();
    for plane in &planes {
        let length = (plane[0].powi(2) + plane[1].powi(2) + plane[2].powi(2)).sqrt();
        assert!((length - 1.0).abs() < 1e-6);
    }
    let inside = identity_instance();
    assert!(sphere_visible(&planes, &inside, [0.0, 0.0, 0.5, 0.1]));
    let mut outside = identity_instance();
    outside[3] = 3.0;
    assert!(!sphere_visible(&planes, &outside, [0.0, 0.0, 0.5, 0.1]));
}

#[test]
fn sheared_sphere_keeps_geometry_that_crosses_an_oblique_plane() {
    let n = std::f32::consts::FRAC_1_SQRT_2;
    let planes = [[n, n, 0.0, 0.0]; 6];
    let mut instance = identity_instance();
    instance[1] = 1.0;
    instance[3] = -1.5 * n;
    instance[7] = -1.5 * n;
    // 局部单位球面上的此点仍在平面内；旧 max-column 半径却会误剔除整球。
    let x = 1.0 / 5.0_f32.sqrt();
    let y = 2.0 / 5.0_f32.sqrt();
    let world = [x + y + instance[3], y + instance[7]];
    assert!(world[0] * n + world[1] * n > 0.0);
    assert!(sphere_visible(&planes, &instance, [0.0, 0.0, 0.0, 1.0]));
    instance[3] = -1.7 * n;
    instance[7] = -1.7 * n;
    assert!(!sphere_visible(&planes, &instance, [0.0, 0.0, 0.0, 1.0]));
}

#[test]
fn mirrored_nonuniform_scale_uses_the_extent_along_each_plane() {
    let planes = [[0.0, 1.0, 0.0, 0.0]; 6];
    let mut instance = identity_instance();
    instance[0] = -10.0;
    instance[5] = 0.25;
    instance[7] = -0.5;
    assert!(!sphere_visible(&planes, &instance, [0.0, 0.0, 0.0, 1.0]));
    instance[7] = -0.25;
    assert!(sphere_visible(&planes, &instance, [0.0, 0.0, 0.0, 1.0]));
}

#[test]
fn freezes_gpu_compaction_per_cascade_indirect_and_submit_commit_contracts() {
    let shader = include_str!("../assets/shaders/native_gpu_culling_v1.wgsl");
    let scene = include_str!("../src/gpu_scene_draw.rs");
    let shadow = include_str!("../src/shadow_pass.rs");
    let renderer = include_str!("../src/renderer/frame.rs");
    for marker in [
        "@compute @workgroup_size(64)",
        "atomicAdd(&indirect[item.x].instance_count",
        "visible_instances[item.z + local]",
    ] {
        assert!(
            shader.contains(marker),
            "missing GPU culling contract {marker}"
        );
    }
    assert!(scene.contains("draw_indexed_indirect"));
    assert!(shadow.contains("let culling_view = cascade_index + 1"));
    assert!(renderer.contains("let culling_updated = self.culling.needs_encode()"));
    assert!(
        renderer.find("self.queue.submit").unwrap()
            < renderer.find("self.culling.commit_submission()").unwrap()
    );
}
