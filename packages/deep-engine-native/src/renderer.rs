use std::sync::Arc;

use bytemuck::cast_slice;
use deep_engine_native::{
    bloom::BloomSettings,
    ibl::IblSummary,
    mesh_abi::FrameUniform,
    pbr_texture::PreparedPbrSummary,
    shadow_cache::{ShadowCache, ShadowVersion},
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
    gpu_resources::{frame_data, update_shadow_map},
    gpu_scene::GpuScene,
    gpu_scene_cache::GpuSceneCache,
    gpu_submission::GpuFailures,
    ibl_probe::IblProbe,
    output_pass::OutputPass,
    pipeline::MeshPipelines,
    player_content::PlayerContent,
    player_state::PlayerView,
    shadow_map::{CascadedShadowGpuMetrics, ShadowMap},
    shadow_probe::ShadowProbe,
};

mod frame;
mod init;
pub(crate) mod scene_update;

#[derive(Clone, Copy)]
pub struct RendererFeatures {
    pub bloom: BloomSettings,
    pub shadow_probe: bool,
    pub ibl_probe: bool,
}

pub struct Renderer {
    id: u64,
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    failures: GpuFailures,
    config: wgpu::SurfaceConfiguration,
    size: PhysicalSize<u32>,
    pipelines: MeshPipelines,
    #[allow(dead_code)] // Owned for the packet-update entrypoint before live reload wiring lands.
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
    shadow_cache: ShadowCache,
    shadow_version: ShadowVersion,
    shadow_probe: Option<ShadowProbe>,
    last_shadow_probe: Option<crate::shadow_probe::ShadowProbeMetrics>,
    ibl_probe: Option<IblProbe>,
    forward_targets: ForwardTargets,
    bloom: Option<BloomPass>,
    output_pass: OutputPass,
    frame: FrameUniform,
    yaw: f32,
}

impl Renderer {
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn deep2d_summary(
        &self,
    ) -> Option<deep_engine_native::deep2d::PreparedDeep2dRuntimeSummary> {
        self.deep2d.as_ref().map(|painter| painter.summary)
    }

    pub fn pbr_summary(&self) -> (PreparedPbrSummary, usize) {
        (
            self.scene.pbr_summary(),
            self.scene.resident_texture_count(),
        )
    }

    pub fn alpha_summary(&self) -> deep_engine_native::scene::SceneAlphaSummary {
        self.scene.alpha_summary()
    }

    pub fn ibl_summary(&self) -> (&str, u32, IblSummary) {
        (&self.ibl.id, self.ibl.revision, self.ibl.summary)
    }

    pub fn shadow_summary(&self) -> CascadedShadowGpuMetrics {
        self.shadow_map.metrics()
    }

    pub fn culling_summary(&self) -> GpuCullingSummary {
        self.culling.summary()
    }

    pub async fn new(
        window: Arc<Window>,
        proxy: EventLoopProxy<GpuEvent>,
        renderer_id: u64,
        content: &PlayerContent,
        view: PlayerView,
        features: RendererFeatures,
    ) -> Result<Self, String> {
        init::create_renderer(window, proxy, renderer_id, content, view, features).await
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
        let next_forward = ForwardTargets::new(&self.device, size);
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
        self.forward_targets = next_forward;
        if let (Some(bloom), Some(targets)) = (&mut self.bloom, next_bloom) {
            bloom.publish_resize(targets);
        }
        self.output_pass.publish_rebind(next_output);
        self.frame = frame_data(size, self.yaw);
        update_shadow_map(&mut self.shadow_map, &self.queue, size, &self.frame)
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
            lod.update_views(&self.queue, &self.frame, self.size, &self.shadow_map)
                .expect("validated GPU LOD views remain valid after camera or surface change");
        }
        self.queue
            .write_buffer(&self.frame_buffer, 0, cast_slice(&self.frame));
        Ok(())
    }

    pub fn set_view(&mut self, view: PlayerView) {
        if view.yaw.to_bits() == self.yaw.to_bits() {
            return;
        }
        self.yaw = view.yaw;
        self.shadow_version.bump_light();
        self.frame = frame_data(self.size, self.yaw);
        update_shadow_map(&mut self.shadow_map, &self.queue, self.size, &self.frame)
            .expect("validated CSM must update after camera rotation");
        self.culling
            .update_views(&self.queue, &self.frame, &self.shadow_map)
            .expect("validated GPU culling views must update after camera rotation");
        if let Some(lod) = &mut self.lod {
            lod.update_views(&self.queue, &self.frame, self.size, &self.shadow_map)
                .expect("validated GPU LOD views remain valid after camera or surface change");
        }
        self.queue
            .write_buffer(&self.frame_buffer, 0, cast_slice(&self.frame));
    }
}
