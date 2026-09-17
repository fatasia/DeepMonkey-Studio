use super::{Renderer, StagedRenderPacketUpdate, drop_preview::swap_scene};
use crate::{
    events::RenderOutcome, gpu_scene_cache::GpuSceneCacheMetrics,
    shadow_map_update::ShadowMapUpdate,
};

impl Renderer {
    pub(crate) fn present_render_packet_update(
        &mut self,
        mut staged: StagedRenderPacketUpdate,
    ) -> Result<(RenderOutcome, GpuSceneCacheMetrics), String> {
        let outcome = if let StagedRenderPacketUpdate::Replace(candidate) = &mut staged {
            self._scene_cache.validate_commit(&candidate.scene)?;
            let restore = self.shadow_map.stage_scene_update(
                &self.frame,
                super::shadow_camera(self.size, &self.frame, self.view),
                super::shadow_ray_direction(&self.frame),
                self.shadow_map.scene_bounds,
            )?;
            let mut guard = PacketFrameGuard {
                renderer: self,
                candidate,
                restore,
                swapped: false,
            };
            guard
                .renderer
                .shadow_map
                .publish_scene_update(&guard.renderer.queue, guard.candidate.shadow_update.clone());
            swap_scene(guard.renderer, guard.candidate);
            guard.swapped = true;
            guard.renderer.shadow_cache.invalidate();
            guard.renderer.render_internal(true, true)
        } else {
            self.render_internal(true, true)
        };
        // 预检、呈现和提交连续执行；期间不让出事件循环，也不修改缓存所有权。
        match outcome {
            RenderOutcome::Presented => self
                .publish_render_packet_update(staged)
                .map(|metrics| (RenderOutcome::Presented, metrics)),
            RenderOutcome::Failed(error) => Err(error),
            outcome => Ok((outcome, GpuSceneCacheMetrics::default())),
        }
    }
}

struct PacketFrameGuard<'a> {
    renderer: &'a mut Renderer,
    candidate: &'a mut super::StagedRenderPacketPayload,
    restore: ShadowMapUpdate,
    swapped: bool,
}

impl Drop for PacketFrameGuard<'_> {
    fn drop(&mut self) {
        if self.swapped {
            swap_scene(self.renderer, self.candidate);
        }
        self.renderer
            .shadow_map
            .publish_scene_update(&self.renderer.queue, self.restore.clone());
        self.renderer.shadow_cache.invalidate();
    }
}
