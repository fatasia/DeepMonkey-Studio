use std::sync::Arc;

use bytemuck::cast_slice;
use deep_engine_native::{
    bloom::BloomSettings, fog::FogSettings, mesh_abi::FrameUniform,
    pbr_texture::PreparedPbrSummary, shadow_cache::ShadowVersion,
};
use winit::{dpi::PhysicalSize, event_loop::EventLoopProxy, window::Window};

use crate::{
    bloom_pass::{BloomPass, BloomTargets},
    deep2d_gpu::Deep2dGpuPainter,
    events::GpuEvent,
    forward_targets::ForwardTargets,
    gpu_culling::{GpuCulling, GpuCullingSummary},
    gpu_ibl::GpuIblEnvironment,
    gpu_lod::GpuLod,
    gpu_resources::update_shadow_map,
    gpu_scene::GpuScene,
    gpu_scene_cache::GpuSceneCache,
    gpu_submission::GpuFailures,
    ibl_probe::IblProbe,
    output_pass::OutputPass,
    pipeline::MeshPipelines,
    player_content::PlayerContent,
    player_state::PlayerView,
    shadow_dirty::{ShadowCascadeKey, ShadowCasterSet, ShadowDirtyCache, ShadowDirtyEvidence},
    shadow_map::{CascadedShadowGpuMetrics, ShadowMap},
    shadow_probe::ShadowProbe,
};

mod content_profile;
mod diagnostics;
pub(crate) use content_profile::ContentProfileReport;
pub(crate) use content_profile::entry_bloom;
#[cfg(all(test, target_os = "windows"))]
mod content_profile_gpu_tests;
#[cfg(all(test, target_os = "windows"))]
mod coordinate_frame_gpu_tests;
#[cfg(test)]
mod environment_probe_tests;
mod environment_update;
mod frame;
mod frame_probes;
mod frame_target;
mod hi_z_pyramid;
#[cfg(test)]
mod hi_z_pyramid_tests;
mod init;
mod init_report;
mod material_resource_diff;
#[cfg(all(test, target_os = "windows"))]
mod material_uniform_fastpath_gpu_tests;
mod replacement_present;
mod scene_instance_diff;
#[cfg(all(test, target_os = "windows"))]
mod scene_incremental_fastpath_gpu_tests;
pub(crate) mod scene_update;
mod scene_update_stage;
mod section_readback;
#[cfg(all(test, target_os = "windows"))]
mod solid_environment_tests;
pub(crate) use section_readback::SectionReadback;

#[derive(Clone, Copy)]
pub struct RendererFeatures {
    pub bloom: BloomSettings,
    pub fog: FogSettings,
    pub shadow_probe: bool,
    pub ibl_probe: bool,
    /// Opt-in segmented frame telemetry; off by default with zero frame cost.
    pub telemetry: bool,
}

pub struct Renderer {
    lighting: Option<deep_engine_native::scene_lighting::DirectionalLighting>,
    id: u64,
    instance: wgpu::Instance,
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    failures: GpuFailures,
    config: wgpu::SurfaceConfiguration,
    size: PhysicalSize<u32>,
    pipelines: MeshPipelines,
    material_layout: wgpu::BindGroupLayout,
    _scene_cache: GpuSceneCache,
    scene: GpuScene,
    culling: GpuCulling,
    lod: Option<GpuLod>,
    deep2d: Option<Deep2dGpuPainter>,
    frame_buffer: wgpu::Buffer,
    frame_layout: wgpu::BindGroupLayout,
    frame_bind_group: wgpu::BindGroup,
    shadow_map: ShadowMap,
    ibl: GpuIblEnvironment,
    shadow_cache: ShadowDirtyCache,
    shadow_casters: ShadowCasterSet,
    shadow_keys: Vec<ShadowCascadeKey>,
    shadow_shader_key: u64,
    last_shadow_evidence: ShadowDirtyEvidence,
    shadow_version: ShadowVersion,
    shadow_probe: Option<ShadowProbe>,
    last_shadow_probe: Option<crate::shadow_probe::ShadowProbeMetrics>,
    ibl_probe: Option<IblProbe>,
    forward_targets: ForwardTargets,
    /// R4 生产接线:主视锥 HiZ 金字塔(显式开关,默认关)。
    hi_z: Option<hi_z_pyramid::HiZPyramid>,
    bloom: Option<BloomPass>,
    output_pass: OutputPass,
    frame: FrameUniform,
    fog: FogSettings,
    yaw: f32,
    view: PlayerView,
    telemetry: Option<crate::telemetry::FrameTelemetry>,
    diagnostics: crate::player_diagnostics::PlayerDiagnostics,
    /// 构造期固定分配档位；resize沿用同一档位，内容跨档由完整重建处理。
    content_profile: crate::renderer::ContentProfileReport,
}

