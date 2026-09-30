pub fn encode(
    device: &wgpu::Device,
    encoder: &mut wgpu::CommandEncoder,
    depth: &wgpu::TextureView,
    width: u32,
    height: u32,
) -> wgpu::Buffer {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Gate D production main MSAA depth observation"),
        source: wgpu::ShaderSource::Wgsl(
            r#"
@group(0) @binding(0) var depth: texture_depth_multisampled_2d;
@group(0) @binding(1) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(depth);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let xy = vec2i(id.xy);
  result[id.y * size.x + id.x] = vec4f(textureLoad(depth, xy, 0u), textureLoad(depth, xy, 1u),
    textureLoad(depth, xy, 2u), textureLoad(depth, xy, 3u));
}"#
            .into(),
        ),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: None,
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let bytes = u64::from(width) * u64::from(height) * 16;
    let storage = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Gate D main depth observation"),
        size: bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(depth),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: storage.as_entire_binding(),
            },
        ],
    });
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
    }
    let read = crate::lod_draw_readback::staging(device, bytes);
    encoder.copy_buffer_to_buffer(&storage, 0, &read, 0, bytes);
    read
}
