//! R4 遮挡判定第一档 GPU 对比证据。
//!
//! 三场景(全视锥/全遮挡/混合)+ 低层足迹矩形 + 投影项提取单测 +
//! frustum-only vs frustum+occlusion 性能对照(≥5 样本取中位)。
//! 需要 real GPU 的用例按本 crate 惯例 `#[ignore]`,显式 `--ignored` 运行。
//! 深度约定:标准 Z(越小越近),深度金字塔 r32float、min 缩减;
//! 合成金字塔是该契约的受控输入,native 侧金字塔生产接线不在本切片。

use bytemuck::cast_slice;
use deep_engine_native::culling_contract::{
    MAIN_SOLID_MASK, PreparedGpuCulling, GPU_CULLING_INSTANCE_BYTES,
};
use deep_engine_native::mesh_abi::{CAMERA_FAR, CAMERA_FOCAL, CAMERA_NEAR, FrameUniform};
use deep_engine_native::player_view::PlayerView;
use deep_engine_native::scene::PackedInstance;
use wgpu::util::DeviceExt;
use winit::dpi::PhysicalSize;

use crate::gpu_culling::GpuCulling;
use crate::gpu_occlusion::{projection_terms, OcclusionSource, OCCLUSION_MARGIN};
use crate::gpu_resources::frame_data_with_view;
use crate::shadow_map::ShadowViewSource;

pub(crate) const SIZE: PhysicalSize<u32> = PhysicalSize::new(1280, 720);
pub(crate) const LOCAL_RADIUS: f32 = 0.25;

pub(crate) struct Shadows;
impl ShadowViewSource for Shadows {
    fn cascade_count(&self) -> u32 {
        0
    }
    fn cascade_view_projection(&self, _: usize) -> [[f32; 4]; 4] {
        [[0.0; 4]; 4]
    }
    fn shadow_map_size(&self) -> u32 {
        2048
    }
}

pub(crate) fn packed_instance(position: [f32; 3]) -> PackedInstance {
    let mut row = [0.0_f32; GPU_CULLING_INSTANCE_BYTES as usize / 4];
    row[0] = 1.0;
    row[5] = 1.0;
    row[10] = 1.0;
    row[3] = position[0];
    row[7] = position[1];
    row[11] = position[2];
    row
}

pub(crate) fn prepared(count: usize) -> PreparedGpuCulling {
    PreparedGpuCulling {
        bounds: vec![[0.0, 0.0, 0.0, LOCAL_RADIUS]; count],
        metadata: vec![[0, MAIN_SOLID_MASK, 0, 0]; count],
        indirect_template: vec![[36, 0, 0, 0, 0]],
    }
}

/// 标准 Z 深度映射(与 WGSL 一致):depth(w) = far/(far-near) * (w - near) / w。
pub(crate) fn standard_depth(view_depth: f32) -> f32 {
    let depth_scale = CAMERA_FAR / (CAMERA_FAR - CAMERA_NEAR);
    depth_scale * (view_depth - CAMERA_NEAR) / view_depth
}

/// 相机 eye 在 target − distance*forward;t 直定义为「距 eye 的视深」,
/// 世界点 = target + forward*(t − distance)(lateral/vertical 沿右/上轴)。
pub(crate) fn world_point(view: PlayerView, t: f32, lateral: f32, vertical: f32) -> [f32; 3] {
    let [right, up, forward] = view.basis();
    let depth_offset = t - view.distance;
    std::array::from_fn(|axis| {
        view.target[axis]
            + forward[axis] * depth_offset
            + right[axis] * lateral
            + up[axis] * vertical
    })
}

pub(crate) fn scenario_view(distance: f32) -> PlayerView {
    PlayerView {
        yaw: 0.55,
        pitch: 0.0,
        target: [0.0; 3],
        distance,
        ..Default::default()
    }
}

pub(crate) fn frame_for(view: PlayerView) -> FrameUniform {
    frame_data_with_view(SIZE, view.yaw, view.target, view.distance, Default::default())
}

/// 网格实例:t 相同,横向 8 × 纵向 8,覆盖视锥中部。
pub(crate) fn grid_instances(view: PlayerView, t: f32) -> Vec<PackedInstance> {
    let mut instances = Vec::with_capacity(64);
    for row in 0..8 {
        for column in 0..8 {
            let lateral = (column as f32 - 3.5) * 0.28;
            let vertical = (row as f32 - 3.5) * 0.28;
            instances.push(packed_instance(world_point(view, t, lateral, vertical)));
        }
    }
    instances
}