impl Renderer {
    pub fn render(&mut self, verify_submission: bool) -> crate::events::RenderOutcome {
        self.render_internal(verify_submission, true)
    }
    pub async fn new(
        window: Arc<Window>,
        proxy: EventLoopProxy<GpuEvent>,
        renderer_id: u64,
        content: &PlayerContent,
        view: PlayerView,
        features: RendererFeatures,
    ) -> Result<Self, String> {
        init::create_renderer(window, proxy, renderer_id, content, view, features, true).await
    }

    pub(crate) async fn new_candidate(
        window: Arc<Window>,
        proxy: EventLoopProxy<GpuEvent>,
        renderer_id: u64,
        content: &PlayerContent,
        view: PlayerView,
        features: RendererFeatures,
    ) -> Result<Self, String> {
        init::create_renderer(window, proxy, renderer_id, content, view, features, false).await
    }

    pub(crate) fn activate_surface(&self) {
        self.surface.configure(&self.device, &self.config);
    }

    pub fn resize(&mut self, size: PhysicalSize<u32>) -> Result<(), String> {
        if size == self.size {
            return Ok(());
        }
        if size.width == 0 || size.height == 0 {
            self.size = size;
            return Ok(());
        }
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let mut next_forward = ForwardTargets::new(
            &self.device,
            content_profile::forward_size(self.content_profile.compact_forward_targets, size),
        );
        let next_bloom: Option<BloomTargets> = self
            .bloom
            .as_ref()
            .map(|bloom| bloom.prepare_resize(&self.device, &next_forward.hdr_view, size));
        let next_output = self
            .output_pass
            .prepare_rebind(
                &self.device,
                &next_forward.hdr_view,
                next_bloom.as_ref().map(BloomTargets::output_view),
                self.fog
                    .requires_output_pass()
                    .then_some((&next_forward.depth_view, &self.frame_buffer)),
            )
            .expect("renderer bloom mode remains stable during resize");
        let gpu_errors = [
            pollster::block_on(internal.pop()),
            pollster::block_on(memory.pop()),
            pollster::block_on(validation.pop()),
        ];
        if let Some(error) = gpu_errors.into_iter().flatten().next() {
            return Err(format!(
                "native HDR/Bloom resize transaction rejected: {error}"
            ));
        }
        self.size = size;
        self.config.width = size.width;
        self.config.height = size.height;
        self.surface.configure(&self.device, &self.config);
        next_forward.background = self.forward_targets.background;
        self.forward_targets = next_forward;
        // HiZ 金字塔跟随前向目标尺寸重建;遮挡判定/消费链按新源重挂
        // (OcclusionSource 的尺寸与 mip 视图随金字塔实例固定)。
        self.hi_z = self.rebuild_hi_z()?;
        if let (Some(bloom), Some(targets)) = (&mut self.bloom, next_bloom) {
            bloom.publish_resize(targets);
        }
        self.output_pass.publish_rebind(next_output);
        self.frame = crate::gpu_resources::frame_data_with_camera(size, self.view, self.fog);
        if let Some(lighting) = &self.lighting {
            lighting.apply(&mut self.frame);
        }
        update_shadow_map(
            &mut self.shadow_map,
            &self.queue,
            size,
            &self.frame,
            self.view,
        )
        .expect("validated CSM must update after resize");
        self.culling
            .update_views(&self.queue, &self.frame, &self.shadow_map)
            .expect("validated GPU culling views must update after resize");
        self.shadow_version.bump_light();
        if self.shadow_probe.is_some() {
            self.shadow_probe = Some(ShadowProbe::new(
                &self.device,
                &self.frame_layout,
                &self.shadow_map,
                &self.frame_buffer,
                &self.ibl,
                size,
            ));
        }
        if self.ibl_probe.is_some() {
            self.ibl_probe = Some(
                IblProbe::new(
                    &self.device,
                    &self.queue,
                    &self.frame_layout,
                    &self.shadow_map,
                    &self.frame_buffer,
                    size,
                )
                .expect("validated built-in IBL must rebuild after resize"),
            );
        }
        if let Some(lod) = &mut self.lod {
            lod.update_views(
                &self.queue,
                &self.frame,
                self.size,
                &self.shadow_map,
                self.view.near,
            )
            .expect("validated GPU LOD views remain valid after camera or surface change");
        }
        self.shadow_keys = self
            .shadow_casters
            .keys(&self.shadow_map, self.shadow_shader_key)?;
        // resize 保留阴影纹理；方向级联保持旧刷新策略，世界固定聚光视图可继续复用。
        self.shadow_cache
            .invalidate_directional(self.shadow_map.cascade_count() as usize);
        self.queue
            .write_buffer(&self.frame_buffer, 0, cast_slice(&self.frame));
        if let Some(telemetry) = self.telemetry.as_mut() {
            telemetry.reset_barrier();
        }
        Ok(())
    }

