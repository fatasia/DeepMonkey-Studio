use deep_engine_native::{
    culling_contract::prepare_gpu_culling, lod_contract::prepare_gpu_lod,
    pbr_texture::prepare_pbr_resources, scene::prepare_scene, scene_bounds::prepare_scene_bounds,
};

use crate::{
    deep2d_gpu::{Deep2dFrameContext, Deep2dGpuPainter},
    deep2d_gpu_cache::{Deep2dCacheStats, Deep2dGpuAssetCache},
    gpu_culling::GpuCulling,
    gpu_lod::GpuLod,
    gpu_resources::{shadow_camera, shadow_ray_direction},
    gpu_scene_cache::{GpuSceneCacheMetrics, GpuSceneCandidate},
    gpu_shader_materials::GpuShaderMaterials,
    player_content::PlayerContent,
    shadow_dirty::{ShadowCascadeKey, ShadowCasterSet, shader_key},
    shadow_map_update::ShadowMapUpdate,
    shadow_update_classify::classify_shadow_relevance,
};

use super::Renderer;
#[path = "drop_preview.rs"]
mod drop_preview;

pub(crate) struct StagedDeep2dUpdate {
    candidate: Option<Deep2dGpuPainter>,
    stats: Deep2dCacheStats,
}

pub(crate) enum StagedRenderPacketUpdate {
    Noop,
    Replace(Box<StagedRenderPacketPayload>),
}

pub(crate) struct StagedRenderPacketPayload {
    scene: GpuSceneCandidate,
    culling: GpuCulling,
    lod: Option<GpuLod>,
    shadow_update: ShadowMapUpdate,
    shadow_casters: ShadowCasterSet,
    shadow_keys: Vec<ShadowCascadeKey>,
    shadow_shader_key: u64,
    invalidate_shadow: bool,
}

impl Renderer {
    /// `context` 由宿主装配层给出(见 `deep2d_gpu::deep2d_frame_context`):
    /// 资源代次取目标 epoch,物理缩放取 letterbox 实际比值。
    /// 传 `None` 退回第一批行为(Noop 维度),供未接线路径使用。
    pub(crate) async fn stage_deep2d_update_inner(
        &self,
        content: Option<&deep_engine_native::deep2d::Deep2dRuntimeContent>,
        context: Option<Deep2dFrameContext>,
    ) -> Result<StagedDeep2dUpdate, String> {
        let Some(content) = content else {
            return Ok(StagedDeep2dUpdate {
                candidate: None,
                stats: Deep2dCacheStats::default(),
            });
        };
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let candidate = match &self.deep2d {
            Some(active) => match context {
                Some(context) => active.stage_update_with_context(
                    &self.device,
                    &self.queue,
                    self.config.format,
                    content,
                    context,
                ),
                None => active.stage_update(&self.device, &self.queue, self.config.format, content),
            },
            None => {
                let cache = std::sync::Arc::new(Deep2dGpuAssetCache::new());
                match context {
                    Some(context) => Deep2dGpuPainter::new_with_context(
                        &self.device,
                        &self.queue,
                        self.config.format,
                        content,
                        &cache,
                        context,
                    ),
                    None => Deep2dGpuPainter::new(
                        &self.device,
                        &self.queue,
                        self.config.format,
                        content,
                        &cache,
                    ),
                }
            }
        };
        let gpu_errors = [
            internal.pop().await,
            memory.pop().await,
            validation.pop().await,
        ];
        if let Some(error) = gpu_errors.into_iter().flatten().next() {
            drop(candidate);
            return Err(format!(
                "native Deep2D candidate rejected atomically: {error}"
            ));
        }
        let candidate = candidate?;
        Ok(StagedDeep2dUpdate {
            stats: candidate.cache_stats(),
            candidate: Some(candidate),
        })
    }

    pub(crate) fn publish_deep2d_update(&mut self, staged: StagedDeep2dUpdate) -> Deep2dCacheStats {
        self.deep2d = staged.candidate;
        staged.stats
    }

