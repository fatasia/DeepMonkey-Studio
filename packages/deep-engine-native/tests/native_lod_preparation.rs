use deep_engine_native::{
    contract::{AlphaMode, RenderPacket},
    lod_contract::{GPU_LOD_RECORD_BYTES, prepare_gpu_lod},
    runtime_package::parse_and_validate_runtime_package,
    scene::{PreparedScene, prepare_scene, transparent_batch_order},
};

fn golden() -> RenderPacket {
    parse_and_validate_runtime_package(include_bytes!("fixtures/runtime-package-lod-v1.json"))
        .expect("shared LOD package")
        .render_packet
}

fn two_opaque() -> RenderPacket {
    let mut packet = golden();
    packet.instances.truncate(2);
    packet
}

fn batch_for(scene: &PreparedScene, id: &str) -> usize {
    let source = scene
        .instance_ids
        .iter()
        .position(|source| source == id)
        .expect("source id");
    scene
        .batches
        .iter()
        .position(|batch| {
            (batch.instance_start as usize..(batch.instance_start + batch.instance_count) as usize)
                .contains(&source)
        })
        .expect("batch for source")
}

#[test]
fn identical_lod_profiles_share_batches_but_distinct_profiles_do_not() {
    let packet = two_opaque();
    let scene = prepare_scene(&packet).unwrap();
    assert_eq!(scene.batches.len(), 1);
    assert_eq!(scene.batches[0].instance_count, 2);
    let gpu = prepare_gpu_lod(&packet, &scene).unwrap();
    assert_eq!(gpu.objects.len(), 2);
    assert_eq!(gpu.levels.len(), 3);

    for difference in 0..4 {
        let mut packet = two_opaque();
        let profile = packet.instances[1].lod.as_mut().unwrap();
        match difference {
            0 => profile.hysteresis_ratio = Some(0.2),
            1 => profile.levels[0].min_projected_diameter_pixels = 200.0,
            2 => profile.levels[1].geometric_error = 0.25,
            _ => profile.levels[1].resident = Some(true),
        }
        let scene = prepare_scene(&packet).unwrap();
        assert_eq!(scene.batches.len(), 2, "profile difference {difference}");
        assert_ne!(
            batch_for(&scene, "opaque.near"),
            batch_for(&scene, "opaque.fallback")
        );
        let gpu = prepare_gpu_lod(&packet, &scene).unwrap();
        assert_eq!(gpu.objects.len(), 2);
        assert_eq!(gpu.levels.len(), 6);
        assert_ne!(gpu.objects[0][0][1], gpu.objects[1][0][1]);
    }
}

#[test]
fn omitted_and_explicit_lod_defaults_share_the_same_batch() {
    let mut packet = two_opaque();
    packet.instances[0].lod.as_mut().unwrap().hysteresis_ratio = None;
    let explicit = packet.instances[1].lod.as_mut().unwrap();
    explicit.levels[0].resident = Some(true);
    explicit.levels[2].resident = Some(true);
    let scene = prepare_scene(&packet).unwrap();
    assert_eq!(
        scene.batches.len(),
        1,
        "equivalent default settings must share a batch"
    );
    assert_eq!(scene.batches[0].instance_count, 2);
}

#[test]
fn non_lod_instances_never_share_lod_batches_or_output_regions() {
    let mut packet = two_opaque();
    packet.instances[0].lod = None;
    let scene = prepare_scene(&packet).unwrap();
    assert_eq!(scene.batches.len(), 2);
    let plain = batch_for(&scene, "opaque.near");
    let profiled = batch_for(&scene, "opaque.fallback");
    assert!(!scene.batches[plain].lod);
    assert!(scene.batches[profiled].lod);
    let gpu = prepare_gpu_lod(&packet, &scene).unwrap();
    assert!(gpu.batches[plain].is_empty());
    assert_eq!(gpu.batches[profiled].len(), 3);
    assert_eq!(gpu.objects.len(), 1);
    assert_eq!(gpu.objects[0][0][0], scene.batches[profiled].instance_start);
    assert_eq!(gpu.visible_capacity, 3);
}

#[test]
fn blend_objects_with_shared_material_remain_separate_and_sort_back_to_front() {
    let mut packet = golden();
    packet
        .instances
        .retain(|instance| instance.id.starts_with("blend."));
    packet.instances[1].material = packet.instances[0].material.clone();
    let scene = prepare_scene(&packet).unwrap();
    assert_eq!(scene.batches.len(), 2);
    assert!(
        scene
            .batches
            .iter()
            .all(|batch| batch.alpha_mode == AlphaMode::Blend
                && batch.lod
                && batch.instance_count == 1)
    );
    let sorted_ids = |yaw| {
        transparent_batch_order(&scene.batches, yaw)
            .into_iter()
            .map(|index| scene.instance_ids[scene.batches[index].instance_start as usize].as_str())
            .collect::<Vec<_>>()
    };
    assert_eq!(sorted_ids(0.0), ["blend.far", "blend.near"]);
    assert_eq!(
        sorted_ids(std::f32::consts::PI),
        ["blend.near", "blend.far"]
    );
    let gpu = prepare_gpu_lod(&packet, &scene).unwrap();
    assert_eq!(gpu.objects.len(), 2);
    assert!(gpu.objects.iter().all(|object| object[0][3] == 1));
    assert_eq!(gpu.indirect_template.len(), 6);

    packet.instances[1].transform[14] = packet.instances[0].transform[14];
    let tied = prepare_scene(&packet).unwrap();
    assert_eq!(transparent_batch_order(&tied.batches, 0.0), [0, 1]);
}

