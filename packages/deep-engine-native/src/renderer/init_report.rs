use crate::{gpu_scene::GpuScene, gpu_scene_cache::GpuSceneCache, player_content::PlayerContent};

pub(super) fn report_scene_cache(
    cache: &GpuSceneCache,
    metrics: crate::gpu_scene_cache::GpuSceneCacheMetrics,
    scene: &GpuScene,
    content: &PlayerContent,
) {
    let live = cache.live_resources();
    println!(
        "native scene cache epoch {}: geometry upload/reuse={}/{}, texture={}/{}, material={}/{}, instance upload/reuse={}/{} bytes uploaded/copied={}/{}",
        cache.epoch(),
        metrics.geometry_uploads,
        metrics.geometry_reuses,
        metrics.texture_uploads,
        metrics.texture_reuses,
        metrics.material_uploads,
        metrics.material_reuses,
        metrics.instance_buffer_uploads,
        metrics.instance_buffer_reuses,
        metrics.instance_uploaded_bytes,
        metrics.instance_copied_bytes,
    );
    println!(
        "native scene cache live: geometry={} texture={} material={} instances={}",
        live.geometries, live.textures, live.materials, live.instance_buffers,
    );
    println!(
        "native scene cache budget: live_bytes={} peak_bytes={} budget_bytes={}",
        cache.live_bytes(),
        cache.peak_live_bytes(),
        cache.budget_bytes(),
    );
    if let Some(materials) = &scene.shader_materials {
        println!(
            "native Player ShaderPackage materials ready: packages={} materials={}",
            content.shader_packages.len(),
            materials.materials.iter().flatten().count()
        );
    }
}
