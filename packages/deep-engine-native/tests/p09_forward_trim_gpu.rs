//! P1-09 收尾:生产前向链(Bloom 链 + ForwardTargets + OutputPass)在
//! "默认完整 Bloom"与"纯二维按需裁剪"两种入口档位下的像素等价对照。
//! 组装顺序与 `renderer/init.rs` 一致:MSAA clear/resolve → bloom 编码 → 输出 pass。
#[allow(dead_code)]
#[path = "../src/bloom_pass.rs"]
mod bloom_pass;
#[allow(dead_code)]
#[path = "../src/bloom_pipeline.rs"]
mod bloom_pipeline;
#[allow(dead_code)]
#[path = "../src/forward_targets.rs"]
mod forward_targets;
#[allow(dead_code)]
#[path = "../src/output_pass.rs"]
mod output_pass;

use bloom_pass::BloomPass;
use deep_engine_native::bloom::BloomSettings;
use forward_targets::ForwardTargets;
use output_pass::OutputPass;
use std::sync::{Arc, Mutex};
use winit::dpi::PhysicalSize;

const SIZES: [(u32, u32); 2] = [(96, 64), (65, 33)];
const FORMATS: [wgpu::TextureFormat; 2] = [
    wgpu::TextureFormat::Rgba8Unorm,
    wgpu::TextureFormat::Rgba8UnormSrgb,
];
/// dashboard 暗色底(与 compact_forward_output_gpu 的暗背景同源)与 HDR 亮背景。
const DARK: wgpu::Color = wgpu::Color {
    r: 0.003_906_25,
    g: 0.015_625,
    b: 0.031_25,
    a: 1.0,
};
const HDR_BRIGHT: wgpu::Color = wgpu::Color {
    r: 8.0,
    g: 2.0,
    b: 0.5,
    a: 1.0,
};

fn gpu() -> (wgpu::Device, wgpu::Queue, Arc<Mutex<Vec<String>>>) {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::VULKAN | wgpu::Backends::DX12;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        ..Default::default()
    }))
    .expect("real GPU adapter");
    let info = adapter.get_info();
    assert!(
        matches!(
            info.device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        ),
        "hardware GPU required: {info:?}"
    );
    println!("p09 forward trim adapter: {info:?}");
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let errors = Arc::new(Mutex::new(Vec::new()));
    let captured = errors.clone();
    device.on_uncaptured_error(Arc::new(move |error| {
        captured.lock().unwrap().push(error.to_string())
    }));
    (device, queue, errors)
}

/// 一种入口档位下的完整生产链读回:
/// `full` = 修复前生产行为(默认 Bloom,全尺寸前向目标与 Bloom 链);
/// `compact` = 修复后纯二维生产行为(Bloom 关闭,前向目标 1×1,Bloom 链不分配)。
fn render_entry_profile(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    size: PhysicalSize<u32>,
    compact: bool,
    format: wgpu::TextureFormat,
    color: wgpu::Color,
) -> Vec<u8> {
    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let source_size = if compact {
        PhysicalSize::new(1, 1)
    } else {
        size
    };
    let source = ForwardTargets::new(device, source_size, false);
    assert_eq!(source.resolved_texture().width(), source_size.width);
    assert_eq!(source.resolved_texture().height(), source_size.height);
    let settings = if compact {
        BloomSettings::DISABLED
    } else {
        BloomSettings::default()
    };
    let bloom = BloomPass::new(device, &source.hdr_view, size, settings).unwrap();
    assert_eq!(
        bloom.is_none(),
        compact,
        "disabled entry must skip bloom allocation entirely"
    );
    if let Some(bloom) = &bloom {
        let half = bloom.output_texture();
        assert_eq!(half.width(), size.width.div_ceil(2));
        assert_eq!(half.height(), size.height.div_ceil(2));
    }
    let output = OutputPass::new(
        device,
        format,
        &source.hdr_view,
        bloom
            .as_ref()
            .map(|bloom| (bloom.output_view(), bloom.settings().intensity)),
        None,
        None,
    );
    assert_eq!(output.uses_bloom(), !compact);
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("p09 forward trim readback target"),
        size: wgpu::Extent3d {
            width: size.width,
            height: size.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let row_bytes = (size.width * 4).div_ceil(256) * 256;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("p09 forward trim pixels"),
        size: u64::from(row_bytes * size.height),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let attachments = [Some(wgpu::RenderPassColorAttachment {
            view: &source.msaa_view,
            depth_slice: None,
            resolve_target: Some(&source.hdr_view),
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(color),
                store: wgpu::StoreOp::Discard,
            },
        })];
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("p09 forward MSAA resolve"),
            color_attachments: &attachments,
            ..Default::default()
        });
    }
    if let Some(bloom) = &bloom {
        bloom.encode(&mut encoder);
    }
    output.draw(&mut encoder, &target.create_view(&Default::default()));
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row_bytes),
                rows_per_image: Some(size.height),
            },
        },
        target.size(),
    );
    queue.submit([encoder.finish()]);
    let (sender, receiver) = std::sync::mpsc::channel();
    readback.map_async(wgpu::MapMode::Read, .., move |result| {
        sender.send(result).unwrap()
    });
    device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(std::time::Duration::from_secs(10)),
        })
        .unwrap();
    receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap()
        .unwrap();
    let mapped = readback.get_mapped_range(..).unwrap();
    let pixels: Vec<u8> = mapped
        .chunks_exact(row_bytes as usize)
        .flat_map(|row| row[..(size.width * 4) as usize].iter().copied())
        .collect();
    drop(mapped);
    readback.unmap();
    for error in [
        pollster::block_on(internal.pop()),
        pollster::block_on(memory.pop()),
        pollster::block_on(validation.pop()),
    ] {
        assert!(error.is_none(), "GPU error: {error:?}");
    }
    pixels
}

