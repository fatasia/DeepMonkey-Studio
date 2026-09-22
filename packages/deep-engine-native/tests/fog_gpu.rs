#[path = "../src/output_pass.rs"]
mod output_pass;

use bytemuck::cast_slice;
use deep_engine_native::{
    fog::FogSettings,
    mesh_abi::{
        FORWARD_COLOR_FORMAT, FORWARD_DEPTH_FORMAT, FORWARD_SAMPLE_COUNT, frame_uniform_with_fog,
    },
};
use output_pass::OutputPass;
use std::sync::{Arc, Mutex, mpsc};
use wgpu::util::DeviceExt;

const WIDTH: u32 = 32;
const HEIGHT: u32 = 4;

#[test]
#[ignore = "requires a real NVIDIA GPU; run explicitly with --ignored"]
fn nvidia_fog_changes_post_bloom_hdr_before_aces_without_touching_default_path() {
    pollster::block_on(async {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::DX12 | wgpu::Backends::VULKAN;
        let instance = wgpu::Instance::new(descriptor);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        let info = adapter.get_info();
        assert!(
            info.vendor == 0x10de || info.name.to_ascii_lowercase().contains("nvidia"),
            "probe requires NVIDIA evidence, got {info:?}"
        );
        let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
        let uncaptured = Arc::new(Mutex::new(Vec::new()));
        let recorded = uncaptured.clone();
        device.on_uncaptured_error(Arc::new(move |error| {
            recorded.lock().unwrap().push(error.to_string());
        }));
        let source = source_texture(&device, &queue);
        let depth = depth_texture(&device);
        let source_view = source.create_view(&Default::default());
        let depth_view = depth.create_view(&Default::default());
        let disabled = draw_output(&device, &queue, &source_view, &depth_view, None).await;
        let fog = FogSettings::exponential(1.0, [0.05, 0.1, 4.0]).unwrap();
        let enabled = draw_output(&device, &queue, &source_view, &depth_view, Some(fog)).await;
        assert!(enabled[0] < disabled[0], "fog must reduce the red channel");
        assert!(enabled[2] > disabled[2], "fog must add blue HDR energy");
        assert!(uncaptured.lock().unwrap().is_empty());
        println!(
            "native NVIDIA fog output probe: adapter={info:?} disabled={disabled:?} enabled={enabled:?} GPU_errors=0"
        );
    });
}

async fn draw_output(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    source: &wgpu::TextureView,
    depth: &wgpu::TextureView,
    fog: Option<FogSettings>,
) -> [f32; 3] {
    let frame = frame_uniform_with_fog(1.0, 0.0, fog.unwrap_or_default());
    let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("fog probe frame"),
        contents: cast_slice(&frame),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let output = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("fog probe output"),
        size: extent(),
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORWARD_COLOR_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let output_view = output.create_view(&Default::default());
    let mut pass = OutputPass::new(
        device,
        FORWARD_COLOR_FORMAT,
        source,
        None,
        fog.map(|_| (depth, &frame_buffer)),
        None,
    );
    assert!(!pass.uses_bloom());
    assert_eq!(pass.uses_fog(), fog.is_some());
    assert!(
        pass.prepare_rebind(device, source, None, fog.map(|_| (depth, &frame_buffer)))
            .is_ok()
    );
    if fog.is_some() {
        assert!(pass.prepare_rebind(device, source, None, None).is_err());
        let rebound = pass
            .prepare_rebind(device, source, None, Some((depth, &frame_buffer)))
            .unwrap();
        pass.publish_rebind(rebound);
    }
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("fog probe readback"),
        size: u64::from(WIDTH * HEIGHT * 8),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut encoder = device.create_command_encoder(&Default::default());
    clear_depth(&mut encoder, depth);
    pass.draw(&mut encoder, &output_view);
    encoder.copy_texture_to_buffer(
        output.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(WIDTH * 8),
                rows_per_image: Some(HEIGHT),
            },
        },
        extent(),
    );
    queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::sync_channel(1);
    readback.map_async(wgpu::MapMode::Read, .., move |result| {
        sender.send(result).unwrap()
    });
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    receiver.recv().unwrap().unwrap();
    let bytes = readback.get_mapped_range(..).unwrap();
    let color = [half(&bytes, 0), half(&bytes, 2), half(&bytes, 4)];
    drop(bytes);
    readback.unmap();
    assert!(pollster::block_on(scope.pop()).is_none());
    color
}

fn source_texture(device: &wgpu::Device, queue: &wgpu::Queue) -> wgpu::Texture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("fog probe HDR source"),
        size: extent(),
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORWARD_COLOR_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let pixel = [f16(4.0), f16(0.1), f16(0.05), f16(1.0)];
    let pixels = pixel.repeat((WIDTH * HEIGHT) as usize);
    queue.write_texture(
        texture.as_image_copy(),
        cast_slice(&pixels),
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(WIDTH * 8),
            rows_per_image: Some(HEIGHT),
        },
        extent(),
    );
    texture
}

fn depth_texture(device: &wgpu::Device) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("fog probe multisample depth"),
        size: extent(),
        mip_level_count: 1,
        sample_count: FORWARD_SAMPLE_COUNT,
        dimension: wgpu::TextureDimension::D2,
        format: FORWARD_DEPTH_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

fn clear_depth(encoder: &mut wgpu::CommandEncoder, depth: &wgpu::TextureView) {
    let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("fog probe depth clear"),
        color_attachments: &[],
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            view: depth,
            depth_ops: Some(wgpu::Operations {
                load: wgpu::LoadOp::Clear(0.5),
                store: wgpu::StoreOp::Store,
            }),
            stencil_ops: None,
        }),
        ..Default::default()
    });
}

fn extent() -> wgpu::Extent3d {
    wgpu::Extent3d {
        width: WIDTH,
        height: HEIGHT,
        depth_or_array_layers: 1,
    }
}

fn f16(value: f32) -> u16 {
    let bits = value.to_bits();
    let exponent = ((bits >> 23) & 0xff) as i32 - 112;
    ((exponent.clamp(1, 30) as u16) << 10) | ((bits >> 13) as u16 & 0x03ff)
}

fn half(bytes: &[u8], offset: usize) -> f32 {
    let value = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
    let exponent = i32::from((value >> 10) & 0x1f);
    let mantissa = u32::from(value & 0x03ff);
    match exponent {
        0 => (mantissa as f32 / 1_024.0) * 2.0_f32.powi(-14),
        31 => f32::INFINITY,
        _ => (1.0 + mantissa as f32 / 1_024.0) * 2.0_f32.powi(exponent - 15),
    }
}