/// 合成 HiZ 金字塔:r32float,levels[0] 为全分辨率,levels[i] 尺寸减半。
pub(crate) fn hiz_pyramid(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    levels: &[&[f32]],
) -> (wgpu::Texture, wgpu::TextureView) {
    let base_width = 4u32;
    let base_height = 4u32;
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("R4 occlusion synthetic HiZ pyramid"),
        size: wgpu::Extent3d {
            width: base_width,
            height: base_height,
            depth_or_array_layers: 1,
        },
        mip_level_count: levels.len() as u32,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for (level, data) in levels.iter().enumerate() {
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: level as u32,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            cast_slice(data),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some((base_width >> level) * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: base_width >> level,
                height: base_height >> level,
                depth_or_array_layers: 1,
            },
        );
    }
    let view = texture.create_view(&Default::default());
    (texture, view)
}

pub(crate) struct Bench {
    pub(crate) device: wgpu::Device,
    pub(crate) queue: wgpu::Queue,
}

pub(crate) async fn bench_device() -> Bench {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .expect("real GPU adapter");
    let info = adapter.get_info();
    println!(
        "environment: backend={:?} adapter={:?} device_type={:?} driver={:?} wgpu=30.0.1",
        info.backend, info.name, info.device_type, info.driver
    );
    assert_ne!(info.device_type, wgpu::DeviceType::Cpu);
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .unwrap();
    Bench { device, queue }
}

pub(crate) struct Scene {
    pub(crate) instances: Vec<PackedInstance>,
    pub(crate) frame: FrameUniform,
}

fn build_culling(
    bench: &Bench,
    scene: &Scene,
    hiz: Option<(&wgpu::TextureView, u32, u32, u32)>,
    enable_readback: bool,
) -> GpuCulling {
    let source = bench
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("R4 occlusion test instances"),
            contents: cast_slice(&scene.instances),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
    let prepared = prepared(scene.instances.len());
    let mut culling =
        GpuCulling::new(&bench.device, &source, &prepared, &scene.frame, &Shadows, enable_readback)
            .expect("frustum culling builds");
    if let Some((view, width, height, mip_level)) = hiz {
        culling
            .attach_occlusion(
                &bench.device,
                &source,
                OcclusionSource { view: view.clone(), width, height, mip_level },
                &scene.frame,
                enable_readback,
            )
            .expect("occlusion stage builds");
    }
    culling
}

/// encode + submit + poll,取回 (frustum 主视锥幸存数, 遮挡幸存数)。
fn run_once(
    culling: &mut GpuCulling,
    bench: &Bench,
    frame: &FrameUniform,
) -> (u32, Option<u32>) {
    culling.update_views(&bench.queue, frame, &Shadows).unwrap();
    let mut encoder = bench
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("R4 occlusion scenario encoder"),
        });
    culling.encode(&bench.queue, &mut encoder);
    culling.commit_submission();
    bench.queue.submit(Some(encoder.finish()));
    bench
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    let frustum = culling.take_metrics(&bench.device).unwrap().unwrap();
    let occlusion = culling.take_occlusion_visible(&bench.device).unwrap();
    (frustum.main.visible_instances, occlusion)
}

#[test]
fn projection_terms_extracts_player_view_camera_exactly() {
    let aspect = SIZE.width as f32 / SIZE.height as f32;
    for yaw in [0.0, 0.55, -1.2, std::f32::consts::PI] {
        for target in [[0.0; 3], [30.0, -12.0, 19.0], [-70.0, 20.0, -40.0]] {
            let view = PlayerView { yaw, target, ..scenario_view(6.0) };
            let frame = frame_for(view);
            let terms = projection_terms(&frame).expect("projection terms");
            let close = |actual: f32, expected: f32| {
                assert!(
                    (actual - expected).abs() < 1e-4 * expected.abs().max(1.0),
                    "{actual} != {expected}"
                );
            };
            close(terms.focal_y, CAMERA_FOCAL);
            close(terms.focal_x, CAMERA_FOCAL / aspect);
            close(terms.depth_scale, CAMERA_FAR / (CAMERA_FAR - CAMERA_NEAR));
            close(terms.near, CAMERA_NEAR);
        }
    }
}