#[test]
fn mask_mirrors_keep_front_face_and_instance_handedness_for_each_lod() {
    let mut packet = golden();
    packet
        .instances
        .retain(|instance| instance.id == "mask.mirrored");
    let mut regular = packet.instances[0].clone();
    regular.id = "mask.regular".into();
    regular.transform[0] = regular.transform[0].abs();
    packet.instances.push(regular);
    let scene = prepare_scene(&packet).unwrap();
    let mirrored = batch_for(&scene, "mask.mirrored");
    let regular = batch_for(&scene, "mask.regular");
    assert_ne!(mirrored, regular);
    assert!(scene.batches[mirrored].mirrored);
    assert!(!scene.batches[regular].mirrored);
    let gpu = prepare_gpu_lod(&packet, &scene).unwrap();
    for (index, handedness) in [(mirrored, -1.0), (regular, 1.0)] {
        let batch = &scene.batches[index];
        assert_eq!(batch.alpha_mode, AlphaMode::Mask);
        assert!(!batch.double_sided);
        assert_eq!(
            scene.instances[batch.instance_start as usize][30],
            handedness
        );
        assert_eq!(scene.instances[batch.instance_start as usize][31], 2.0);
        assert_eq!(gpu.batches[index].len(), 3);
    }
    assert!(gpu.objects.iter().all(|object| object[0][3] == 3));
}

#[test]
fn prepares_exact_geometry_draws_zero_first_instance_and_disjoint_output_offsets() {
    let packet = golden();
    let scene = prepare_scene(&packet).unwrap();
    let gpu = prepare_gpu_lod(&packet, &scene).unwrap();
    assert_eq!(GPU_LOD_RECORD_BYTES, size_of::<[[u32; 4]; 3]>() as u64);
    assert_eq!(gpu.objects.len(), packet.instances.len());
    assert_eq!(gpu.visible_capacity, 21);
    let (mut next_slot, mut next_draw, mut next_level) = (0, 0, 0);
    for (batch_index, batch) in scene.batches.iter().enumerate() {
        let id = &scene.instance_ids[batch.instance_start as usize];
        let profile = packet
            .instances
            .iter()
            .find(|instance| &instance.id == id)
            .unwrap()
            .lod
            .as_ref()
            .unwrap();
        for (level_index, level) in profile.levels.iter().enumerate() {
            let draw = &gpu.batches[batch_index][level_index];
            assert_eq!(packet.geometries[draw.geometry_index].id, level.geometry);
            assert_eq!(draw.instance_start, next_slot);
            assert_eq!(draw.indirect_index, next_draw);
            assert_eq!(draw.resident, level.is_resident());
            assert_eq!(
                gpu.indirect_template[next_draw as usize],
                [
                    packet.geometries[draw.geometry_index].indices.len() as u32,
                    0,
                    0,
                    0,
                    0,
                ]
            );
            let record = gpu.levels[next_level + level_index];
            assert_eq!(
                record[0],
                [next_draw, next_slot, u32::from(level.is_resident()), 0]
            );
            assert_eq!(
                f32::from_bits(record[2][0]),
                level.min_projected_diameter_pixels as f32
            );
            assert_eq!(f32::from_bits(record[2][1]), level.geometric_error as f32);
            next_slot += batch.instance_count;
            next_draw += 1;
        }
        for source in batch.instance_start..batch.instance_start + batch.instance_count {
            let object = gpu
                .objects
                .iter()
                .find(|object| object[0][0] == source)
                .unwrap();
            assert_eq!(object[0][1], next_level as u32);
            assert_eq!(object[0][2], 3);
            assert_eq!(
                f32::from_bits(object[2][0]),
                profile.hysteresis_ratio() as f32
            );
        }
        next_level += 3;
    }
    assert_eq!(next_slot, gpu.visible_capacity);
    assert_eq!(next_draw as usize, gpu.indirect_template.len());
    assert_eq!(next_level, gpu.levels.len());
    assert_eq!(
        gpu.levels.iter().filter(|record| record[0][2] == 0).count(),
        scene.batches.len()
    );
}

#[test]
fn object_bounds_include_coarser_geometry_even_when_it_is_nonresident() {
    let mut packet = golden();
    packet.instances.truncate(1);
    for vertex in packet.geometries[1].vertices.chunks_exact_mut(6) {
        vertex[0] += 10.0;
    }
    let scene = prepare_scene(&packet).unwrap();
    let gpu = prepare_gpu_lod(&packet, &scene).unwrap();
    let object = gpu.objects[0][1].map(f32::from_bits);
    for geometry in &packet.geometries {
        for &index in &geometry.indices {
            let vertex = &geometry.vertices[index as usize * 6..index as usize * 6 + 3];
            let distance = (0..3)
                .map(|axis| (vertex[axis] - object[axis]).powi(2))
                .sum::<f32>()
                .sqrt();
            assert!(
                distance <= object[3] + 1e-5,
                "object bounds excluded an authored LOD vertex"
            );
        }
    }
    assert!(!gpu.batches[0][1].resident);
    assert_eq!(gpu.batches[0].len(), 3);
}
