//! 帧级 GPU 资源构造(deep2d_gpu 的 `#[path]` 子模块,体量门)。
//! path 阶段与帧 uniform 的 bind group layout + 缓存的帧 uniform 资源;
//! 纯构造函数,无状态。`path_paint_layout` 被 刀3 动态管线族共享
//! (`deep2d_dynamic_gpu` 经 `crate::deep2d_gpu::path_paint_layout` 取用)。

use bytemuck::cast_slice;
use wgpu::util::DeviceExt;

use crate::deep2d_gpu_cache::Deep2dGpuAssetCache;

/// Path-stage bind group layout: frame uniform (vertex) + paint storage
/// (fragment). Separate from the shared atlas frame layout so the atlas
/// pipeline never pays for the storage binding. 刀 3 动态 clear/fill 管线
/// 复用同一布局以共享 bind group。
pub(crate) fn path_paint_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native Deep2d paint layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    })
}

pub(super) fn frame_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native Deep2d frame layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }],
    })
}

/// Cached frame uniform buffer + bind group per logical size. The physical
/// size half of the uniform is written per draw; the initial upload assumes
/// a square-uniform mapping so a first frame without any draw still binds.
pub(super) fn frame_resources(
    device: &wgpu::Device,
    _queue: &wgpu::Queue,
    layout: &wgpu::BindGroupLayout,
    cache: &Deep2dGpuAssetCache,
    logical_size: [f32; 2],
) -> std::sync::Arc<crate::deep2d_gpu_cache::FrameResources> {
    if let Some(resources) = cache.frame_resources(logical_size[0], logical_size[1]) {
        return resources;
    }
    let frame = [[
        logical_size[0],
        logical_size[1],
        logical_size[0],
        logical_size[1],
    ]];
    let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Deep Engine native Deep2d frame"),
        contents: cast_slice(&frame),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Deep Engine native Deep2d frame bindings"),
        layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: buffer.as_entire_binding(),
        }],
    });
    cache.store_frame_resources(
        logical_size[0],
        logical_size[1],
        crate::deep2d_gpu_cache::FrameResources { buffer, bind_group },
    )
}
