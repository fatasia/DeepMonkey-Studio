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
    layered_material_layout: Option<&wgpu::BindGroupLayout>,
    layered_materials: bool,
    compact_content: bool,
) -> MeshPipelines {
    if compact_content {
        crate::pipeline::MeshPipelines::for_empty_scene()
    } else {
        let shader = create_native_mesh_shader(device);
        match (layered_material_layout, layered_materials) {
            (Some(layered_layout), true) => crate::pipeline::create_mesh_pipelines_with_layered(
                device,
                frame_layout,
                shadow_frame_layout,
                material_layout,
                layered_layout,
                &shader,
            ),
            // 无分层材质:不建分层管线族(管线预算与普通路径不变)。
            _ => create_mesh_pipelines(
                device,
                frame_layout,
                shadow_frame_layout,
                material_layout,
                &shader,
            ),
        }
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

/// Start only the admitted scene variants before texture hashing/upload, so
/// browser driver compilation overlaps CPU resource preparation.
pub(super) fn prewarm_used_pipelines(pipelines: &MeshPipelines,
    scene: &deep_engine_native::scene::PreparedScene,
    pbr: &deep_engine_native::pbr_texture::PreparedPbrResources<'_>) {
    for batch in &scene.batches {
        let material = &pbr.materials[batch.material_index];
        if material.layered.is_some() && pipelines.select_layered(batch.alpha_mode,
            batch.premultiplied, batch.mirrored, batch.double_sided, material.normal_mapped).is_some() { continue; }
        pipelines.select_profile(batch.alpha_mode, batch.premultiplied, batch.mirrored,
            batch.double_sided, material.normal_mapped, material.uses_extended_response());
    }
}

/// E02 IES 打包(纯 CPU;与 GPU buffer 同源,供 megaLights 行重映射复用)。
pub(super) fn ies_resource(
    lighting: Option<&deep_engine_native::scene_lighting::DirectionalLighting>,
) -> Result<deep_engine_native::ies_shading::NativeIesShadingResource, String> {
    let empty: [deep_engine_native::local_lighting::LocalLight; 0] = [];
    deep_engine_native::ies_shading::NativeIesShadingResource::prepare(
        lighting.map_or(&empty, |value| value.local_lights.as_slice()),
        lighting.and_then(|value| value.light_profiles.as_deref()),
    )
}

pub(super) fn ies_buffer(
    device: &wgpu::Device,
    resource: &deep_engine_native::ies_shading::NativeIesShadingResource,
) -> wgpu::Buffer {
    use wgpu::util::DeviceExt;
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Deep Engine native IES shading"),
        contents: resource.bytes(),
        usage: wgpu::BufferUsages::STORAGE,
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