fn capture(name: &str, pixels: &[u8], size: PhysicalSize<u32>, format_name: &str) {
    let Some(directory) = std::env::var_os("P09_TRIM_CAPTURE_DIR") else {
        return;
    };
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join(format!("{name}.rgba")), pixels).unwrap();
    let metadata = serde_json::json!({
        "width": size.width,
        "height": size.height,
        "format": format_name,
        "bytesPerRow": size.width * 4,
        "origin": "top-left",
    });
    std::fs::write(
        directory.join(format!("{name}.json")),
        serde_json::to_vec_pretty(&metadata).unwrap(),
    )
    .unwrap();
}

/// 两组对照(各覆盖两种尺寸 × 两种输出格式):
/// 1. 暗背景(dashboard 形态):默认 Bloom 全尺寸链 == 裁剪后 1×1 紧凑链,逐像素一致
///    ——证明对该场景砍掉 Bloom 链与前向目标不改变任何输出像素。
/// 2. HDR 亮背景:默认 Bloom 全尺寸链 != 裁剪后紧凑链——Bloom 链真实生效,
///    harness 对档位差异有区分力,Bloom 路径本身未被裁剪。
#[test]
#[ignore = "requires hardware GPU; run explicitly with --ignored"]
fn entry_profiles_match_pixel_for_pixel_on_dark_dashboards_and_stay_distinct_on_hdr() {
    let (device, queue, errors) = gpu();
    let mut compared = 0;
    for (width, height) in SIZES {
        let size = PhysicalSize::new(width, height);
        for format in FORMATS {
            let format_name = format!("{format:?}").to_lowercase();
            let render =
                |compact| render_entry_profile(&device, &queue, size, compact, format, DARK);
            let dark_full = render(false);
            let dark_compact = render(true);
            capture(
                &format!("dark-full-{width}x{height}-{format_name}"),
                &dark_full,
                size,
                &format_name,
            );
            capture(
                &format!("dark-compact-{width}x{height}-{format_name}"),
                &dark_compact,
                size,
                &format_name,
            );
            assert_eq!(
                dark_full, dark_compact,
                "dark dashboard must be pixel-identical across entry profiles: \
                 {format:?}, {width}x{height}"
            );
            let hdr_full = render_entry_profile(&device, &queue, size, false, format, HDR_BRIGHT);
            let hdr_compact = render_entry_profile(&device, &queue, size, true, format, HDR_BRIGHT);
            capture(
                &format!("hdr-full-{width}x{height}-{format_name}"),
                &hdr_full,
                size,
                &format_name,
            );
            capture(
                &format!("hdr-compact-{width}x{height}-{format_name}"),
                &hdr_compact,
                size,
                &format_name,
            );
            assert_ne!(
                hdr_full, hdr_compact,
                "HDR bloom input must keep the full chain visually distinct: \
                 {format:?}, {width}x{height}"
            );
            compared += (width * height * 4) as usize;
        }
    }
    assert!(
        errors.lock().unwrap().is_empty(),
        "{:?}",
        errors.lock().unwrap()
    );
    println!("entry profiles: 8 compared cases, {compared} bytes exercised, GPU errors=0");
}
