//! native 大气散射天空(atmosphere-sky)真机 GPU 对拍门:
//! 全屏三角天空 pass(`create_atmosphere_sky_pipeline`,相机沿太阳方向)→
//! rgba32float 回读 → 与 CPU 镜像 `sample_analytic_sky_cpu`(TS skyReference
//! `sampleAnalyticSky` 同式)逐像素对拍(相对容差 ≤2e-3,f32 GPU 与 f64 CPU、
//! 以及 WGSL 1−exp 对 expm1 的声明内偏离的合理噪声)。无适配器环境优雅跳过。

#[path = "../src/atmosphere_sky.rs"]
mod atmosphere_sky;

use atmosphere_sky::{
    AtmosphereSkyParameters, DEFAULT_MIE_ANISOTROPY, create_atmosphere_sky_pipeline,
    pack_sky_draw_uniforms, sample_analytic_sky_cpu,
};
use wgpu::util::DeviceExt;

const WIDTH: u32 = 32;
const HEIGHT: u32 = 32;
/// 视场半角(fov/2 = 22.5°);相机沿太阳方向放置。
const TAN_HALF_FOV: f32 = 0.41421356; // tan(π/8)
const TURBIDITY: f64 = 4.0;
const SUN: [f64; 3] = [0.5, 0.6, 0.6244997998398398]; // 单位矢量(z = √(1−0.25−0.36))

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

/// 正交基:forward = 太阳方向,up 由 (0,1,0) Gram-Schmidt,right = f×up0 归一。
fn camera_basis() -> ([f64; 3], [f64; 3], [f64; 3]) {
    let forward = SUN;
    let cross = |a: [f64; 3], b: [f64; 3]| {
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    };
    let normalize = |v: [f64; 3]| {
        let length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        [v[0] / length, v[1] / length, v[2] / length]
    };
    let right = normalize(cross(forward, [0.0, 1.0, 0.0]));
    let up = cross(right, forward); // 已单位正交
    (right, up, forward)
}

#[test]
fn atmosphere_sky_pass_matches_cpu_mirror() {
    let Some((device, queue, adapter)) = request_device() else {
        eprintln!("atmosphere_sky_gpu: no DX12/Vulkan adapter, skipping (environment lacks GPU)");
        return;
    };
    let (right, up, forward) = camera_basis();
    let scale = f64::from(TAN_HALF_FOV); // aspect = 1
    let uniforms = pack_sky_draw_uniforms(
        right.map(|v| (v * scale) as f32),
        up.map(|v| (v * scale) as f32),
        forward.map(|v| v as f32),
        SUN.map(|v| v as f32),
        TURBIDITY as f32,
        DEFAULT_MIE_ANISOTROPY as f32,
    );
    let format = wgpu::TextureFormat::Rgba32Float;
    let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("atmosphere sky uniforms"),
        contents: bytemuck::bytes_of(&uniforms),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("atmosphere sky target"),
        size: wgpu::Extent3d { width: WIDTH, height: HEIGHT, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let target_view = target.create_view(&Default::default());
    let pipeline = create_atmosphere_sky_pipeline(&device, format);
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("atmosphere sky bind"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: uniform_buffer.as_entire_binding(),
        }],
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("atmosphere sky pass"),
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
    let bytes_per_row = (WIDTH * 16).div_ceil(256) * 256;
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("atmosphere sky readback"),
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
        wgpu::Extent3d { width: WIDTH, height: HEIGHT, depth_or_array_layers: 1 },
    );
    queue.submit(Some(encoder.finish()));
    let (sender, receiver) = std::sync::mpsc::channel();
    staging.map_async(wgpu::MapMode::Read, .., move |result| {
        sender.send(result).unwrap();
    });
    device.poll(wgpu::PollType::wait_indefinitely()).expect("poll device");
    receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap()
        .expect("map result");
    let data = staging.get_mapped_range(..).unwrap();
    let mut gpu_pixels: Vec<[f32; 4]> = Vec::new();
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let o = (y * bytes_per_row + x * 16) as usize;
            let read = |offset: usize| {
                f32::from_le_bytes(data[offset..offset + 4].try_into().expect("aligned"))
            };
            gpu_pixels.push([read(o), read(o + 4), read(o + 8), read(o + 12)]);
        }
    }
    drop(data);
    staging.unmap();

    // CPU 逐像素期望:像素中心 NDC → 视线方向 → f64 解析单散射。
    let parameters = AtmosphereSkyParameters {
        turbidity: TURBIDITY,
        sun_direction_enu: SUN,
        mie_anisotropy: Some(f64::from(DEFAULT_MIE_ANISOTROPY)),
    };
    let tolerance = 2e-3;
    let mut worst = 0.0f64;
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let ndc_x = (2.0 * (f64::from(x) + 0.5) / f64::from(WIDTH)) - 1.0;
            let ndc_y = 1.0 - (2.0 * (f64::from(y) + 0.5) / f64::from(HEIGHT));
            let ray = [
                forward[0] + ndc_x * right[0] * scale + ndc_y * up[0] * scale,
                forward[1] + ndc_x * right[1] * scale + ndc_y * up[1] * scale,
                forward[2] + ndc_x * right[2] * scale + ndc_y * up[2] * scale,
            ];
            let length = (ray[0] * ray[0] + ray[1] * ray[1] + ray[2] * ray[2]).sqrt();
            let direction = [ray[0] / length, ray[1] / length, ray[2] / length];
            let expected = sample_analytic_sky_cpu(parameters, direction).expect("valid ray");
            let pixel = gpu_pixels[(y * WIDTH + x) as usize];
            for channel in 0..3 {
                let gpu = f64::from(pixel[channel]);
                let want = expected[channel];
                let error = (gpu - want).abs() / want.abs().max(1e-9);
                worst = worst.max(error);
                assert!(
                    error <= tolerance,
                    "px({x},{y}) ch{channel}: gpu {gpu} vs cpu {want} (rel {error})"
                );
            }
            assert!((f64::from(pixel[3]) - 1.0).abs() < 1e-6, "alpha must be 1");
        }
    }

    // 物理结构哨兵:视线中心 = 太阳方向,是全场最亮像素(Rayleigh 相函数
    // (1+γ²) 在 γ=0 峰值);边缘像素的蓝红比高于中心(Rayleigh 蓝移随角度增强)。
    let center = &gpu_pixels[((HEIGHT / 2) * WIDTH + WIDTH / 2) as usize];
    let corner = &gpu_pixels[0];
    let center_luma = f64::from(center[0]) * 0.3 + f64::from(center[1]) * 0.59 + f64::from(center[2]) * 0.11;
    let corner_luma = f64::from(corner[0]) * 0.3 + f64::from(corner[1]) * 0.59 + f64::from(corner[2]) * 0.11;
    assert!(center_luma > corner_luma, "circumsolar center must dominate: {center_luma} vs {corner_luma}");
    let center_ratio = f64::from(center[2]) / f64::from(center[0]);
    let corner_ratio = f64::from(corner[2]) / f64::from(corner[0]);
    assert!(
        corner_ratio > center_ratio,
        "blue/red must grow away from sun: {corner_ratio} vs {center_ratio}"
    );
    println!(
        "atmosphere_sky_gpu: {WIDTH}x{HEIGHT} pass matches CPU mirror (worst rel {worst:.2e} ≤ {tolerance}) adapter {adapter}"
    );
}
