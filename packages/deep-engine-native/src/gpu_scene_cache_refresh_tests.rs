//! Real-GPU assertions for the C3 resource-reuse scene-refresh staging: cast
//! shadow-flag and LOD-only changes rebuild only the instance buffer and batch
//! table while every resident geometry/texture/material is reused object-for-
//! object, identity drift and evicted resources fall back instead of silently
//! re-uploading, and commits register nothing new in the revision domain.

use std::sync::Arc;

use bytemuck::cast_slice;
use deep_engine_native::{
    contract::RenderPacket,
    mesh_abi::PACKED_INSTANCE_BYTES,
    scene::prepare_scene,
};

use crate::{
    gpu_scene_cache::GpuSceneCache,
    gpu_scene_cache_test_support::{
        alpha_packet, assert_no_uncaptured_errors, capture_uncaptured_errors, clean_scopes,
        high_performance_device, prepare, push_scopes, read_instances, stage, with_lod_profile,
        with_lod_target,
    },
    gpu_textures::create_material_layout,
    player_shader_plan::scene_content_key,
};

fn cast_flip(packet: &RenderPacket) -> RenderPacket {
    let mut next = packet.clone();
    next.instances[0].cast_shadow = Some(false);
    next
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn scene_refresh_reuses_all_resources_and_falls_back_on_drift() {
    pollster::block_on(async {
        let (device, queue) = high_performance_device().await;
        let uncaptured = capture_uncaptured_errors(&device);
        let mut cache = GpuSceneCache::new(&device, 11);
        // 基线 packet 预置一个未引用的 LOD 目标几何(三角数严格递减),
        // 使后续 LOD-only 变体不需要动几何列表 → 满足刷新前置。
        let source = with_lod_target(&alpha_packet());

        let scopes = push_scopes(&device);
        let base = stage(&cache, &device, &queue, &create_material_layout(&device), &source);
        let base_metrics = base.metrics();
        assert_eq!(base_metrics.geometry_uploads, source.geometries.len());
        assert_eq!(base_metrics.texture_uploads, source.textures.len());
        assert_eq!(base_metrics.material_uploads, source.materials.len());
        clean_scopes(scopes, "refresh baseline").await;
        let base_geometry = Arc::as_ptr(&base.scene().geometries[0]);
        let base_material = Arc::as_ptr(&base.scene().pbr.materials[0]);
        let base_scene = cache.commit(base).unwrap();
        let base_summary = base_scene.pbr_summary();

        // cast 阴影标志翻转:批键变化 → 批重排,但几何/纹理/材质身份不变 →
        // 刷新 staging 必须对象级复用全部已驻留资源,仅实例缓冲重排上传。
        let flipped = cast_flip(&source);
        cache.probe_scene_refresh(&flipped, "").unwrap();
        let (prepared, _) = prepare(&flipped);
        let scopes = push_scopes(&device);
        let candidate = cache
            .stage_scene_refresh(&device, &queue, &flipped, scene_content_key(&flipped), &prepared, base_summary, "")
            .unwrap();
        let metrics = candidate.metrics();
        assert_eq!(metrics.geometry_reuses, source.geometries.len());
        assert_eq!(metrics.texture_reuses, source.textures.len());
        assert_eq!(metrics.material_reuses, source.materials.len());
        assert_eq!(metrics.geometry_uploads, 0);
        assert_eq!(metrics.texture_uploads, 0);
        assert_eq!(metrics.material_uploads, 0);
        assert!(candidate.new_geometries.is_empty());
        assert!(candidate.new_textures.is_empty());
        assert!(candidate.new_materials.is_empty());
        assert_eq!(Arc::as_ptr(&candidate.scene().geometries[0]), base_geometry);
        assert_eq!(Arc::as_ptr(&candidate.scene().pbr.materials[0]), base_material);
        assert!(
            candidate
                .scene()
                .batches
                .iter()
                .any(|batch| !batch.cast_shadow),
            "flipped cast flag must appear in the rebuilt batch table"
        );
        // alpha 夹具四实例材质互异 → cast 翻转只改批标志、打包词逐位不变。
        // 指纹含批表 → 新缓冲;copy-diff 必须从旧缓冲整块拷贝 576B,零重上传。
        assert_eq!(metrics.instance_buffer_uploads, 1);
        assert_eq!(metrics.instance_uploaded_bytes, 0);
        assert_eq!(
            metrics.instance_copied_bytes,
            u64::try_from(flipped.instances.len()).unwrap() * PACKED_INSTANCE_BYTES,
            "unchanged instance words must be copied, not re-uploaded"
        );
        clean_scopes(scopes, "cast-flag refresh").await;
        let flipped_scene = cache.commit(candidate).unwrap();
        let expected = prepare_scene(&flipped).unwrap();
        let expected_bytes: &[u8] = cast_slice(&expected.instances);
        assert_eq!(
            read_instances(&device, &queue, &flipped_scene, flipped.instances.len()),
            expected_bytes,
            "committed instance buffer must equal a from-scratch prepare of the variant"
        );

        // LOD-only:同一条刷新通道,资源对象级复用不变。
        let loded = with_lod_profile(&source);
        cache.probe_scene_refresh(&loded, "").unwrap();
        let (prepared, _) = prepare(&loded);
        let scopes = push_scopes(&device);
        let candidate = cache
            .stage_scene_refresh(&device, &queue, &loded, scene_content_key(&loded), &prepared, base_summary, "")
            .unwrap();
        let metrics = candidate.metrics();
        assert_eq!(metrics.geometry_reuses, source.geometries.len());
        assert_eq!(metrics.texture_reuses, source.textures.len());
        assert_eq!(metrics.material_reuses, source.materials.len());
        assert_eq!(metrics.texture_uploads + metrics.geometry_uploads + metrics.material_uploads, 0);
        assert_eq!(Arc::as_ptr(&candidate.scene().geometries[0]), base_geometry);
        assert!(
            candidate.scene().batches.iter().any(|batch| batch.lod),
            "the LOD-flagged instance's batch must be rebuilt with lod=true"
        );
        assert!(
            candidate
                .scene()
                .batches
                .iter()
                .filter(|batch| batch.lod)
                .map(|batch| batch.instance_count as usize)
                .sum::<usize>()
                == 1,
            "exactly the LOD-flagged instance lands in a lod batch"
        );
        clean_scopes(scopes, "lod-only refresh").await;
        let loded_scene = cache.commit(candidate).unwrap();

        // 身份漂移(纹理 revision 变化)必须被前置核对拦截 → 回落全量路径。
        let mut drifted = source.clone();
        drifted.textures[0].revision += 1;
        assert!(cache.probe_scene_refresh(&drifted, "").is_err());
        assert!(
            cache
                .stage_scene_refresh(&device, &queue, &drifted, scene_content_key(&drifted), &prepare(&drifted).0, base_summary, "")
                .is_err()
        );

        // 资源失活(全部场景释放)后 probe 仍通过,但查取必须 fail-closed。
        drop(base_scene);
        drop(flipped_scene);
        drop(loded_scene);
        assert_eq!(cache.live_resources(), Default::default());
        let error = match cache.stage_scene_refresh(
            &device,
            &queue,
            &flipped,
            scene_content_key(&flipped),
            &prepare(&flipped).0,
            base_summary,
            "",
        ) {
            Ok(_) => panic!("evicted resources must not silently restage via refresh"),
            Err(error) => error,
        };
        assert!(error.contains("not resident"), "{error}");
        assert_eq!(cache.live_resources(), Default::default());

        assert_no_uncaptured_errors(&uncaptured);
        println!("C3 scene-refresh staging verified: reuse→repack→commit→drift/eviction fallback");
    });
}
