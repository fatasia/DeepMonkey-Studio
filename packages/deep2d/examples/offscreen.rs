use std::{error::Error, io::Write, sync::{Arc, mpsc}};
use deepmonkey_2d::{decode_display_list, prepare_display_list, rasterize_prepared, compare,
    Deep2dRuntimeContent, Deep2dGpuPainter, Deep2dGpuAssetCache};

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let input = args.first().map(std::path::PathBuf::from)
        .unwrap_or_else(|| deepmonkey_2d::default_display_list_fixture_path().into());
    let output = args.get(1).map(String::as_str).unwrap_or("deep2d.ppm");
    let list = decode_display_list(&std::fs::read(input)?)?;
    let width = (list.logical_width * list.scale_factor).round() as u32;
    let height = (list.logical_height * list.scale_factor).round() as u32;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default()
    }))?;
    let info = adapter.get_info();
    if info.device_type == wgpu::DeviceType::Cpu { return Err("A hardware GPU is required".into()); }
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))?;
    if width == 0 || height == 0 || width > device.limits().max_texture_dimension_2d
        || height > device.limits().max_texture_dimension_2d { return Err("Unsupported image dimensions".into()); }
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let cache = Arc::new(Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(&device, &queue, format,
        &Deep2dRuntimeContent::DisplayList(list.clone()), &cache)?;
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Deep2D example"), size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    let row_bytes = (width * 4).div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Deep2D readback"), size: u64::from(row_bytes) * u64::from(height),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: &view, depth_slice: None, resolve_target: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
        })], ..Default::default()
    }));
    painter.draw(&mut encoder, &view, (width, height));
    encoder.copy_texture_to_buffer(wgpu::TexelCopyTextureInfo {
        texture: &target, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All,
    }, wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout {
        offset: 0, bytes_per_row: Some(row_bytes), rows_per_image: Some(height),
    } }, wgpu::Extent3d { width, height, depth_or_array_layers: 1 });
    queue.submit([encoder.finish()]);
    let (send, receive) = mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |result| { let _ = send.send(result); });
    device.poll(wgpu::PollType::wait_indefinitely())?;
    receive.recv()??;
    let mapped = buffer.get_mapped_range(..)?;
    let pixels: Vec<[u8; 4]> = mapped.chunks_exact(row_bytes as usize)
        .flat_map(|row| row[..width as usize * 4].chunks_exact(4).map(|p| p.try_into().unwrap())).collect();
    let mut file = std::io::BufWriter::new(std::fs::File::create(output)?);
    write!(file, "P6\n{width} {height}\n255\n")?;
    for pixel in &pixels { file.write_all(&pixel[..3])?; }
    file.flush()?;
    let prepared = prepare_display_list(&list)?;
    let cpu = rasterize_prepared([list.logical_width, list.logical_height], [width, height], &prepared);
    let comparison = compare(&cpu, &pixels, width, height, 8);
    println!("GPU: {} | {width}x{height} | output: {output} | pixels: {comparison:?}", info.name);
    if comparison.divergent != 0 { return Err("GPU pixels diverge from the CPU reference".into()); }
    Ok(())
}
