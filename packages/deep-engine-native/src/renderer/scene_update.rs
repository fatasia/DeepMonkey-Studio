use crate::{
    gpu_scene_cache::{GpuSceneCacheLive, GpuSceneCacheMetrics},
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
    pub async fn replace_render_packet(
        &mut self,
        previous_packet: &deep_engine_native::contract::RenderPacket,
        content: &PlayerContent,
    ) -> Result<GpuSceneCacheMetrics, String> {
        let staged = self
            .stage_render_packet_update(previous_packet, content)
            .await?;
        self.publish_render_packet_update(staged)
    }

    pub fn scene_update_evidence(&self) -> RendererSceneEvidence {
        RendererSceneEvidence {
            bounds: self.shadow_map.scene_bounds,
            first_cascade: self.shadow_map.cascade_view_projection(0),
            shadow_version: self.shadow_version,
            shadow_render_pending: self.shadow_cache.plan(&self.shadow_keys).dirty_mask != 0,
            culling_candidates: self.culling.summary().candidate_instances as usize,
            cache_live: self._scene_cache.live_resources(),
        }
    }

    pub fn last_shadow_probe(&self) -> Option<crate::shadow_probe::ShadowProbeMetrics> {
        self.last_shadow_probe
    }
}
