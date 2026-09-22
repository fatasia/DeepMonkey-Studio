//! R4 HiZ 金字塔单测与 GPU 对照(与 hi_z_pyramid.rs 分文件,≤800 行纪律)。
//!
//! GPU 用例按本 crate 惯例 `#[ignore]`,显式 `--ignored` 运行:
//! ```bash
//! cargo test --bin deep-engine-native hi_z_pyramid -- --ignored --nocapture
//! ```

use super::hi_z_pyramid::{
    HiZPyramid, OcclusionHizMode, hi_z_mip_level_count, mip_dimension, parse_occlusion_hiz_mode,
    reduce_is_anchored, reference_reduce,
};
use crate::gpu_occlusion_tests::{bench_device, standard_depth};

#[test]
fn native_hiz_mode_is_zero_config_auto_with_explicit_overrides() {
    assert_eq!(parse_occlusion_hiz_mode(None), OcclusionHizMode::Auto);
    assert_eq!(
        parse_occlusion_hiz_mode(Some("auto")),
        OcclusionHizMode::Auto
    );
    assert_eq!(
        parse_occlusion_hiz_mode(Some(" OFF ")),
        OcclusionHizMode::Disabled
    );
    assert_eq!(
        parse_occlusion_hiz_mode(Some("enabled")),
        OcclusionHizMode::Enabled
    );
    assert_eq!(
        parse_occlusion_hiz_mode(Some("unexpected")),
        OcclusionHizMode::Auto
    );
}

/// 4x MSAA 主视锥深度,与 `mesh_abi::FORWARD_SAMPLE_COUNT` 一致
/// (提取 WGSL 内的样本次序 0..4 硬编码与之一一对应)。
const DEPTH_SAMPLE_COUNT: u32 = 4;

#[test]
fn mip_level_count_matches_ts_formula() {
    // TS hiZMipLevelCount: floor(log2(max(w,h))) + 1。
    assert_eq!(hi_z_mip_level_count(1, 1), 1);
    assert_eq!(hi_z_mip_level_count(2, 1), 2);
    assert_eq!(hi_z_mip_level_count(4, 4), 3);
    assert_eq!(hi_z_mip_level_count(1280, 720), 11);
    assert_eq!(hi_z_mip_level_count(1920, 1080), 11);
    assert_eq!(hi_z_mip_level_count(8, 8), 4);
}

#[test]
fn reduce_kernel_selection_matches_ts_rule() {
    assert!(reduce_is_anchored(8, 8));
    assert!(reduce_is_anchored(4, 2));
    assert!(!reduce_is_anchored(3, 4));
    assert!(!reduce_is_anchored(4, 5));
}

#[test]
fn reference_reduce_matches_dcir_windows() {
    // 3×5 → 1×2:变窗合同逐值核对(窗口分区覆盖全部源 texel)。
    let source: Vec<f32> = (0..15).map(|i| i as f32 * 0.1).collect();
    let reduced = reference_reduce(&source, 3, 5);
    assert_eq!(reduced.len(), 2);
    // 目标 (0,0):x ∈ [0, 2),y ∈ [0, 3) → min(0.0,0.1,0.3,0.4,0.6,0.7)。
    assert_eq!(reduced[0].to_bits(), 0.0f32.to_bits());
    // 目标 (0,1):y ∈ [2, 5) → min(0.6,0.7,0.9,1.0,1.2,1.3) = 0.6。
    assert_eq!(reduced[1].to_bits(), 0.6f32.to_bits());
    // ±0 规范化:含 -0 输入的块产出 +0。
    let zeros = reference_reduce(&[-0.0, 0.5], 2, 1);
    assert_eq!(zeros[0].to_bits(), 0.0f32.to_bits());
}

