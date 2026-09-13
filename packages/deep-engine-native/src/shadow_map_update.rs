use bytemuck::cast_slice;
use deep_engine_native::{
    cascaded_shadow::{CascadedShadowCamera, CascadedShadowPlan, plan_cascaded_shadows_for_scene},
    mesh_abi::FrameUniform,
    scene_bounds::SceneWorldBounds,
};

use crate::shadow_map::{DEPTH_BIAS, ShadowMap, ShadowViewSource, pack_shadow_frames};

pub struct ShadowMapUpdate {
    plan: CascadedShadowPlan,
    scene_bounds: Option<SceneWorldBounds>,
    sampling_data: Vec<u8>,
    shadow_frame_data: Vec<u8>,
}

impl ShadowViewSource for ShadowMapUpdate {
    fn cascade_count(&self) -> u32 {
        self.plan.cascades.len() as u32
    }

    fn cascade_view_projection(&self, index: usize) -> [[f32; 4]; 4] {
        self.plan.cascades[index].view_projection
    }

    fn shadow_map_size(&self) -> u32 {
        self.plan.shadow_map_size
    }
}

impl ShadowMap {
    pub fn stage_scene_update(
        &self,
        frame: &FrameUniform,
        camera: CascadedShadowCamera,
        light_direction: [f32; 3],
        scene_bounds: Option<SceneWorldBounds>,
    ) -> Result<ShadowMapUpdate, String> {
        let plan =
            plan_cascaded_shadows_for_scene(camera, light_direction, self.options, scene_bounds)?;
        let sampling_data = cast_slice(&plan.uniform(DEPTH_BIAS)?).to_vec();
        let shadow_frame_data = pack_shadow_frames(frame, &plan, self.frame_stride);
        Ok(ShadowMapUpdate {
            plan,
            scene_bounds,
            sampling_data,
            shadow_frame_data,
        })
    }

    pub fn publish_scene_update(&mut self, queue: &wgpu::Queue, update: ShadowMapUpdate) {
        queue.write_buffer(&self.sampling_uniform, 0, &update.sampling_data);
        queue.write_buffer(&self.shadow_frames, 0, &update.shadow_frame_data);
        self.plan = update.plan;
        self.scene_bounds = update.scene_bounds;
    }
}
