#[path = "../src/bloom_pass.rs"]
mod bloom_pass;
#[path = "../src/bloom_pipeline.rs"]
mod bloom_pipeline;
#[path = "../src/output_pass.rs"]
mod output_pass;

use std::sync::{Arc, Mutex};

use bloom_pass::BloomPass;
use deep_engine_native::{bloom::BloomSettings, mesh_abi::FORWARD_COLOR_FORMAT};
use output_pass::OutputPass;
use winit::dpi::PhysicalSize;

const WIDTH: u32 = 64;
const HEIGHT: u32 = 32;
const BLOOM_WIDTH: u32 = WIDTH / 2;
const BLOOM_HEIGHT: u32 = HEIGHT / 2;

#[test]
#[ignore = "requires a real NVIDIA GPU; run explicitly with --ignored"]
fn nvidia_hdr_bloom_spreads_highlights_without_adding_dark_energy() {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12 | wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        ..Default::default()
    }))
    .expect("real GPU adapter");
    let info = adapter.get_info();
    assert!(
        info.vendor == 0x10de || info.name.to_ascii_lowercase().contains("nvidia"),
        "probe requires NVIDIA evidence, got {info:?}"
    );
    let (device, queue) =
        pollster::block_on(adapter.request_device(&Default::default())).expect("real GPU device");
    let uncaptured = Arc::new(Mutex::new(Vec::new()));
    let recorded = uncaptured.clone();
    device.on_uncaptured_error(Arc::new(move |error| {
        recorded.lock().unwrap().push(error.to_string());
    }));

    let source = create_source(&device, &queue);
    let source_view = source.create_view(&Default::default());
    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let mut bloom = BloomPass::new(
        &device,
        &source_view,
        PhysicalSize::new(WIDTH, HEIGHT),
        BloomSettings::default(),
    )
    .unwrap()
    .expect("default bloom is active");
    assert!(
        BloomPass::new(
            &device,
            &source_view,
            PhysicalSize::new(WIDTH, HEIGHT),
            BloomSettings::DISABLED,
        )
        .unwrap()
        .is_none(),
        "disabled bloom must return before creating resources"
    );
    assert_eq!(bloom.settings(), BloomSettings::default());
    let resized = bloom.prepare_resize(&device, &source_view, PhysicalSize::new(WIDTH, HEIGHT));
    let _transaction_candidate = resized.output_view();
    bloom.publish_resize(resized);
    let _published_output = bloom.output_view();
    let output_texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Deep Engine native bloom probe ACES output"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORWARD_COLOR_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let output_view = output_texture.create_view(&Default::default());
    let mut output = OutputPass::new(
        &device,
        FORWARD_COLOR_FORMAT,
        &source_view,
        Some((bloom.output_view(), bloom.settings().intensity)),
    );
    assert!(output.uses_bloom());
    assert!(
        output.prepare_rebind(&device, &source_view, None).is_err(),
        "resize must reject a partial bloom binding transaction"
    );
    let rebound = output
        .prepare_rebind(&device, &source_view, Some(bloom.output_view()))
        .unwrap();
    output.publish_rebind(rebound);
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Deep Engine native bloom real-GPU readback"),
        size: u64::from(BLOOM_WIDTH * BLOOM_HEIGHT * 8),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    bloom.encode(&mut encoder);
    output.draw(&mut encoder, &output_view);
    encoder.copy_texture_to_buffer(
        bloom.output_texture().as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(BLOOM_WIDTH * 8),
                rows_per_image: Some(BLOOM_HEIGHT),
            },
        },
        wgpu::Extent3d {
            width: BLOOM_WIDTH,
            height: BLOOM_HEIGHT,
            depth_or_array_layers: 1,
        },
    );
    let submission = queue.submit([encoder.finish()]);
    device
        .poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(std::time::Duration::from_secs(5)),
        })
        .expect("bloom submission completes");
    for error in [
        pollster::block_on(internal.pop()),
        pollster::block_on(memory.pop()),
        pollster::block_on(validation.pop()),
    ] {
        assert!(error.is_none(), "scoped GPU error: {error:?}");
    }
    let pixels = map_pixels(&device, &readback);
    let mut spread_pixels = 0;
    let mut bright_energy = 0.0_f64;
    let mut dark_energy = 0.0_f64;
    for y in 0..BLOOM_HEIGHT as usize {
        for x in 0..BLOOM_WIDTH as usize {
            let luminance = pixel_luminance(&pixels, x, y);
            if x < 16 {
                bright_energy += luminance;
                if luminance > 0.01 {
                    spread_pixels += 1;
                }
            } else {
                dark_energy += luminance;
            }
        }
    }
    drop(pixels);
    readback.unmap();
    assert!(
        spread_pixels >= 12,
        "highlight did not spread: {spread_pixels}"
    );
    assert!(
        bright_energy > 1.0,
        "highlight bloom energy was {bright_energy}"
    );
    assert!(
        dark_energy < 0.001,
        "sub-threshold dark region gained {dark_energy}"
    );
    assert!(uncaptured.lock().unwrap().is_empty());
    println!(
        "native NVIDIA bloom probe: adapter={:?} spread_pixels={} bright_energy={:.6} dark_energy={:.9} GPU_errors=0",
        info, spread_pixels, bright_energy, dark_energy
    );
}

