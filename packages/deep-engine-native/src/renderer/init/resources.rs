use crate::{
    frame_bindings::create_native_mesh_shader,
    gpu_resources::{create_shadow_map, shadow_camera, shadow_ray_direction},
    pipeline::{MeshPipelines, create_mesh_pipelines},
    player_state::PlayerView,
    shadow_map::ShadowMap,
};
use deep_engine_native::{mesh_abi::FrameUniform, scene_bounds::SceneWorldBounds};
use winit::dpi::PhysicalSize;

pub(super) fn shadow_map(
    device: &wgpu::Device,
    shadow_frame_layout: &wgpu::BindGroupLayout,
    size: PhysicalSize<u32>,
    frame: &FrameUniform,
    scene_bounds: Option<SceneWorldBounds>,
    view: PlayerView,
    compact_content: bool,
) -> Result<ShadowMap, String> {
    if compact_content {
        crate::shadow_map::ShadowMap::new_with_options(
            device,
            shadow_frame_layout,
            frame,
            shadow_camera(size, frame, view),
            shadow_ray_direction(frame),
            scene_bounds,
            crate::renderer::content_profile::shadow_options(true),
        )
    } else {
        create_shadow_map(device, shadow_frame_layout, size, frame, scene_bounds, view)
    }
}

pub(super) fn pipelines(
    device: &wgpu::Device,
    frame_layout: &wgpu::BindGroupLayout,
    shadow_frame_layout: &wgpu::BindGroupLayout,
    material_layout: &wgpu::BindGroupLayout,
    compact_content: bool,
) -> MeshPipelines {
    if compact_content {
        crate::pipeline::MeshPipelines::for_empty_scene()
    } else {
        let shader = create_native_mesh_shader(device);
        create_mesh_pipelines(
            device,
            frame_layout,
            shadow_frame_layout,
            material_layout,
            &shader,
        )
    }
}

pub(super) fn frame_buffer(device: &wgpu::Device, frame: &FrameUniform) -> wgpu::Buffer {
    use wgpu::util::DeviceExt;
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Deep Engine native frame"),
        contents: bytemuck::cast_slice(frame),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    })
}

pub(super) fn deep2d(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    format: wgpu::TextureFormat,
    display_list: Option<&deep_engine_native::deep2d::Deep2dRuntimeContent>,
) -> Result<Option<crate::deep2d_gpu::Deep2dGpuPainter>, String> {
    display_list
        .map(|display_list| {
            let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
            crate::deep2d_gpu::Deep2dGpuPainter::new(device, queue, format, display_list, &cache)
        })
        .transpose()
}