/// 测试辅助:向 MSAA Depth24Plus 写常量深度(深度-only pass,无颜色)。
fn fill_constant_depth(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    depth_view: &wgpu::TextureView,
    _width: u32,
    _height: u32,
    value: f32,
) {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Hi-Z test depth fill"),
        source: wgpu::ShaderSource::Wgsl(
            r#"
            struct VsOutput { @builtin(position) position: vec4f, };
            @vertex fn vs(@builtin(vertex_index) index: u32) -> VsOutput {
              var corners = array<vec2f, 3>(
                vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
              return VsOutput(vec4f(corners[index], FILL_Z, 1.0));
            }
            @fragment fn fs() -> @location(0) vec4f { return vec4f(0.0); }
            "#
            .replace("FILL_Z", &format!("{value:?}"))
            .into(),
        ),
    });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Hi-Z test depth fill layout"),
        bind_group_layouts: &[],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Hi-Z test depth fill pipeline"),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vs"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth24Plus,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Always),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState {
            count: DEPTH_SAMPLE_COUNT,
            ..Default::default()
        },
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs"),
            compilation_options: Default::default(),
            targets: &[],
        }),
        multiview_mask: None,
        cache: None,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Hi-Z test depth fill encoder"),
    });
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Hi-Z test depth fill pass"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: depth_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.draw(0..3, 0..1);
    }
    queue.submit(Some(encoder.finish()));
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
}

fn test_depth_texture(device: &wgpu::Device, width: u32, height: u32) -> wgpu::TextureView {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Hi-Z test depth"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: DEPTH_SAMPLE_COUNT,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth24Plus,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    texture.create_view(&Default::default())
}

fn assert_level(actual: &[f32], expected: &[f32], level: u32) {
    assert_eq!(actual.len(), expected.len(), "level {level} texel count");
    for (index, (a, e)) in actual.iter().zip(expected).enumerate() {
        assert_eq!(
            a.to_bits(),
            e.to_bits(),
            "level {level} texel {index}: {a} != {e}"
        );
    }
}

/// GPU 对照(合成深度):8×8 MSAA 深度全屏常量 0.25 → 提取 + anchored
/// 缩减链,全层与量化后期望逐位一致。Depth24Plus 是 unorm 深度:写入值经
/// round(v × (2^24−1))/(2^24−1) 量化,读回 f32 与源值有半 ulp 差。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn hi_z_extraction_and_anchored_reduce_match_known_depth() {
    let bench = pollster::block_on(bench_device());
    let width = 8;
    let height = 8;
    let depth_view = test_depth_texture(&bench.device, width, height);
    fill_constant_depth(
        &bench.device,
        &bench.queue,
        &depth_view,
        width,
        height,
        0.25,
    );
    let pyramid = HiZPyramid::new(&bench.device, &bench.queue, &depth_view, width, height).unwrap();
    let mut encoder = bench
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    pyramid.encode(&mut encoder);
    bench.queue.submit(Some(encoder.finish()));
    bench
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    let quantize = |v: f32| (v * 16777215.0).round() / 16777215.0;
    let value = quantize(0.25);
    for level in 0..pyramid.dims().2 {
        let dim = (width >> level).max(1);
        let expected = vec![value; (dim * dim) as usize];
        let actual = pyramid.readback_level(&bench.device, &bench.queue, level);
        assert_level(&actual, &expected, level);
    }
}

/// GPU 对照(合成输入,variable 路径):上传 64×3 非均匀 r32float 第 0 层,
/// 只跑缩减链,全层与 CPU 参考逐位一致(变窗内核 + ±0 规范化)。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn hi_z_variable_reduce_matches_cpu_reference() {
    let bench = pollster::block_on(bench_device());
    let width = 64;
    let height = 3;
    let pyramid = HiZPyramid::new(
        &bench.device,
        &bench.queue,
        &test_depth_texture(&bench.device, 1, 1),
        width,
        height,
    )
    .unwrap();
    let level0: Vec<f32> = (0..width * height)
        .map(|i| ((i * 37) % 251) as f32 / 251.0)
        .collect();
    pyramid.seed_level0(&bench.queue, &level0);
    let mut encoder = bench
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    pyramid.encode_reduce(&mut encoder);
    bench.queue.submit(Some(encoder.finish()));
    bench
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    let mut source = level0;
    let mut sw = width;
    let mut sh = height;
    for level in 0..pyramid.dims().2 {
        let actual = pyramid.readback_level(&bench.device, &bench.queue, level);
        if level > 0 {
            // 源含奇数维(64×3 → 32×1 → …)⇒ 首级即走 variable 内核;
            // 偶×偶层走 anchored。两内核语义同窗,参考统一按变窗合同。
            source = reference_reduce(&source, sw, sh);
            sw = mip_dimension(sw, 1);
            sh = mip_dimension(sh, 1);
        }
        assert_level(&actual, &source, level);
    }
}

