//! GPU device setup and bounded texture readback.
use super::*;

pub(super) struct BackendCtx {
    pub(super) adapter: wgpu::Adapter,
    pub(super) device: wgpu::Device,
    pub(super) queue: wgpu::Queue,
}

pub(super) fn make_instance(backend: wgpu::Backends) -> wgpu::Instance {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = backend;
    wgpu::Instance::new(descriptor)
}

pub(super) async fn request_adapter(instance: &wgpu::Instance, label: &str) -> wgpu::Adapter {
    instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            ..Default::default()
        })
        .await
        .unwrap_or_else(|error| panic!("{label}: real GPU adapter request failed: {error}"))
}

pub(super) fn adapter_json(info: &wgpu::AdapterInfo) -> Value {
    json!({
        "name": info.name,
        "vendorId": format!("0x{:04x}", info.vendor & 0xffff),
        "deviceId": format!("0x{:04x}", info.device & 0xffff),
        "deviceType": format!("{:?}", info.device_type),
        "pciBus": info.device_pci_bus_id,
        "driver": info.driver,
        "driverInfo": info.driver_info,
        "backend": format!("{:?}", info.backend),
    })
}

pub(super) async fn make_ctx(backend: wgpu::Backends, label: &str) -> BackendCtx {
    let instance = make_instance(backend);
    let adapter = request_adapter(&instance, label).await;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .unwrap_or_else(|error| panic!("{label}: device request failed: {error}"));
    BackendCtx {
        adapter,
        device,
        queue,
    }
}

/// 与 bin 侧 draw_in_format_at 相同的读回管线（含 256B 行对齐处理），
/// 每格独立 validation error scope。
pub(super) async fn draw_readback(
    ctx: &BackendCtx,
    content: &Deep2dRuntimeContent,
    cache: &Arc<Deep2dGpuAssetCache>,
    physical: (u32, u32),
) -> (Vec<u8>, Option<String>) {
    let validation = ctx.device.push_error_scope(wgpu::ErrorFilter::Validation);
    let painter = Deep2dGpuPainter::new(&ctx.device, &ctx.queue, FORMAT, content, cache)
        .unwrap_or_else(|error| panic!("painter prepare failed: {error}"));
    let size = wgpu::Extent3d {
        width: physical.0,
        height: physical.1,
        depth_or_array_layers: 1,
    };
    let target = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("p03-04 readback target"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    let mut encoder = ctx.device.create_command_encoder(&Default::default());
    {
        let _clear = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("p03-04 clear"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
    }
    painter.draw(&mut encoder, &view, physical);
    let bytes_per_row = physical.0 * 4;
    let padded = bytes_per_row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
        * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("p03-04 readback buffer"),
        size: u64::from(padded) * u64::from(physical.1),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded),
                rows_per_image: Some(physical.1),
            },
        },
        size,
    );
    ctx.queue.submit([encoder.finish()]);
    readback.map_async(wgpu::MapMode::Read, .., |result| {
        result.expect("readback map")
    });
    ctx.device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("device poll");
    let mapped = readback.get_mapped_range(..).expect("mapped range");
    let mut pixels = Vec::with_capacity(bytes_per_row as usize * physical.1 as usize);
    for row in 0..physical.1 {
        let start = row as usize * padded as usize;
        pixels.extend_from_slice(&mapped[start..start + bytes_per_row as usize]);
    }
    drop(mapped);
    readback.unmap();
    drop(painter);
    let validation_error = validation.pop().await.map(|error| error.to_string());
    (pixels, validation_error)
}
