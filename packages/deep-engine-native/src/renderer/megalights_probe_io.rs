use super::*;
pub(super) async fn gpu_device() -> (wgpu::Device, wgpu::Queue) {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = match std::env::var("DEEP_MEGA_PROBE_BACKEND").as_deref() {
        Ok("dx12") => wgpu::Backends::DX12,
        _ => wgpu::Backends::VULKAN,
    };
    let instance = wgpu::Instance::new(descriptor);
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            ..Default::default()
        })
        .await
        .expect("real GPU adapter");
    adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .expect("GPU device")
}

/// 斜面光栅化管线(clip 坐标直传;depth compare always + write;4x MSAA)。
pub(super) fn plane_depth_pipeline(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
) -> (wgpu::RenderPipeline, wgpu::Buffer) {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("megalights probe plane raster"),
        source: wgpu::ShaderSource::Wgsl(
            r#"
struct PlaneVertexOutput {
  @builtin(position) position: vec4f,
};
@vertex
fn vs(@location(0) clip: vec4f) -> PlaneVertexOutput {
  return PlaneVertexOutput(clip);
}
@fragment
fn fs(_out: PlaneVertexOutput) {}
"#
            .into(),
        ),
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("megalights probe plane raster pipeline"),
        layout: None,
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vs"),
            compilation_options: Default::default(),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: 16,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x4,
                    offset: 0,
                    shader_location: 0,
                }],
            })],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format,
            depth_compare: Some(wgpu::CompareFunction::Always),
            depth_write_enabled: Some(true),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState {
            count: FORWARD_SAMPLE_COUNT,
            ..Default::default()
        },
        multiview_mask: None,
        cache: None,
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs"),
            compilation_options: Default::default(),
            targets: &[],
        }),
    });
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("megalights probe plane vertices"),
        size: 6 * 16,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    (pipeline, buffer)
}

pub(super) fn readback_buffer(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    buffer: &wgpu::Buffer,
    words: usize,
) -> Vec<f32> {
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("megalights production readback"),
        size: (words * 4) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(buffer, 0, &staging, 0, (words * 4) as u64);
    queue.submit(Some(encoder.finish()));
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    staging.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("poll");
    receiver.recv().expect("map callback").expect("map");
    let mapped = staging.get_mapped_range(..).expect("mapped");
    mapped
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
        .collect()
}

/// rgba16float 纹理读回(行距 256B 对齐;f16 → f32)。
pub(super) fn readback_hdr(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
) -> Vec<f32> {
    let bytes_per_row = (WIDTH * 8).next_multiple_of(256);
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("megalights production hdr readback"),
        size: bytes_per_row as u64 * HEIGHT as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &staging,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(HEIGHT),
            },
        },
        wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
    );
    queue.submit(Some(encoder.finish()));
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    staging.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("poll");
    receiver.recv().expect("map callback").expect("map");
    let mapped = staging.get_mapped_range(..).expect("mapped");
    let mut words = Vec::with_capacity(PIXELS * 4);
    for py in 0..HEIGHT as usize {
        let row = &mapped[py * bytes_per_row as usize..(py + 1) * bytes_per_row as usize];
        for chunk in row[..WIDTH as usize * 8].chunks_exact(2) {
            words.push(f16_to_f32(u16::from_le_bytes(chunk.try_into().unwrap())));
        }
    }
    words
}

pub(super) fn f32_to_f16_bits(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let biased = ((bits >> 23) & 0xff) as i32;
    let mantissa = bits & 0x7f_ffff;
    if biased == 0xff {
        return sign | 0x7c00 | u16::from(mantissa != 0);
    }
    let exponent = biased - 127;
    if exponent > 15 {
        return sign | 0x7c00;
    }
    if exponent >= -14 {
        let half_mantissa = mantissa >> 13;
        let residue = mantissa & 0x1fff;
        let mut half = (((exponent + 15) as u16) << 10) | half_mantissa as u16;
        if residue > 0x1000 || (residue == 0x1000 && (half_mantissa & 1) == 1) {
            half += 1;
        }
        return sign | half;
    }
    // 次正规 f16(探针种子不落入;合同完备性保留)。
    let shift = (13 + (-exponent - 14)) as u32;
    let full = mantissa | 0x80_0000;
    let half = (full >> shift) as u16;
    let residue = full & ((1u32 << shift) - 1);
    let threshold = 1u32 << (shift - 1);
    if residue > threshold || (residue == threshold && (half & 1) == 1) {
        return sign | (half + 1);
    }
    sign | half
}

pub(super) fn f16_to_f32(bits: u16) -> f32 {
    let sign = if bits & 0x8000 != 0 { -1.0f32 } else { 1.0 };
    let exponent = ((bits >> 10) & 0x1f) as i32;
    let mantissa = f64::from(bits & 0x3ff);
    let value = match exponent {
        0 => mantissa * f64::powi(2.0, -24),
        31 => f64::INFINITY,
        _ => (1.0 + mantissa / 1024.0) * f64::powi(2.0, exponent - 15),
    };
    (sign as f64 * value) as f32
}

pub(super) fn encode_f16_words(words: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(words.len() * 2);
    for word in words {
        bytes.extend_from_slice(&f32_to_f16_bits(*word).to_le_bytes());
    }
    bytes
}
