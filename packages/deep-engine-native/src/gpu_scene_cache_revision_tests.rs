//! Real-GPU assertions for resource-revision cascades in the scene cache: material
//! bindings rebuild only where identity changed, a revised texture rebuilds only its
//! dependents, sampler descriptions are part of texture identity, upload failures keep
//! the last committed scene, and disposal forces fresh uploads instead of zombie reuse.

use std::sync::Arc;

use deep_engine_native::pbr_texture::prepare_pbr_resources;
use deep_engine_native::scene::prepare_scene;

use crate::{
    gpu_scene_cache::GpuSceneCache,
    gpu_scene_cache_test_support::{
        alpha_packet, assert_no_uncaptured_errors, capture_uncaptured_errors, clean_scopes,
        high_performance_device, push_scopes, read_instances, stage,
    },
    gpu_textures::create_material_layout,
    player_shader_plan::scene_content_key,
};

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_texture_revision_rebuilds_only_dependents_and_fails_closed() {
    pollster::block_on(async {
        let (device, queue) = high_performance_device().await;
        let uncaptured = capture_uncaptured_errors(&device);
        let layout = create_material_layout(&device);
        let mut cache = GpuSceneCache::new(&device, 7);
        let source = alpha_packet();

        let scopes = push_scopes(&device);
        let base = stage(&cache, &device, &queue, &layout, &source);
        let base_metrics = base.metrics();
        assert_eq!(base_metrics.geometry_uploads, source.geometries.len());
        assert_eq!(base_metrics.texture_uploads, source.textures.len());
        assert_eq!(base_metrics.material_uploads, source.materials.len());
        assert_eq!(base_metrics.instance_buffer_uploads, 1);
        clean_scopes(scopes, "native revision baseline").await;
        let base_instance = Arc::as_ptr(&base.instance);
        let base = cache.commit(base).unwrap();
        let base_bytes = read_instances(&device, &queue, &base, source.instances.len());

        // Step 1 — identity-only update: detaching materials 2/3 from the emissive
        // texture changes exactly those two material identities. Geometry, every
        // texture, and the instance buffer must be reused object-for-object.
        let mut detached = alpha_packet();
        detached.materials[2].emissive_texture = None;
        detached.materials[3].emissive_texture = None;
        let scopes = push_scopes(&device);
        let candidate = stage(&cache, &device, &queue, &layout, &detached);
        let identity_metrics = candidate.metrics();
        assert_eq!(identity_metrics.geometry_uploads, 0);
        assert_eq!(identity_metrics.geometry_reuses, source.geometries.len());
        assert_eq!(identity_metrics.texture_uploads, 0);
        assert_eq!(identity_metrics.texture_reuses, source.textures.len());
        assert_eq!(
            identity_metrics.material_uploads, 2,
            "only the two detached materials rebuild"
        );
        assert_eq!(
            identity_metrics.material_reuses, 2,
            "untouched materials keep their GPU bindings"
        );
        assert_eq!(identity_metrics.instance_buffer_reuses, 1);
        assert_eq!(identity_metrics.instance_uploaded_bytes, 0);
        assert_eq!(identity_metrics.instance_copied_bytes, 0);
        assert!(candidate.new_geometries.is_empty());
        assert!(candidate.new_textures.is_empty());
        assert_eq!(
            Arc::as_ptr(&candidate.instance),
            base_instance,
            "reused scene must not create a new instance buffer"
        );
        clean_scopes(scopes, "native identity update").await;
        let detached_scene = cache.commit(candidate).unwrap();
        assert_eq!(
            base_bytes,
            read_instances(&device, &queue, &detached_scene, source.instances.len()),
            "untouched instances keep byte-identical GPU data"
        );

        // Step 2 — cascade: revise only the emissive texture. The two materials that
        // still sample it rebuild; the two detached materials are unaffected.
        let mut updated = alpha_packet();
        updated.materials[2].emissive_texture = None;
        updated.materials[3].emissive_texture = None;
        updated.textures[4].revision += 1;
        updated.textures[4].data[0] ^= 0x40;
        let scopes = push_scopes(&device);
        let candidate = stage(&cache, &device, &queue, &layout, &updated);
        let cascade_metrics = candidate.metrics();
        assert_eq!(cascade_metrics.geometry_uploads, 0);
        assert_eq!(cascade_metrics.geometry_reuses, source.geometries.len());
        assert_eq!(
            cascade_metrics.texture_uploads, 1,
            "only the revised texture uploads"
        );
        assert_eq!(cascade_metrics.texture_reuses, source.textures.len() - 1);
        assert_eq!(
            cascade_metrics.material_uploads, 2,
            "only emissive-dependent materials rebuild"
        );
        assert_eq!(
            cascade_metrics.material_reuses, 2,
            "detached materials are unaffected by the texture revision"
        );
        assert_eq!(cascade_metrics.instance_buffer_reuses, 1);
        assert_eq!(candidate.new_textures.len(), 1);
        assert_eq!(candidate.new_textures[0].0.1, updated.textures[4].revision);
        clean_scopes(scopes, "native revision cascade").await;
        let updated_scene = cache.commit(candidate).unwrap();
        assert_eq!(
            base_bytes,
            read_instances(&device, &queue, &updated_scene, source.instances.len())
        );
        drop(base);
        drop(detached_scene);
        let live = cache.live_resources();
        assert_eq!(live.geometries, 1);
        assert_eq!(
            live.textures,
            source.textures.len(),
            "the superseded texture revision retires with its scene"
        );
        assert_eq!(
            live.materials,
            source.materials.len(),
            "superseded material generations retire with their scenes"
        );
        assert_eq!(live.instance_buffers, 1);

        // A sampler change under the same revision is a content identity violation and
        // must fail closed before any GPU work; the committed scene stays untouched.
        let mut resampled = alpha_packet();
        resampled.materials[2].emissive_texture = None;
        resampled.materials[3].emissive_texture = None;
        resampled.textures[4].revision += 1;
        resampled.textures[4].data[0] ^= 0x40;
        resampled.textures[0].sampler = None;
        let error = match cache.stage(
            &device,
            &queue,
            &layout,
            &resampled,
            scene_content_key(&resampled),
            &prepare_scene(&resampled).unwrap(),
            &prepare_pbr_resources(&resampled).unwrap(),
        ) {
            Ok(_) => panic!("same-revision sampler change was accepted"),
            Err(error) => error,
        };
        assert!(error.contains("reused for different content"), "{error}");
        assert_eq!(cache.live_resources(), live);

        // Bumping the revision legalizes the sampler change: one new GPU texture and a
        // rebuild of every material that samples it, nothing else.
        resampled.textures[0].revision += 1;
        let scopes = push_scopes(&device);
        let candidate = stage(&cache, &device, &queue, &layout, &resampled);
        let resample_metrics = candidate.metrics();
        assert_eq!(resample_metrics.texture_uploads, 1);
        assert_eq!(resample_metrics.texture_reuses, source.textures.len() - 1);
        assert_eq!(
            resample_metrics.material_uploads,
            source.materials.len(),
            "every alpha material samples the base color texture"
        );
        assert_eq!(resample_metrics.material_reuses, 0);
        assert_eq!(resample_metrics.geometry_reuses, source.geometries.len());
        clean_scopes(scopes, "native resampled stage").await;
        let resampled_scene = cache.commit(candidate).unwrap();
        // Both base-color texture generations coexist while the previous scene still
        // references the old one; capture the live set as the failure-assert baseline.
        let live = cache.live_resources();
        assert_eq!(live.textures, source.textures.len() + 1);
        assert_eq!(live.materials, 2 * source.materials.len());

        // Tampering with a prepared mip chain changes the texture content fingerprint,
        // so the revision domain must reject it before any GPU upload happens — the
        // committed scene keeps its intact buffers.
        let mut broken = prepare_pbr_resources(&resampled).unwrap();
        broken.textures[1].levels.clear();
        let error = match cache.stage(
            &device,
            &queue,
            &layout,
            &resampled,
            scene_content_key(&resampled),
            &prepare_scene(&resampled).unwrap(),
            &broken,
        ) {
            Ok(_) => panic!("tampered prepared texture was staged"),
            Err(error) => error,
        };
        assert!(
            error.contains("metal-rough-linear") && error.contains("reused for different content"),
            "{error}"
        );
        assert_eq!(
            cache.live_resources(),
            live,
            "failed staging must not change resident resources"
        );
        assert_eq!(
            base_bytes,
            read_instances(&device, &queue, &resampled_scene, source.instances.len()),
            "last committed scene survives a rejected upload"
        );

        // Disposing every scene retires all GPU resources; the next stage uploads
        // everything again instead of resurrecting dead cache entries.
        drop(updated_scene);
        drop(resampled_scene);
        assert_eq!(cache.live_resources(), Default::default());
        let scopes = push_scopes(&device);
        let fresh = stage(&cache, &device, &queue, &layout, &source);
        let restage_metrics = fresh.metrics();
        assert_eq!(restage_metrics.texture_uploads, source.textures.len());
        assert_eq!(restage_metrics.material_uploads, source.materials.len());
        assert_eq!(restage_metrics.geometry_uploads, source.geometries.len());
        assert_eq!(restage_metrics.instance_buffer_uploads, 1);
        clean_scopes(scopes, "native disposal restage").await;
        drop(cache.commit(fresh).unwrap());
        assert_eq!(cache.live_resources(), Default::default());

        assert_no_uncaptured_errors(&uncaptured);
        println!(
            "native revision cascade: base={base_metrics:?} identity={identity_metrics:?} cascade={cascade_metrics:?} resample={resample_metrics:?} restage={restage_metrics:?}; live resets to zero after disposal"
        );
    });
}
