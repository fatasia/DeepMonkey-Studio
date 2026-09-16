use wgpu::util::DeviceExt;

pub(super) fn create(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    frames: &wgpu::Buffer,
) -> (wgpu::Buffer, wgpu::BindGroup) {
    let section = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Native section plane"),
        contents: &[0; 16],
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Deep Engine native cascade caster bindings"),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 8,
                resource: section.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: frames,
                    offset: 0,
                    size: wgpu::BufferSize::new(deep_engine_native::mesh_abi::FRAME_UNIFORM_BYTES),
                }),
            },
        ],
    });
    (section, group)
}