fn create_source(device: &wgpu::Device, queue: &wgpu::Queue) -> wgpu::Texture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Deep Engine native bloom probe HDR source"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORWARD_COLOR_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let mut pixels = vec![0_u16; (WIDTH * HEIGHT * 4) as usize];
    fill_rect(&mut pixels, 13..19, 13..19, 8.0);
    fill_rect(&mut pixels, 45..51, 13..19, 0.5);
    queue.write_texture(
        texture.as_image_copy(),
        bytemuck::cast_slice(&pixels),
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(WIDTH * 8),
            rows_per_image: Some(HEIGHT),
        },
        wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
    );
    texture
}

fn fill_rect(pixels: &mut [u16], xs: std::ops::Range<u32>, ys: std::ops::Range<u32>, value: f32) {
    let value = f32_to_f16(value);
    for y in ys {
        for x in xs.clone() {
            let offset = ((y * WIDTH + x) * 4) as usize;
            pixels[offset..offset + 3].fill(value);
            pixels[offset + 3] = f32_to_f16(1.0);
        }
    }
}

fn map_pixels(device: &wgpu::Device, buffer: &wgpu::Buffer) -> wgpu::BufferView {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    receiver.recv().unwrap().unwrap();
    buffer.get_mapped_range(..).unwrap()
}

fn pixel_luminance(bytes: &[u8], x: usize, y: usize) -> f64 {
    let offset = (y * BLOOM_WIDTH as usize + x) * 8;
    let channel = |at| {
        half_to_f32(u16::from_le_bytes([
            bytes[offset + at],
            bytes[offset + at + 1],
        ]))
    };
    f64::from(channel(0)) * 0.2126 + f64::from(channel(2)) * 0.7152 + f64::from(channel(4)) * 0.0722
}

fn f32_to_f16(value: f32) -> u16 {
    let bits = value.to_bits();
    let exponent = ((bits >> 23) & 0xff) as i32 - 112;
    if exponent <= 0 {
        return 0;
    }
    if exponent >= 31 {
        return 0x7c00;
    }
    ((exponent as u16) << 10) | ((bits >> 13) as u16 & 0x03ff)
}

fn half_to_f32(value: u16) -> f32 {
    let exponent = i32::from((value >> 10) & 0x1f);
    let mantissa = u32::from(value & 0x03ff);
    match exponent {
        0 => (mantissa as f32 / 1_024.0) * 2.0_f32.powi(-14),
        31 => f32::INFINITY,
        _ => (1.0 + mantissa as f32 / 1_024.0) * 2.0_f32.powi(exponent - 15),
    }
}