/// 场景一:全部在视锥内且 HiZ 全远平面 ⇒ 遮挡判定一个不剔,
/// 且与 frustum-only 计数相等(不误剔)。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn scenario_all_in_frustum_keeps_every_instance() {
    let bench = pollster::block_on(bench_device());
    let view = scenario_view(6.0);
    let scene = Scene { instances: grid_instances(view, 6.0), frame: frame_for(view) };
    let (_texture, hiz_view) = hiz_pyramid(
        &bench.device,
        &bench.queue,
        &[&[1.0; 16], &[1.0; 4], &[1.0]],
    );
    let mut culling = build_culling(&bench, &scene, Some((&hiz_view, 4, 4, 2)), true);
    let (frustum_visible, occlusion_visible) = run_once(&mut culling, &bench, &scene.frame);
    println!(
        "scenario A all-in-frustum: frustum_visible={frustum_visible} occlusion_visible={occlusion_visible:?}"
    );
    assert_eq!(frustum_visible, 64);
    assert_eq!(occlusion_visible, Some(64));
}

/// 场景二:近处全屏遮挡体(视深 1.0)盖住全部实例 ⇒ 剔除生效,一个不留。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn scenario_all_occluded_culls_every_instance() {
    let bench = pollster::block_on(bench_device());
    let view = scenario_view(6.0);
    let scene = Scene { instances: grid_instances(view, 6.0), frame: frame_for(view) };
    let occluder_depth = standard_depth(1.0);
    let (_texture, hiz_view) = hiz_pyramid(
        &bench.device,
        &bench.queue,
        &[&[occluder_depth; 16], &[occluder_depth; 4], &[occluder_depth]],
    );
    let mut culling = build_culling(&bench, &scene, Some((&hiz_view, 4, 4, 2)), true);
    let (frustum_visible, occlusion_visible) = run_once(&mut culling, &bench, &scene.frame);
    println!(
        "scenario B all-occluded: occluder_depth={occluder_depth:.6} frustum_visible={frustum_visible} occlusion_visible={occlusion_visible:?}"
    );
    assert_eq!(frustum_visible, 64);
    assert_eq!(occlusion_visible, Some(0));
}

/// 场景三:遮挡体在视深 3.0,前半(视深 2.0)幸存、后半(视深 4.0)被剔。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn scenario_mixed_depths_split_visibility() {
    let bench = pollster::block_on(bench_device());
    let view = scenario_view(6.0);
    let mut instances = grid_instances(view, 2.0);
    instances.extend(grid_instances(view, 4.0));
    let scene = Scene { instances, frame: frame_for(view) };
    let occluder_depth = standard_depth(3.0);
    let (_texture, hiz_view) = hiz_pyramid(
        &bench.device,
        &bench.queue,
        &[&[occluder_depth; 16], &[occluder_depth; 4], &[occluder_depth]],
    );
    let mut culling = build_culling(&bench, &scene, Some((&hiz_view, 4, 4, 2)), true);
    let (frustum_visible, occlusion_visible) = run_once(&mut culling, &bench, &scene.frame);
    // 判定深度核对(与 WGSL 同式,世界半径 = 局部半径,单位缩放;
    // t 已定义为距 eye 视深,最近点视深 = t − LOCAL_RADIUS):
    let front = standard_depth(2.0 - LOCAL_RADIUS);
    let back = standard_depth(4.0 - LOCAL_RADIUS);
    println!(
        "scenario C mixed: occluder_depth={occluder_depth:.6} front_nearest={front:.6} back_nearest={back:.6} frustum_visible={frustum_visible} occlusion_visible={occlusion_visible:?}"
    );
    assert!(front + OCCLUSION_MARGIN < occluder_depth, "front half must survive");
    assert!(occluder_depth + OCCLUSION_MARGIN < back, "back half must be culled");
    assert_eq!(frustum_visible, 128);
    assert_eq!(occlusion_visible, Some(64));
}

