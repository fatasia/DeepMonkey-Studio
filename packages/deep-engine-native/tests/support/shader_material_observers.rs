use super::{PlayerContent, render_observed};
use crate::{
    forward_targets::ForwardTargets,
    gpu_culling::GpuCulling,
    gpu_lod::GpuLod,
    gpu_resources::{frame_data, frame_data_with_camera},
    gpu_scene::GpuScene,
    pipeline::MeshPipelines,
};
use deep_engine_native::{fog::FogSettings, mesh_abi::FrameUniform, player_view::PlayerView};
use winit::dpi::PhysicalSize;

#[allow(clippy::too_many_arguments)]
pub(super) fn encode_frame(
    encoder: &mut wgpu::CommandEncoder,
    targets: &ForwardTargets,
    frame_group: &wgpu::BindGroup,
    scene: &GpuScene,
    culling: &GpuCulling,
    lod: Option<&GpuLod>,
    pipelines: &MeshPipelines,
    retain_depth: bool,
) {
    if !retain_depth {
        crate::mesh_pass::encode_mesh_passes(
            encoder,
            targets,
            frame_group,
            scene,
            culling,
            lod,
            pipelines,
            0.0,
        );
        return;
    }
    crate::mesh_pass::encode_opaque_pass(
        encoder,
        targets,
        frame_group,
        scene,
        culling,
        lod,
        pipelines,
        true,
    );
    crate::mesh_pass::encode_transparent_pass(
        encoder,
        targets,
        frame_group,
        scene,
        culling,
        lod,
        pipelines,
        0.0,
    );
}

pub struct FrameObservation<'a> {
    pub capture_normals: bool,
    pub size: PhysicalSize<u32>,
    pub view: PlayerView,
    pub configure: Option<&'a dyn Fn(&mut FrameUniform)>,
    pub encode:
        &'a mut dyn FnMut(&wgpu::Device, &mut wgpu::CommandEncoder, &ForwardTargets, &FrameUniform),
}

pub(super) fn frame_parameters(
    observation: Option<&FrameObservation<'_>>,
) -> (PhysicalSize<u32>, FrameUniform, PlayerView) {
    match observation {
        Some(observed) => {
            let mut frame =
                frame_data_with_camera(observed.size, observed.view, FogSettings::DISABLED);
            if let Some(configure) = observed.configure {
                configure(&mut frame);
            }
            (observed.size, frame, observed.view)
        }
        None => {
            let size = PhysicalSize::new(256, 256);
            (size, frame_data(size, 0.0), PlayerView::default())
        }
    }
}

pub async fn render_with_frame_observation(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    content: &PlayerContent,
    observation: &mut FrameObservation<'_>,
) -> Snapshot {
    render_observed(device, queue, content, false, None, None, Some(observation))
        .await
        .0
}

pub struct Snapshot {
    pub hdr: Vec<u8>,
    pub depths: Vec<f32>,
    pub commands: Vec<Vec<[u32; 5]>>,
    pub shadow_size: u32,
    pub nonzero_vertex_offsets: usize,
}

#[derive(Debug, Default, Clone)]
pub struct ShaderMaterialReport {
    pub isolated: Vec<String>,
    pub fallback_materials: usize,
    pub custom_materials: usize,
}

pub async fn render_reported(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    content: &PlayerContent,
    reuse_first_cascade: bool,
    foreign_device: Option<&wgpu::Device>,
) -> (Snapshot, ShaderMaterialReport) {
    render_observed(
        device,
        queue,
        content,
        reuse_first_cascade,
        foreign_device,
        None,
        None,
    )
    .await
}

/// Observes real readback before GpuScene/shadows/targets/pipelines/culling/LOD leave scope.
pub async fn render_with_live_components(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    content: &PlayerContent,
    observer: &mut dyn FnMut(&Snapshot),
) -> Snapshot {
    render_observed(device, queue, content, false, None, Some(observer), None)
        .await
        .0
}
