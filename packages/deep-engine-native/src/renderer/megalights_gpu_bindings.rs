use super::*;

/// 重建/合成共用绑定面形状:uniform(0)+ 纹理或只读 storage(1)+ 可写 storage(2)。
pub(super) fn storage_layout(
    device: &wgpu::Device,
    label: &str,
    middle_visibility: wgpu::ShaderStages,
    middle_ty: wgpu::BindingType,
) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some(label),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: middle_visibility,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: middle_visibility,
                ty: middle_ty,
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    })
}

/// RIS 绑定组条目(auto 布局按 entrypoint 反射触达;probe 真机腿同面):
/// build 趟 = 0-5,8(不触颜色历史),shade 趟 = 0-2,4-8。
#[allow(clippy::too_many_arguments)]
pub(super) fn compute_entries<'a>(
    params: &'a wgpu::Buffer,
    lights: &'a wgpu::Buffer,
    surfaces: &'a wgpu::Buffer,
    motion: &'a wgpu::Buffer,
    reservoirs_a: &'a wgpu::Buffer,
    reservoirs_b: &'a wgpu::Buffer,
    color: &'a wgpu::Buffer,
    color_history: &'a wgpu::Buffer,
    ies: &'a wgpu::Buffer,
    visibility: &'a wgpu::Buffer,
    build: bool,
) -> Vec<wgpu::BindGroupEntry<'a>> {
    let e = |binding: u32, buffer: &'a wgpu::Buffer| wgpu::BindGroupEntry {
        binding,
        resource: buffer.as_entire_binding(),
    };
    if build {
        vec![
            e(0, params),
            e(1, lights),
            e(2, surfaces),
            e(3, motion),
            e(4, reservoirs_a),
            e(5, reservoirs_b),
            e(8, ies),
        ]
    } else {
        vec![
            e(0, params),
            e(1, lights),
            e(2, surfaces),
            e(4, reservoirs_a),
            e(5, reservoirs_b),
            e(6, color),
            e(7, color_history),
            e(8, ies),
            e(9, visibility),
        ]
    }
}

/// 缓冲整段清零(扩容后尾域确定性;一次性成本)。
pub(super) fn queue_zero(device: &wgpu::Device, queue: &wgpu::Queue, buffer: &wgpu::Buffer) {
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.clear_buffer(buffer, 0, Some(buffer.size()));
    queue.submit(Some(encoder.finish()));
}
