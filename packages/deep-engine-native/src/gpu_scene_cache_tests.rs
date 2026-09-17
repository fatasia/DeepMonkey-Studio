use deep_engine_native::{
    mesh_abi::PACKED_INSTANCE_BYTES, pbr_texture::prepare_pbr_resources, scene::prepare_scene,
};

use crate::{
    gpu_scene_cache::GpuSceneCache,
    gpu_scene_cache_test_support::{
        assert_no_uncaptured_errors, capture_uncaptured_errors, clean_scopes,
        high_performance_device, push_scopes, read_instances, stage, textured_packet,
    },
    gpu_textures::create_material_layout,
    player_shader_plan::scene_content_key,
};

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn author_selected_explicit_resident_budget_rejects_without_publication() {
    pollster::block_on(async {
        let (device, queue) = high_performance_device().await;
        let scopes = push_scopes(&device);
        let layout = create_material_layout(&device);
        let packet = deep_engine_native::runtime_package::parse_and_validate_runtime_package(
            include_bytes!("../tests/fixtures/runtime-package-author-lod-v1.json"),
        )
        .unwrap()
        .render_packet;
        let mut cache = GpuSceneCache::new(&device, 13).with_budget(1);
        let candidate = stage(&cache, &device, &queue, &layout, &packet);
        assert!(candidate.new_resident_bytes > 1);
        assert!(
            cache
                .commit(candidate)
                .err()
                .unwrap()
                .contains("resident budget")
        );
        assert_eq!(cache.live_bytes(), 0);
        clean_scopes(scopes, "author budget reject").await;
    });
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_resident_budget_rejects_atomically_and_sweeps_dead_entries() {
    use crate::gpu_scene_cache::default_budget;

    pollster::block_on(async {
        let (device, queue) = high_performance_device().await;
        let uncaptured = capture_uncaptured_errors(&device);
        let layout = create_material_layout(&device);
        let mut cache = GpuSceneCache::new(&device, 11).with_budget(1);
        assert_eq!(cache.budget_bytes(), 1);

        let source = textured_packet();
        // Even the first candidate cannot fit a one-byte budget: staging builds
        // the candidate, but commit rejects it atomically before anything is
        // published or retained.
        let scopes = push_scopes(&device);
        let candidate =
            crate::gpu_scene_cache_test_support::stage(&cache, &device, &queue, &layout, &source);
        assert!(
            cache
                .validate_commit(&candidate)
                .unwrap_err()
                .contains("resident budget")
        );
        assert!(cache.domains.is_empty());
        assert_eq!(cache.revisions.tracked_revisions(), 0);
        assert_eq!(cache.live_resources(), Default::default());
        let error = match cache.commit(candidate) {
            Ok(_) => panic!("one-byte budget must reject every candidate"),
            Err(error) => error,
        };
        assert!(error.contains("resident budget"), "{error}");
        assert_eq!(cache.live_bytes(), 0);
        assert_eq!(cache.peak_live_bytes(), 0);
        clean_scopes(scopes, "budget reject").await;

        // A realistic budget accepts the packet and reports exact live bytes.
        let mut cache = GpuSceneCache::new(&device, 12).with_budget(default_budget(&device));
        assert!(cache.budget_bytes() >= 256 * 1024 * 1024);
        let staged =
            crate::gpu_scene_cache_test_support::stage(&cache, &device, &queue, &layout, &source);
        let bytes = staged.new_resident_bytes;
        assert!(bytes > 0);
        cache.validate_commit(&staged).unwrap();
        cache.validate_commit(&staged).unwrap();
        assert!(cache.domains.is_empty());
        assert_eq!(cache.revisions.tracked_revisions(), 0);
        assert_eq!(cache.live_bytes(), 0);
        assert_eq!(cache.peak_live_bytes(), 0);
        let saved_budget = cache.budget_bytes();
        cache.budget_bytes = 1;
        assert!(
            cache
                .validate_commit(&staged)
                .unwrap_err()
                .contains("resident budget")
        );
        cache.budget_bytes = saved_budget;
        cache
            .domains
            .extend((0..256).map(|index| format!("occupied-{index}")));
        assert!(
            cache
                .validate_commit(&staged)
                .unwrap_err()
                .contains("source-domain budget")
        );
        assert_eq!(cache.domains.len(), 256);
        assert_eq!(cache.revisions.tracked_revisions(), 0);
        cache.domains.clear();
        cache.validate_commit(&staged).unwrap();
        let live = cache.commit(staged).unwrap();
        assert_eq!(cache.live_bytes(), bytes);
        assert!(cache.peak_live_bytes() >= bytes);
        drop(live);
        assert_eq!(cache.live_bytes(), 0, "dropped scene releases its bytes");
        assert_no_uncaptured_errors(&uncaptured);
        println!(
            "native resident budget OK: candidate_bytes={bytes} budget={} live_after_drop=0",
            cache.budget_bytes()
        );
    });
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_packet_cache_reuses_replaces_rolls_back_and_releases() {
    pollster::block_on(async {
        let (device, queue) = high_performance_device().await;
        let uncaptured = capture_uncaptured_errors(&device);
        let layout = create_material_layout(&device);
        let mut cache = GpuSceneCache::new(&device, 41);
        let source = textured_packet();

        let scopes = push_scopes(&device);
        let first = stage(&cache, &device, &queue, &layout, &source);
        let first_metrics = first.metrics();
        assert_eq!(first_metrics.geometry_uploads, source.geometries.len());
        assert_eq!(first_metrics.texture_uploads, source.textures.len());
        assert_eq!(first_metrics.material_uploads, source.materials.len());
        assert_eq!(first_metrics.instance_buffer_uploads, 1);
        clean_scopes(scopes, "native cache first stage").await;
        let first = cache.commit(first).unwrap();
        let first_bytes = read_instances(&device, &queue, &first, source.instances.len());

        let same = stage(&cache, &device, &queue, &layout, &source);
        let same_metrics = same.metrics();
        assert_eq!(same_metrics.geometry_reuses, source.geometries.len());
        assert_eq!(same_metrics.texture_reuses, source.textures.len());
        assert_eq!(same_metrics.material_reuses, source.materials.len());
        assert_eq!(same_metrics.instance_buffer_reuses, 1);
        let same = cache.commit(same).unwrap();

        let mut moved = textured_packet();
        moved.instances[0].transform[12] += 0.4;
        let scopes = push_scopes(&device);
        let moved_candidate = stage(&cache, &device, &queue, &layout, &moved);
        let moved_metrics = moved_candidate.metrics();
        assert_eq!(moved_metrics.geometry_reuses, moved.geometries.len());
        assert_eq!(moved_metrics.texture_reuses, moved.textures.len());
        assert_eq!(moved_metrics.material_reuses, moved.materials.len());
        assert_eq!(moved_metrics.instance_uploaded_bytes, PACKED_INSTANCE_BYTES);
        assert_eq!(moved_metrics.instance_copied_bytes, PACKED_INSTANCE_BYTES);
        clean_scopes(scopes, "native cache moved stage").await;
        let moved_scene = cache.commit(moved_candidate).unwrap();
        let moved_bytes = read_instances(&device, &queue, &moved_scene, moved.instances.len());
        assert_ne!(
            &first_bytes[..PACKED_INSTANCE_BYTES as usize],
            &moved_bytes[..PACKED_INSTANCE_BYTES as usize]
        );
        assert_eq!(
            &first_bytes[PACKED_INSTANCE_BYTES as usize..],
            &moved_bytes[PACKED_INSTANCE_BYTES as usize..]
        );

        let mut illegal = textured_packet();
        illegal.geometries[0].vertices[0] += 0.5;
        let error = match cache.stage(
            &device,
            &queue,
            &layout,
            &illegal,
            scene_content_key(&illegal),
            &prepare_scene(&illegal).unwrap(),
            &prepare_pbr_resources(&illegal).unwrap(),
        ) {
            Ok(_) => panic!("reused revision was accepted"),
            Err(error) => error,
        };
        assert!(error.contains("reused for different content"), "{error}");
        assert_eq!(
            first_bytes,
            read_instances(&device, &queue, &first, source.instances.len())
        );

        let mut material = textured_packet();
        material.materials[0]
            .base_color_texture
            .as_mut()
            .unwrap()
            .rotation = Some(0.75);
        let invalid_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("intentionally invalid material cache layout"),
            entries: &[],
        });
        let invalid_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let rejected = stage(&cache, &device, &queue, &invalid_layout, &material);
        assert!(invalid_scope.pop().await.is_some());
        drop(rejected);
        let retry = stage(&cache, &device, &queue, &layout, &material);
        assert_eq!(
            retry.metrics().material_uploads,
            1,
            "failed candidate leaked into cache"
        );
        let latest = cache.commit(retry).unwrap();

        drop(first);
        drop(same);
        drop(moved_scene);
        assert_eq!(cache.live_resources().geometries, source.geometries.len());
        assert_eq!(cache.live_resources().textures, source.textures.len());
        assert_eq!(cache.live_resources().materials, source.materials.len());
        assert_eq!(cache.live_resources().instance_buffers, 1);
        drop(latest);
        assert_eq!(cache.live_resources(), Default::default());

        let stale = stage(&cache, &device, &queue, &layout, &source);
        cache.validate_commit(&stale).unwrap();
        cache.reset(&device, 42);
        assert!(cache.validate_commit(&stale).unwrap_err().contains("stale"));
        let error = match cache.commit(stale) {
            Ok(_) => panic!("stale cache candidate was accepted"),
            Err(error) => error,
        };
        assert!(error.contains("stale"), "{error}");
        assert_eq!(cache.epoch(), 42);
        assert_no_uncaptured_errors(&uncaptured);
        println!(
            "native packet cache: first={first_metrics:?} same={same_metrics:?} moved={moved_metrics:?}; release=0; epoch=42"
        );
    });
}