    /// 按当前前向目标尺寸重建 HiZ 金字塔并把遮挡判定/消费链重挂到新源
    /// (resize 路径;开关关闭时返回 None)。事务失败整体报错,不留半挂载。
    fn rebuild_hi_z(&mut self) -> Result<Option<hi_z_pyramid::HiZPyramid>, String> {
        if !hi_z_pyramid::occlusion_hiz_enabled() {
            return Ok(None);
        }
        let pyramid = hi_z_pyramid::HiZPyramid::new(
            &self.device,
            &self.queue,
            &self.forward_targets.depth_view,
            self.forward_targets.width(),
            self.forward_targets.height(),
        )?;
        self.culling.attach_occlusion(
            &self.device,
            &self.scene.instance_buffer,
            pyramid.occlusion_source(),
            &self.frame,
            true,
        )?;
        self.culling
            .attach_occlusion_consume(&self.device, &self.scene.instance_buffer, false)?;
        Ok(Some(pyramid))
    }

    pub fn set_view(&mut self, view: PlayerView) {
        if view == self.view {
            return;
        }
        if view.clipping != self.view.clipping {
            self.queue.write_buffer(
                &self.shadow_map.section_uniform,
                0,
                cast_slice(&view.clipping),
            );
            self.shadow_cache.invalidate();
        }
        self.yaw = view.yaw;
        self.view = view;
        self.shadow_version.bump_light();
        self.frame = crate::gpu_resources::frame_data_with_camera(self.size, self.view, self.fog);
        if let Some(lighting) = &self.lighting {
            lighting.apply(&mut self.frame);
        }
        update_shadow_map(
            &mut self.shadow_map,
            &self.queue,
            self.size,
            &self.frame,
            self.view,
        )
        .expect("validated CSM must update after camera rotation");
        self.culling
            .update_views(&self.queue, &self.frame, &self.shadow_map)
            .expect("validated GPU culling views must update after camera rotation");
        if let Some(lod) = &mut self.lod {
            lod.update_views(
                &self.queue,
                &self.frame,
                self.size,
                &self.shadow_map,
                self.view.near,
            )
            .expect("validated GPU LOD views remain valid after camera or surface change");
        }
        self.shadow_keys = self
            .shadow_casters
            .keys(&self.shadow_map, self.shadow_shader_key)
            .expect("validated caster set must remain finite after camera update");
        self.queue
            .write_buffer(&self.frame_buffer, 0, cast_slice(&self.frame));
    }
}
