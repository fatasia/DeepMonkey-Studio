#[path = "../src/output_pass.rs"]
mod output_pass;

use bytemuck::cast_slice;
use deep_engine_native::{
    author_grading::AuthorGrading,
    fog::FogSettings,
    mesh_abi::{FORWARD_COLOR_FORMAT, FORWARD_DEPTH_FORMAT, FORWARD_SAMPLE_COUNT, frame_uniform},
};
use output_pass::OutputPass;
use std::sync::{Arc, Mutex, mpsc};
use wgpu::util::DeviceExt;

const WIDTH: u32 = 32;
const HEIGHT: u32 = 4;

/// 作者色彩分级消费探针（同族：fog_gpu/bloom_gpu）。
///
/// 证明三件事，全部以真实 GPU 读回为证据：
/// 1. 中性档（`Some(NEUTRAL.pack())`，switches 声明分级但六通道全零）与
///    `None`（不启用）输出逐位相同——零值精确中性不是近似；
/// 2. 非中性档在固定 ACES 之前生效：tint 拉高品红压低绿、饱和度 -1 压成灰；
/// 3. 四个 WGSL 变体（plain/bloom/fog/bloom_fog）在 binding 6 恒定绑定下
///    全部通过 shader/pipeline/bind-group 编译校验。
#[test]
#[ignore = "requires a real NVIDIA GPU; run explicitly with --ignored"]
fn nvidia_author_grading_consumed_before_aces_with_bit_exact_neutral_path() {
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
        let source_view = source.create_view(&Default::default());

        // 1) 中性档与未启用档逐位相同。
        let disabled = draw_output(&device, &queue, &source_view, None).await;
        let neutral = draw_output(
            &device,
            &queue,
            &source_view,
            Some(AuthorGrading::NEUTRAL.pack()),
        )
        .await;
        assert_eq!(neutral, disabled, "neutral pack must be bit-exact identity");

        // 2) 非中性档在 ACES 前生效：tint=+1 → R/B 增益上、G 下（ACES 正域单调）。
        let warm = AuthorGrading::new(0.0, 0.0, 0.0, 0.0, 0.0, 1.0).unwrap();
        let warmed = draw_output(&device, &queue, &source_view, Some(warm.pack())).await;
        assert!(
            warmed[0] > disabled[0],
            "tint must lift red, got {warmed:?}"
        );
        assert!(
            warmed[1] < disabled[1],
            "tint must cut green, got {warmed:?}"
        );
        // 饱和度 -1：去饱和为灰，ACES 后三通道一致。
        let gray = AuthorGrading::new(0.0, -1.0, 0.0, 0.0, 0.0, 0.0).unwrap();
        let graying = draw_output(&device, &queue, &source_view, Some(gray.pack())).await;
        let spread = (graying[0] - graying[1])
            .abs()
            .max((graying[1] - graying[2]).abs());
        assert!(
            spread < 0.002,
            "saturation -1 must collapse to gray, got {graying:?}"
        );

        // 3) 其余三个变体的 shader/pipeline/bind-group 编译校验。
        compile_variant_outputs(&device, &source_view);

        assert!(uncaptured.lock().unwrap().is_empty());
        println!(
            "native NVIDIA author grading probe: adapter={info:?} disabled={disabled:?} warmed={warmed:?} graying={graying:?} GPU_errors=0"
        );
    });
}

async fn draw_output(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    source: &wgpu::TextureView,
    grading: Option<[f32; 12]>,
) -> [f32; 3] {
    let output = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("author grading probe output"),
        size: extent(),
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORWARD_COLOR_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let output_view = output.create_view(&Default::default());
    let pass = OutputPass::new(device, FORWARD_COLOR_FORMAT, source, None, None, grading);
    assert!(!pass.uses_bloom() && !pass.uses_fog());
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("author grading probe readback"),
        size: u64::from(WIDTH * HEIGHT * 8),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut encoder = device.create_command_encoder(&Default::default());
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

/// bloom / fog / bloom+fog 三个变体各自完整走一次 OutputPass 构造
/// （shader 编译 + pipeline layout 兼容 + bind group），任何 binding 6
/// 漂移都会在这里失败。
fn compile_variant_outputs(device: &wgpu::Device, source: &wgpu::TextureView) {
    // bloom 变体：复用 HDR view 作为 bloom 输入，强度 buffer 由 OutputPass 自建。
    let bloom_output = OutputPass::new(
        device,
        FORWARD_COLOR_FORMAT,
        source,
        Some((source, 0.5)),
        None,
        None,
    );
    assert!(bloom_output.uses_bloom());
    // fog 变体：多采样深度 + 带 fog 行的 frame uniform。
    let depth = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("author grading probe depth"),
        size: extent(),
        mip_level_count: 1,
        sample_count: FORWARD_SAMPLE_COUNT,
        dimension: wgpu::TextureDimension::D2,
        format: FORWARD_DEPTH_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let depth_view = depth.create_view(&Default::default());
    let fog = FogSettings::exponential(1.0, [0.05, 0.1, 4.0]).unwrap();
    let frame = frame_uniform(1.0, 0.0);
    let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("author grading probe frame"),
        contents: cast_slice(&frame),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let fog_output = OutputPass::new(
        device,
        FORWARD_COLOR_FORMAT,
        source,
        None,
        Some((&depth_view, &frame_buffer)),
        None,
    );
    assert!(fog_output.uses_fog());
    let bloom_fog_output = OutputPass::new(
        device,
        FORWARD_COLOR_FORMAT,
        source,
        Some((source, 0.5)),
        Some((&depth_view, &frame_buffer)),
        None,
    );
    assert!(bloom_fog_output.uses_bloom() && bloom_fog_output.uses_fog());
}

fn source_texture(device: &wgpu::Device, queue: &wgpu::Queue) -> wgpu::Texture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("author grading probe HDR source"),
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