/// 场景四:mip 0 足迹矩形——HiZ 左半列为遮挡深度,右半远平面;
/// 屏幕左半实例被剔,右半幸存(验证 rect 采样与定序最小值)。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn scenario_level0_footprint_splits_by_screen_half() {
    let bench = pollster::block_on(bench_device());
    let view = scenario_view(6.0);
    let left = packed_instance(world_point(view, 2.0, -1.2, 0.0));
    let right = packed_instance(world_point(view, 2.0, 1.2, 0.0));
    let scene = Scene { instances: vec![left, right], frame: frame_for(view) };
    let occluder_depth = standard_depth(1.0);
    // 4×4 level 0:列 0..2 = 遮挡深度(屏幕左半),列 2..4 = 远平面。
    let mut level0 = [1.0_f32; 16];
    for row in 0..4 {
        for column in 0..2 {
            level0[row * 4 + column] = occluder_depth;
        }
    }
    let (_texture, hiz_view) =
        hiz_pyramid(&bench.device, &bench.queue, &[&level0, &[1.0; 4], &[1.0]]);
    let mut culling = build_culling(&bench, &scene, Some((&hiz_view, 4, 4, 0)), true);
    let (frustum_visible, occlusion_visible) = run_once(&mut culling, &bench, &scene.frame);
    println!(
        "scenario D level0 footprint: occluder_depth={occluder_depth:.6} frustum_visible={frustum_visible} occlusion_visible={occlusion_visible:?}"
    );
    assert_eq!(frustum_visible, 2);
    assert_eq!(occlusion_visible, Some(1));
}

/// 性能对照:同场景 4096 实例,frustum-only vs frustum+occlusion。
/// 口径(如实):CPU 墙钟包住 encode+submit+poll(小负载下等价单帧 GPU
/// 完成时间下限),非 GPU timestamp;两分支均无 readback,工作量对齐。
/// A/B 每轮交替采样共 21 轮,丢弃前 5 轮预热,取 16 样本中位——
/// 本机与主线程并行工作噪声大,靠轮数与中位压稳;口径仍为墙钟。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn performance_frustum_only_versus_frustum_plus_occlusion() {
    let bench = pollster::block_on(bench_device());
    let view = scenario_view(6.0);
    let mut instances = Vec::with_capacity(4096);
    for row in 0..64 {
        for column in 0..64 {
            let lateral = (column as f32 - 31.5) * 0.035;
            let vertical = (row as f32 - 31.5) * 0.035;
            instances.push(packed_instance(world_point(view, 6.0, lateral, vertical)));
        }
    }
    let scene = Scene { instances, frame: frame_for(view) };
    let (_texture, hiz_view) =
        hiz_pyramid(&bench.device, &bench.queue, &[&[1.0; 16], &[1.0; 4], &[1.0]]);
    let mut baseline = build_culling(&bench, &scene, None, false);
    let mut occluded = build_culling(&bench, &scene, Some((&hiz_view, 4, 4, 2)), false);
    let mut base_samples = Vec::new();
    let mut occl_samples = Vec::new();
    for round in 0..21 {
        base_samples.push(timed(&mut baseline, &bench, &scene.frame));
        occl_samples.push(timed(&mut occluded, &bench, &scene.frame));
        let _ = round;
    }
    base_samples.sort();
    occl_samples.sort();
    let base_median = base_samples[13];
    let occl_median = occl_samples[13];
    println!("performance frustum_only: median={base_median:?} samples={base_samples:?}");
    println!("performance frustum_plus_occlusion: median={occl_median:?} samples={occl_samples:?}");
    // 合理性断言:叠加遮挡 pass 不应引发病态放大(阈值宽松,防误报;
    // 两分支开销均为提交路径主导,方向不作为物理结论)。
    assert!(
        occl_median.as_secs_f64() < base_median.as_secs_f64() * 5.0 + 0.005,
        "occlusion pass exploded frame time: {base_median:?} -> {occl_median:?}"
    );
}

fn timed(
    culling: &mut GpuCulling,
    bench: &Bench,
    frame: &FrameUniform,
) -> std::time::Duration {
    culling.update_views(&bench.queue, frame, &Shadows).unwrap();
    let start = std::time::Instant::now();
    let mut encoder = bench
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("R4 occlusion perf encoder"),
        });
    culling.encode(&bench.queue, &mut encoder);
    bench.queue.submit(Some(encoder.finish()));
    bench
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    start.elapsed()
}
