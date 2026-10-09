//! native 空间域边缘 AA(FXAA)真机 GPU 对拍门:
//! 合成显示域边缘图 → `create_spatial_aa_pipeline` 全屏 pass → rgba8unorm
//! 回读 → 与 CPU 镜像 `resolve_spatial_aa_cpu`(TS resolveSpatialAaCpu 同式)
//! 逐像素对拍(容差 ≤2/255,硬件双线性与软件采样的合理噪声)。
//! 无适配器环境优雅跳过(与 white_furnace GPU 腿同惯例)。

#[path = "../src/postprocess/spatial_aa.rs"]
mod spatial_aa;

use spatial_aa::{SpatialAaImage, create_spatial_aa_pipeline, resolve_spatial_aa_cpu};
use wgpu::util::DeviceExt;

const WIDTH: u32 = 4;
const HEIGHT: u32 = 2;

fn edge_pattern() -> Vec<f32> {
    let mut color = Vec::new();
    for _y in 0..HEIGHT {
        for x in 0..WIDTH {
            let value = if x < 2 { 0.25f32 } else { 0.75f32 };
            color.extend_from_slice(&[value, value, value, 1.0]);
        }
    }
    color
}

fn request_device() -> Option<(wgpu::Device, wgpu::Queue, String)> {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12 | wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        ..Default::default()
    }))
    .ok()?;
    let info = adapter.get_info();
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()?;
    Some((device, queue, format!("{info:?}")))
}

#[test]
fn fxaa_pass_matches_cpu_mirror_within_2_of_255() {
    let Some((device, queue, adapter)) = request_device() else {
        eprintln!("spatial_aa_gpu: no DX12/Vulkan adapter, skipping (environment lacks GPU)");
        return;
    };
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let source = device.create_texture_with_data(
        &queue,
        &wgpu::TextureDescriptor {
            label: Some("spatial aa source"),
            size: wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        // 显示编码 u8 载荷(与 f32 图案同值)。
        &edge_pattern()
            .iter()
            .map(|v| (v * 255.0).round() as u8)
            .collect::<Vec<u8>>(),
    );
    let source_view = source.create_view(&Default::default());
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("spatial aa sampler"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("spatial aa target"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let target_view = target.create_view(&Default::default());
    let pipeline = create_spatial_aa_pipeline(&device, format);
    let pipeline_bind_layout = pipeline.get_bind_group_layout(0);
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("spatial aa bind"),
        layout: &pipeline_bind_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&source_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
        ],
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("spatial aa pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &target_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..3, 0..1);
    }
    let bytes_per_row = (WIDTH * 4).div_ceil(256) * 256;
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("spatial aa readback"),
        size: u64::from(bytes_per_row * HEIGHT),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &staging,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: None,
            },
        },
        wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
    );
    queue.submit(Some(encoder.finish()));
    // wgpu 30:map_async(模式,范围,回调)+ get_mapped_range(..) → Result
    // (仓内惯例 rt_raster_parity_gpu_tests::map_readback 同型)。
    let (sender, receiver) = std::sync::mpsc::channel();
    staging.map_async(wgpu::MapMode::Read, .., move |result| {
        sender.send(result).unwrap();
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("poll device");
    receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap()
        .expect("map result");
    let data = staging.get_mapped_range(..).unwrap();
    let mut gpu_pixels: Vec<[f32; 4]> = Vec::new();
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let o = (y * bytes_per_row + x * 4) as usize;
            gpu_pixels.push([
                f32::from(data[o]) / 255.0,
                f32::from(data[o + 1]) / 255.0,
                f32::from(data[o + 2]) / 255.0,
                f32::from(data[o + 3]) / 255.0,
            ]);
        }
    }
    drop(data);
    staging.unmap();

    let pattern = edge_pattern();
    let cpu = resolve_spatial_aa_cpu(&SpatialAaImage {
        width: WIDTH,
        height: HEIGHT,
        color: &pattern,
    })
    .expect("cpu mirror");
    let tolerance = 2.0 / 255.0;
    for (index, pixel) in gpu_pixels.iter().enumerate() {
        let y = index / WIDTH as usize;
        let x = index % WIDTH as usize;
        for (c, value) in pixel.iter().enumerate() {
            let expected = cpu[index * 4 + c];
            // CPU 镜像输出 f32 域,GPU 走 u8 量化:比较在 1/255 粒度上放宽 1 LSB。
            assert!(
                (value - expected).abs() <= tolerance,
                "px({x},{y}) ch{c}: gpu {value} vs cpu {expected}"
            );
        }
    }
    // 边缘混合同样要在 GPU 上可见:暗侧被抬升、亮侧被压低(与 CPU 方向一致)。
    let gpu_luma = |x: u32, y: u32| {
        let p = &gpu_pixels[(y * WIDTH + x) as usize];
        p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11
    };
    assert!(
        gpu_luma(1, 0) > 0.25 + tolerance,
        "dark edge side must lift: {}",
        gpu_luma(1, 0)
    );
    assert!(
        gpu_luma(2, 0) < 0.75 - tolerance,
        "bright edge side must drop: {}",
        gpu_luma(2, 0)
    );
    println!("spatial_aa_gpu: FXAA pass matches CPU mirror within {tolerance} (adapter {adapter})");
}
