use super::*;
use crate::events::RenderOutcome;

impl Renderer {
    #[cfg(test)]
    pub(crate) fn camera_frame_for_test(&self) -> deep_engine_native::mesh_abi::FrameUniform {
        self.frame
    }

    pub(crate) fn verify_candidate_frame(&mut self) -> Result<(), String> {
        match self.render_internal(true, false) {
            RenderOutcome::Presented => Ok(()),
            RenderOutcome::Failed(error) => Err(error),
            _ => Err("candidate frame validation unavailable; previous scene retained".into()),
        }
    }

    pub(crate) async fn replace_dropped_package(
        &mut self,
        previous: &PlayerContent,
        content: &PlayerContent,
    ) -> Result<(), String> {
        if self.lighting != content.lighting {
            return Err("authored lighting change requires a full renderer transaction".into());
        }
        // 预览路径不重写 frame uniform，作者雾变更（含宿主雾与作者雾互换）必须整重建。
        if content.background.is_some()
            && self.fog
                != content
                    .fog
                    .unwrap_or(deep_engine_native::fog::FogSettings::DISABLED)
        {
            return Err("authored fog change requires a full renderer transaction".into());
        }
        if content.background.is_some() && (self.bloom.is_some() || self.fog.requires_output_pass())
        {
            return Err(
                "authored solid background requires the native-aces-v1 output without Bloom/Fog"
                    .into(),
            );
        }
        let mut environment = self
            .stage_environment(&content.environment, content.background)
            .await?;
        let mut scene = self
            .stage_packet_with_environment(
                previous.packet(),
                content,
                environment.as_ref().map_or(&self.ibl, |e| &e.ibl),
                environment.is_some(),
            )
            .await?;
        if let StagedRenderPacketUpdate::Replace(candidate) = &scene {
            self._scene_cache.validate_commit(&candidate.scene)?;
        }
        // 换包重建已经按 (package_id, package_hash) 给出了 document_revision,
        // 直接把它作为资源代次:同包重复发布幂等,不同包整批失效。
        let context = content.deep2d.as_ref().map(|deep2d| {
            crate::deep2d_gpu::deep2d_frame_context(
                deep2d,
                [self.size.width, self.size.height],
                content.epoch.document_revision,
            )
        });
        let mut deep2d = self
            .stage_deep2d_update_inner(content.deep2d.as_ref(), context)
            .await?;
        let restore = self.shadow_map.stage_scene_update(
            &self.frame,
            shadow_camera(self.size, &self.frame, self.view),
            shadow_ray_direction(&self.frame),
            self.shadow_map.scene_bounds,
        )?;
        let guard = PreviewGuard {
            renderer: self,
            scene: &mut scene,
            deep2d: &mut deep2d,
            environment: &mut environment,
            restore: Some(restore),
            swapped: false,
        };
        let outcome = guard.verify();
        match outcome {
            RenderOutcome::Presented => {
                // Preview never presents. Budget/revision commit may still reject,
                // in which case CPU content and the displayed image remain old.
                self.publish_render_packet_update(scene)?;
                if let Some(environment) = &mut environment {
                    environment.swap(self);
                }
                self.publish_deep2d_update(deep2d);
                Ok(())
            }
            RenderOutcome::Failed(error) => Err(error),
            _ => Err("candidate frame validation unavailable; previous scene retained".into()),
        }
    }
}

struct PreviewGuard<'a> {
    renderer: &'a mut Renderer,
    scene: &'a mut StagedRenderPacketUpdate,
    deep2d: &'a mut StagedDeep2dUpdate,
    environment: &'a mut Option<crate::renderer::environment_update::StagedEnvironment>,
    restore: Option<ShadowMapUpdate>,
    swapped: bool,
}
impl PreviewGuard<'_> {
    fn verify(mut self) -> RenderOutcome {
        if let StagedRenderPacketUpdate::Replace(candidate) = self.scene {
            self.renderer
                .shadow_map
                .publish_scene_update(&self.renderer.queue, candidate.shadow_update.clone());
            swap_scene(self.renderer, candidate);
        }
        std::mem::swap(&mut self.renderer.deep2d, &mut self.deep2d.candidate);
        if let Some(environment) = self.environment {
            environment.swap(self.renderer);
        }
        self.swapped = true;
        self.renderer.shadow_cache.invalidate();
        // Synchronous GPU verification: no event-loop pumping or await while
        // borrowed candidate resources are installed. Drop restores on unwind too.
        self.renderer.render_internal(true, false)
    }
}
impl Drop for PreviewGuard<'_> {
    fn drop(&mut self) {
        if self.swapped {
            if let Some(environment) = self.environment {
                environment.swap(self.renderer);
            }
            std::mem::swap(&mut self.renderer.deep2d, &mut self.deep2d.candidate);
            if let StagedRenderPacketUpdate::Replace(candidate) = self.scene {
                swap_scene(self.renderer, candidate);
            }
        }
        if let Some(restore) = self.restore.take() {
            self.renderer
                .shadow_map
                .publish_scene_update(&self.renderer.queue, restore);
        }
        self.renderer.shadow_cache.invalidate();
    }
}
pub(super) fn swap_scene(renderer: &mut Renderer, staged: &mut StagedRenderPacketPayload) {
    std::mem::swap(&mut renderer.scene, staged.scene.scene_mut());
    std::mem::swap(&mut renderer.culling, &mut staged.culling);
    std::mem::swap(&mut renderer.lod, &mut staged.lod);
    std::mem::swap(&mut renderer.shadow_casters, &mut staged.shadow_casters);
    std::mem::swap(&mut renderer.shadow_keys, &mut staged.shadow_keys);
    std::mem::swap(
        &mut renderer.shadow_shader_key,
        &mut staged.shadow_shader_key,
    );
}