    pub(crate) async fn stage_render_packet_update(
        &self,
        previous_packet: &deep_engine_native::contract::RenderPacket,
        content: &PlayerContent,
    ) -> Result<StagedRenderPacketUpdate, String> {
        if crate::gpu_ibl::GpuIblEnvironment::source_identity(&content.environment)
            != self.ibl.identity
        {
            return Err(
                "native RenderPacket update changed IBL identity; rebuild the renderer epoch"
                    .into(),
            );
        }
        self.stage_packet_with_environment(previous_packet, content, &self.ibl, false)
            .await
    }

    pub(super) async fn stage_packet_with_environment(
        &self,
        previous_packet: &deep_engine_native::contract::RenderPacket,
        content: &PlayerContent,
        ibl: &crate::gpu_ibl::GpuIblEnvironment,
        environment_changed: bool,
    ) -> Result<StagedRenderPacketUpdate, String> {
        if self.requires_content_rebuild(content) {
            return Err(
                "native content allocation profile changed; stage a complete renderer epoch".into(),
            );
        }
        let shader_signature = GpuShaderMaterials::content_key(content)?;
        let shadow_shader_key = shader_key(shader_signature.as_deref());
        if !environment_changed
            && self._scene_cache.active_domain() == content.resource_domain()
            && self
                .scene
                .matches_content(content.scene_content_key(), shader_signature.as_deref())
        {
            return Ok(StagedRenderPacketUpdate::Noop);
        }
        let packet = content.packet();
        let shadow_relevance = classify_shadow_relevance(previous_packet, packet);
        let prepared = prepare_scene(packet)?;
        let culling = prepare_gpu_culling(packet, &prepared)?;
        let lod = prepare_gpu_lod(packet, &prepared)?;
        let pbr = prepare_pbr_resources(packet)?;
        let bounds = prepare_scene_bounds(packet)?;
        let shadow_casters = ShadowCasterSet::prepare(packet, &prepared, &culling, &lod)?;
        let shadow_update = self.shadow_map.stage_scene_update(
            &self.frame,
            shadow_camera(self.size, &self.frame, self.view),
            shadow_ray_direction(&self.frame),
            bounds,
        )?;
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let candidate = self
            ._scene_cache
            .stage_scoped(
                &self.device,
                &self.queue,
                &self.material_layout,
                packet,
                content.scene_content_key(),
                &prepared,
                &pbr,
                content.resource_domain(),
            )
            .and_then(|mut scene| {
                scene.scene_mut().replace_shader_materials(
                    &self.device,
                    content,
                    &self.frame_buffer,
                    &self.shadow_map,
                    ibl,
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
                    self.view.near,
                )?;
                let shadow_keys = shadow_casters.keys(&shadow_update, shadow_shader_key)?;
                Ok((scene, next_culling, next_lod, shadow_keys))
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
        let (scene, culling, lod, shadow_keys) = candidate?;
        Ok(StagedRenderPacketUpdate::Replace(Box::new(
            StagedRenderPacketPayload {
                scene,
                culling,
                lod,
                shadow_update,
                shadow_casters,
                shadow_keys,
                shadow_shader_key,
                invalidate_shadow: shadow_relevance.must_invalidate,
            },
        )))
    }

    pub(crate) fn publish_render_packet_update(
        &mut self,
        staged: StagedRenderPacketUpdate,
    ) -> Result<GpuSceneCacheMetrics, String> {
        let StagedRenderPacketUpdate::Replace(staged) = staged else {
            return Ok(GpuSceneCacheMetrics::default());
        };
        let metrics = staged.scene.metrics();
        let scene = self._scene_cache.commit(staged.scene)?;
        self.shadow_map
            .publish_scene_update(&self.queue, staged.shadow_update);
        self.scene = scene;
        self.culling = staged.culling;
        self.lod = staged.lod;
        self.shadow_casters = staged.shadow_casters;
        self.shadow_keys = staged.shadow_keys;
        self.shadow_shader_key = staged.shadow_shader_key;
        if staged.invalidate_shadow {
            self.shadow_version.bump_scene();
        }
        Ok(metrics)
    }
}
