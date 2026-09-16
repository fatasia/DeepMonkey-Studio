use std::sync::mpsc;

use deep_engine_native::deep2d::decode_runtime_content;

use crate::deep2d_gpu::Deep2dGpuPainter;

const WIDTH: u32 = 4;
const HEIGHT: u32 = 1;
const ROW_BYTES: u32 = 256;
const EXPECTED: [[u8; 4]; 4] = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 0, 255],
];

pub fn run() -> Result<(), String> {
    pollster::block_on(run_async())
}

async fn run_async() -> Result<(), String> {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            ..Default::default()
        })
        .await
        .map_err(|error| format!("Vulkan adapter request failed: {error}"))?;
    let info = adapter.get_info();
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("Deep2d interleaved readback probe"),
            ..Default::default()
        })
        .await
        .map_err(|error| format!("GPU device request failed: {error}"))?;
    let content = decode_runtime_content(include_bytes!(
        "../fixtures/deep2d_runtime_interleaved_v2.json"
    ))?;
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let result = draw_and_readback(&device, &queue, &content);
    let gpu_errors = [
        internal_scope.pop().await,
        memory_scope.pop().await,
        validation_scope.pop().await,
    ];
    if let Some(error) = gpu_errors.into_iter().flatten().next() {
        return Err(format!(
            "Deep2d interleaved GPU transaction rejected: {error}"
        ));
    }
    let pixels = result?;
    if pixels != EXPECTED {
        return Err(format!(
            "Deep2d interleaved pixels differ: expected {EXPECTED:?}, received {pixels:?}"
        ));
    }
    println!(
        "Deep2d interleaved readback OK: backend={:?} adapter={:?} order=path-image-path-glyph pixels={pixels:?}",
        info.backend, info.name
    );
    Ok(())
}

fn draw_and_readback(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    content: &deep_engine_native::deep2d::Deep2dRuntimeContent,
) -> Result<[[u8; 4]; 4], String> {
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Deep2d interleaved readback target"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(
        device,
        queue,
        wgpu::TextureFormat::Rgba8Unorm,
        content,
        &cache,
    )?;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Deep2d interleaved readback buffer"),
        size: u64::from(ROW_BYTES),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Deep2d interleaved readback encoder"),
    });
    clear(&mut encoder, &view);
    painter.draw(&mut encoder, &view, (WIDTH, HEIGHT));
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &target,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(ROW_BYTES),
                rows_per_image: Some(HEIGHT),
            },
        },
        wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
    );
    queue.submit([encoder.finish()]);
    let bytes = mapped_bytes(device, &readback)?;
    let mut pixels = [[0; 4]; 4];
    for (index, pixel) in pixels.iter_mut().enumerate() {
        pixel.copy_from_slice(&bytes[index * 4..index * 4 + 4]);
    }
    drop(bytes);
    readback.unmap();
    Ok(pixels)
}

fn clear(encoder: &mut wgpu::CommandEncoder, view: &wgpu::TextureView) {
    let attachments = [Some(wgpu::RenderPassColorAttachment {
        view,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
            store: wgpu::StoreOp::Store,
        },
    })];
    drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Deep2d interleaved readback clear"),
        color_attachments: &attachments,
        depth_stencil_attachment: None,
        ..Default::default()
    }));
}

fn mapped_bytes(device: &wgpu::Device, buffer: &wgpu::Buffer) -> Result<wgpu::BufferView, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|error| format!("Deep2d readback poll failed: {error}"))?;
    receiver
        .recv()
        .map_err(|error| format!("Deep2d readback callback failed: {error}"))?
        .map_err(|error| format!("Deep2d readback map failed: {error}"))?;
    buffer
        .get_mapped_range(..)
        .map_err(|error| format!("Deep2d mapped range failed: {error}"))
}