/// GPU 对照(端到端):真实管线产出的金字塔喂 occlusion 判定——
/// 全屏遮挡体深度 ⇒ 全剔;远平面 ⇒ 不误剔。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn hi_z_generated_pyramid_drives_occlusion_culling() {
    use crate::gpu_culling::GpuCulling;
    use crate::gpu_occlusion_tests::{Shadows, frame_for, grid_instances, scenario_view};
    use deep_engine_native::culling_contract::{MAIN_SOLID_MASK, PreparedGpuCulling};
    use wgpu::util::DeviceExt;

    let bench = pollster::block_on(bench_device());
    let view = scenario_view(6.0);
    let frame = frame_for(view);
    let instances = grid_instances(view, 6.0);
    let source = bench
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Hi-Z occlusion integration instances"),
            contents: bytemuck::cast_slice(&instances),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
    let build = |depth_value: f32| {
        let depth_view = test_depth_texture(&bench.device, 4, 4);
        fill_constant_depth(&bench.device, &bench.queue, &depth_view, 4, 4, depth_value);
        let pyramid = HiZPyramid::new(&bench.device, &bench.queue, &depth_view, 4, 4).unwrap();
        let mut encoder = bench
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        pyramid.encode(&mut encoder);
        bench.queue.submit(Some(encoder.finish()));
        bench
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
        let prepared_culling = PreparedGpuCulling {
            bounds: vec![[0.0, 0.0, 0.0, 0.25]; instances.len()],
            metadata: vec![[0, MAIN_SOLID_MASK, 0, 0]; instances.len()],
            indirect_template: vec![[36, 0, 0, 0, 0]],
        };
        let mut culling = GpuCulling::new(
            &bench.device,
            &source,
            &prepared_culling,
            &frame,
            &Shadows,
            true,
        )
        .unwrap();
        culling
            .attach_occlusion(
                &bench.device,
                &source,
                pyramid.occlusion_source(),
                &frame,
                true,
            )
            .unwrap();
        culling
    };
    let run = |mut culling: GpuCulling| -> (u32, Option<u32>) {
        culling
            .update_views(&bench.queue, &frame, &Shadows)
            .unwrap();
        let mut encoder = bench
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        culling.encode(&bench.queue, &mut encoder);
        culling.commit_submission();
        bench.queue.submit(Some(encoder.finish()));
        bench
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
        let frustum = culling.take_metrics(&bench.device).unwrap().unwrap();
        (
            frustum.main.visible_instances,
            culling.take_occlusion_visible(&bench.device).unwrap(),
        )
    };

    // 场景 1:全屏遮挡体(视深 1.0)⇒ 64 全剔。
    let occluded = build(standard_depth(1.0));
    let (frustum, occlusion) = run(occluded);
    assert_eq!(frustum, 64);
    assert_eq!(occlusion, Some(0));

    // 场景 2:远平面(1.0)⇒ 不误剔,64 幸存。
    let open = build(1.0);
    let (frustum, occlusion) = run(open);
    assert_eq!(frustum, 64);
    assert_eq!(occlusion, Some(64));
}

/// 性能粗账:1920×1080 全帧 HiZ 编码墙钟(如实:CPU 墙钟含提交与 poll,
/// 非 GPU timestamp;小负载下提交路径主导。生产帧内 GPU timestamp 见
/// telemetry smoke 的 gpu.hi_z 段)。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn hi_z_encode_wallclock_at_1080p() {
    let bench = pollster::block_on(bench_device());
    let depth_view = test_depth_texture(&bench.device, 1920, 1080);
    let pyramid = HiZPyramid::new(&bench.device, &bench.queue, &depth_view, 1920, 1080).unwrap();
    let mut samples = Vec::new();
    for _ in 0..21 {
        let start = std::time::Instant::now();
        let mut encoder = bench
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        pyramid.encode(&mut encoder);
        bench.queue.submit(Some(encoder.finish()));
        bench
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
        samples.push(start.elapsed());
    }
    samples.sort();
    println!(
        "hi-z encode wallclock 1920x1080: min={:?} median={:?} max={:?}",
        samples[0], samples[10], samples[20]
    );
    assert!(
        samples[10].as_secs_f64() < 0.01,
        "hi-z encode exploded: median={:?}",
        samples[10]
    );
}
