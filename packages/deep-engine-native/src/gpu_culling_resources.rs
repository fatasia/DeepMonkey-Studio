use wgpu::util::DeviceExt;

use deep_engine_native::culling_contract::{
    GPU_CULLING_FRUSTUM_BYTES, GPU_CULLING_INDIRECT_BYTES, GPU_CULLING_INSTANCE_BYTES,
    GPU_CULLING_WORKGROUP_SIZE,
};

pub fn storage_init(device: &wgpu::Device, label: &str, contents: &[u8]) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents,
        usage: wgpu::BufferUsages::STORAGE,
    })
}

pub fn create_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    let entry = |binding, read_only| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    };
    let uniform = wgpu::BindGroupLayoutEntry {
        binding: 3,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: wgpu::BufferSize::new(GPU_CULLING_FRUSTUM_BYTES),
        },
        count: None,
    };
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native GPU culling layout"),
        entries: &[
            entry(0, true),
            entry(1, true),
            entry(2, true),
            uniform,
            entry(4, false),
            entry(5, false),
        ],
    })
}

#[allow(clippy::too_many_arguments)]
pub fn create_bind_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    source: &wgpu::Buffer,
    bounds: &wgpu::Buffer,
    metadata: &wgpu::Buffer,
    frustum: &wgpu::Buffer,
    visible: &wgpu::Buffer,
    indirect: &wgpu::Buffer,
) -> wgpu::BindGroup {
    fn entry(binding: u32, buffer: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
        wgpu::BindGroupEntry {
            binding,
            resource: buffer.as_entire_binding(),
        }
    }
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Deep Engine native GPU culling bindings"),
        layout,
        entries: &[
            entry(0, source),
            entry(1, bounds),
            entry(2, metadata),
            entry(3, frustum),
            entry(4, visible),
            entry(5, indirect),
        ],
    })
}

pub fn validate_device(
    device: &wgpu::Device,
    candidates: u32,
    batches: u32,
    views: usize,
) -> Result<(), String> {
    let limits = device.limits();
    let workgroups = candidates.div_ceil(GPU_CULLING_WORKGROUP_SIZE);
    let instance_bytes = u64::from(candidates.max(1)) * GPU_CULLING_INSTANCE_BYTES;
    let indirect_bytes = u64::from(batches.max(1)) * GPU_CULLING_INDIRECT_BYTES;
    let largest_storage = instance_bytes.max(indirect_bytes);
    if limits.max_storage_buffers_per_shader_stage < 5
        || workgroups > limits.max_compute_workgroups_per_dimension
        || largest_storage > limits.max_storage_buffer_binding_size
        || largest_storage > limits.max_buffer_size
        || views == 0
    {
        return Err("native GPU culling requirements exceed device limits".into());
    }
    Ok(())
}
