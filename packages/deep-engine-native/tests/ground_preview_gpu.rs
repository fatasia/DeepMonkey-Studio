//! native 地面预览(ground-preview)真机 GPU 对拍门:
//! 正交顶视相机 + 解析 footprint → `create_ground_preview_pipeline` 渲染
//! [-1,1]² y=0 地面 quad → rgba32float 回读 → 与 CPU 镜像
//! `ground_grid_factor_cpu` + `ground_grid_albedo_cpu`(TS pbrShader ground
//! 分支 / pbrGroundAlbedo 同式)逐像素对拍(相对容差 ≤2e-3,f32 GPU 与 f64
//! CPU 的合理噪声)。无适配器环境优雅跳过(与 spatial_aa GPU 腿同惯例)。

#[path = "../src/ground_preview.rs"]
mod ground_preview;

use ground_preview::{
    GroundPreviewUniforms, create_ground_preview_pipeline, ground_grid_albedo_cpu,
    ground_grid_factor_cpu,
};
use wgpu::util::DeviceExt;

const WIDTH: u32 = 64;
const HEIGHT: u32 = 64;
/// 正交半宽(世界单位);footprint = 世界跨度/像素数/格距 2.4。
const HALF_EXTENT: f32 = 8.0;
/// quad 半边长,覆盖视锥角点(8√2 ≈ 11.31)。
const QUAD_HALF: f32 = 12.0;
const GRID_INTENSITY: f32 = 1.0;
const PLANE_Y: f32 = -0.02;
const BASE: [f32; 3] = [0.9, 0.9, 0.92];

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

/// 正交顶视 VP(列主序):clip = (x/half, −z/half, 0, 1)。
fn top_down_view_projection() -> [[f32; 4]; 4] {
    let inv = 1.0 / HALF_EXTENT;
    [
        [inv, 0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 0.0],
        [0.0, -inv, 0.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

#[test]
fn ground_preview_pass_matches_cpu_mirror() {
    let Some((device, queue, adapter)) = request_device() else {
        eprintln!("ground_preview_gpu: no DX12/Vulkan adapter, skipping (environment lacks GPU)");
        return;
    };
    let format = wgpu::TextureFormat::Rgba32Float;
    let uniforms = GroundPreviewUniforms {
        view_projection: top_down_view_projection(),
        base_grid: [BASE[0], BASE[1], BASE[2], GRID_INTENSITY],
        plane: [
            (2.0 * HALF_EXTENT / WIDTH as f32) / 2.4, // 解析 footprint
            PLANE_Y,
            QUAD_HALF,
            0.0,
        ],
    };
    let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("ground preview uniforms"),
        contents: bytemuck::bytes_of(&uniforms),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("ground preview target"),
        size: wgpu::Extent3d { width: WIDTH, height: HEIGHT, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let target_view = target.create_view(&Default::default());
    let pipeline = create_ground_preview_pipeline(&device, format);
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("ground preview bind"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: uniform_buffer.as_entire_binding(),
        }],
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("ground preview pass"),
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
        pass.draw(0..6, 0..1);
    }
    let bytes_per_row = (WIDTH * 16).div_ceil(256) * 256;
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("ground preview readback"),
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

    // CPU 逐像素期望:像素中心 → NDC → 世界 xz → 网格因子 + 反照率(f64 域)。
    let half = f64::from(HALF_EXTENT);
    let footprint = (2.0 * half / f64::from(WIDTH)) / 2.4;
    let tolerance = 2e-3;
    let mut worst = 0.0f64;
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let ndc_x = (2.0 * (f64::from(x) + 0.5) / f64::from(WIDTH)) - 1.0;
            let ndc_y = 1.0 - (2.0 * (f64::from(y) + 0.5) / f64::from(HEIGHT));
            let world_x = ndc_x * half;
            let world_z = -ndc_y * half;
            let grid =
                ground_grid_factor_cpu(world_x, world_z, f64::from(GRID_INTENSITY), footprint);
            let expected = ground_grid_albedo_cpu(
                [f64::from(BASE[0]), f64::from(BASE[1]), f64::from(BASE[2])],
                grid,
                true,
            )
            .expect("valid albedo");
            let pixel = gpu_pixels[(y * WIDTH + x) as usize];
            for channel in 0..3 {
                let gpu = f64::from(pixel[channel]);
                let want = expected[channel];
                let error = (gpu - want).abs() / want.abs().max(1e-6);
                worst = worst.max(error);
                assert!(
                    error <= tolerance,
                    "px({x},{y}) ch{channel}: gpu {gpu} vs cpu {want} (rel {error})"
                );
            }
            assert!((f64::from(pixel[3]) - 1.0).abs() < 1e-6, "alpha must be 1");
        }
    }

    // 视觉结构哨兵:格点交叉(世界原点附近像素)亮于格胞中心(网格可见)。
    let luma = |x: u32, y: u32| {
        let p = gpu_pixels[(y * WIDTH + x) as usize];
        f64::from(p[0]) * 0.3 + f64::from(p[1]) * 0.59 + f64::from(p[2]) * 0.11
    };
    let center_x = WIDTH / 2;
    let center_y = HEIGHT / 2;
    // 半格 2.4 世界 ≈ 9.6 px → +12 px 落在胞中心。
    let body_x = center_x + 12;
    let body_y = center_y + 12;
    assert!(
        luma(center_x, center_y) > luma(body_x, body_y),
        "grid crossing ({}) must be brighter than cell body ({})",
        luma(center_x, center_y),
        luma(body_x, body_y)
    );
    println!(
        "ground_preview_gpu: {WIDTH}x{HEIGHT} pass matches CPU mirror (worst rel {worst:.2e} ≤ {tolerance}) adapter {adapter}"
    );
}
