use deep_engine_native::{
    culling_contract::prepare_gpu_culling, lod_contract::prepare_gpu_lod,
    pbr_texture::prepare_pbr_resources, scene::prepare_scene, scene_bounds::prepare_scene_bounds,
};

use crate::{
    gpu_culling::GpuCulling,
    gpu_lod::GpuLod,
    gpu_resources::{shadow_camera, shadow_ray_direction},
    gpu_scene_cache::{GpuSceneCacheLive, GpuSceneCacheMetrics},
    gpu_shader_materials::GpuShaderMaterials,
    player_content::PlayerContent,
};

use super::Renderer;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RendererSceneEvidence {
    pub bounds: Option<deep_engine_native::scene_bounds::SceneWorldBounds>,
    pub first_cascade: [[f32; 4]; 4],
    pub shadow_version: deep_engine_native::shadow_cache::ShadowVersion,
    pub shadow_render_pending: bool,
    pub culling_candidates: usize,
    pub cache_live: GpuSceneCacheLive,
}

impl Renderer {
    /// Builds a complete candidate and publishes it only after all wgpu scopes succeed.
    /// This synchronous packet boundary has no cancellation token; callers cancel before entry.
    #[allow(dead_code)] // The public native reload transport is a later slice.
    pub async fn replace_render_packet(
        &mut self,
        content: &PlayerContent,
    ) -> Result<GpuSceneCacheMetrics, String> {
        if content.environment.id != self.ibl.id
            || content.environment.revision != self.ibl.revision
        {
            return Err(
                "native RenderPacket update changed IBL identity; rebuild the renderer epoch"
                    .into(),
            );
        }
        let shader_signature = GpuShaderMaterials::content_key(content)?;
        if self
            .scene
            .matches_content(content.scene_content_key(), shader_signature.as_deref())
        {
            return Ok(GpuSceneCacheMetrics::default());
        }
        let packet = content.packet();
        let prepared = prepare_scene(packet)?;
        let culling = prepare_gpu_culling(packet, &prepared)?;
        let lod = prepare_gpu_lod(packet, &prepared)?;
        let pbr = prepare_pbr_resources(packet)?;
        let bounds = prepare_scene_bounds(packet)?;
        let shadow_update = self.shadow_map.stage_scene_update(
            &self.frame,
            shadow_camera(self.size, &self.frame),
            shadow_ray_direction(&self.frame),
            bounds,
        )?;
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let candidate = self
            ._scene_cache
            .stage(
                &self.device,
                &self.queue,
                &self.material_layout,
                packet,
                content.scene_content_key(),
                &prepared,
                &pbr,
            )
            .and_then(|mut scene| {
                scene.scene_mut().replace_shader_materials(
                    &self.device,
                    content,
                    &self.frame_buffer,
                    &self.shadow_map,
                    &self.ibl,
                )?;
                let next_culling = GpuCulling::new(
                    &self.device,
                    &scene.scene().instance_buffer,
                    &culling,
                    &self.frame,
                    &shadow_update,
                    self.shadow_probe.is_some(),
                )?;
                let next_lod = GpuLod::new(
                    &self.device,
                    &scene.scene().instance_buffer,
                    &lod,
                    &self.frame,
                    self.size,
                    &shadow_update,
                )?;
                Ok((scene, next_culling, next_lod))
            });
        let gpu_errors = [
            internal.pop().await,
            memory.pop().await,
            validation.pop().await,
        ];
        if let Some(error) = gpu_errors.into_iter().flatten().next() {
            drop(candidate);
            return Err(format!(
                "native RenderPacket candidate rejected atomically: {error}"
            ));
        }
        let (candidate, culling, lod) = candidate?;
        let metrics = candidate.metrics();
        let scene = self._scene_cache.commit(candidate)?;
        self.shadow_map
            .publish_scene_update(&self.queue, shadow_update);
        self.scene = scene;
        self.culling = culling;
        self.lod = lod;
        self.shadow_version.bump_scene();
        Ok(metrics)
    }

    pub fn scene_update_evidence(&self) -> RendererSceneEvidence {
        RendererSceneEvidence {
            bounds: self.shadow_map.scene_bounds,
            first_cascade: self.shadow_map.cascade_view_projection(0),
            shadow_version: self.shadow_version,
            shadow_render_pending: self.shadow_cache.needs_render(self.shadow_version),
            culling_candidates: self.culling.summary().candidate_instances as usize,
            cache_live: self._scene_cache.live_resources(),
        }
    }

    pub fn last_shadow_probe(&self) -> Option<crate::shadow_probe::ShadowProbeMetrics> {
        self.last_shadow_probe
    }
}
