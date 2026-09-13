use std::{sync::mpsc, time::Duration};

pub fn mapped_bytes(device: &wgpu::Device, buffer: &wgpu::Buffer) -> Vec<u8> {
    let (sender, receiver) = mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(5)),
        })
        .expect("GPU submission completion");
    receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("GPU mapping callback timed out")
        .expect("GPU readback mapping");
    let bytes = buffer.get_mapped_range(..).unwrap().to_vec();
    buffer.unmap();
    bytes
}

pub fn staging(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("LOD draw verification readback"),
        size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    })
}

pub fn copy_hdr(
    device: &wgpu::Device,
    encoder: &mut wgpu::CommandEncoder,
    texture: &wgpu::Texture,
) -> wgpu::Buffer {
    let buffer = staging(
        device,
        u64::from(texture.width()) * u64::from(texture.height()) * 8,
    );
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(texture.width() * 8),
                rows_per_image: Some(texture.height()),
            },
        },
        texture.size(),
    );
    buffer
}

pub fn extract_depth(
    device: &wgpu::Device,
    encoder: &mut wgpu::CommandEncoder,
    view: &wgpu::TextureView,
    size: u32,
    layers: u32,
) -> wgpu::Buffer {
    // Read the production depth attachment through its public sampling view.
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("CSM attachment depth readback"),
        source: wgpu::ShaderSource::Wgsl(
            r#"
@group(0) @binding(0) var depth: texture_depth_2d_array;
@group(0) @binding(1) var<storage, read_write> values: array<f32>;
@compute @workgroup_size(8, 8, 1)
fn read_depth(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(depth);
    if (id.x >= size.x || id.y >= size.y || id.z >= textureNumLayers(depth)) { return; }
    values[(id.z * size.y + id.y) * size.x + id.x] = textureLoad(depth, vec2i(id.xy), i32(id.z), 0);
}
"#
            .into(),
        ),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: None,
        layout: None,
        module: &module,
        entry_point: Some("read_depth"),
        compilation_options: Default::default(),
        cache: None,
    });
    let bytes = u64::from(size).pow(2) * u64::from(layers) * 4;
    let storage = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("CSM depth copy storage"),
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
                resource: wgpu::BindingResource::TextureView(view),
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
        pass.dispatch_workgroups(size.div_ceil(8), size.div_ceil(8), layers);
    }
    let result = staging(device, bytes);
    encoder.copy_buffer_to_buffer(&storage, 0, &result, 0, bytes);
    result
}
