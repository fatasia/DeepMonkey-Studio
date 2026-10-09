//! J2-B3 Rust 白炉门 GPU 腿(真机 adapter;非 RT 设备即可):
//! 白 Lambert(albedo 1 / metal 0 / rough 1)+ 均匀恒定辐射度环境 E=0.5,
//! 直射光归零(sunColor.rgb=0 + 作者灯光模式)、阴影短路、AO=1、GI=1——
//! 渲染不变量:任意出射辐射度 ≡ E。判据/容差全部来自 lib 侧
//! `white_furnace`(whiteFurnace.ts 的 Rust 移植),本文件只负责
//! "场景装配 → 原生 mesh 管线渲染 → RGBA16F 回读 → 判据评估"。
//!
//! 腿位(与 TS whiteFurnaceGpuProbe 四判据同构,宿主差异见各腿注释):
//! - 球腿:白 Lambert 球 + 解析圆盘分割 → 背景/几何双域四判据;
//! - 墙腿:全帧白 Lambert 面 → 单域几何判据(全帧几何覆盖)。
//!
//! native 背景链与 web 的宿主差异:native 无等距柱天空采样 pass,背景为
//! 纯 clear 色链——本门把 clear 显式置为 E,背景域判据验证"背景保真
//! ≡ E 且均匀"(web 背景腿验的是等距柱直采样链,不可迁移,报告如实声明)。
//!
//! 修复前证据:本测试在 C12 修复落地前的 native_mesh_v1.wgsl 上运行时,
//! 几何域 mean 相对误差 ≈ −2.6% → `furnace-geometry-conserved` FAIL
//! (与 web C12 实测 max −2.637% 同量级;修复后全绿)。

use crate::{
    forward_targets::ForwardTargets,
    frame_bindings::{create_frame_layouts, create_native_mesh_shader},
    gpu_culling::GpuCulling,
    gpu_ibl::GpuIblEnvironment,
    gpu_resources::{create_shadow_map, frame_data_with_camera},
    gpu_scene::GpuScene,
    gpu_textures::{create_layered_material_layout, create_material_layout},
    mesh_pass::encode_opaque_pass,
    pipeline::{create_mesh_pipelines, create_mesh_pipelines_with_layered},
    player_shader_plan::scene_content_key,
};
// 同一挂载父模块(rt_pixel_gpu_tests)下的 rt_raster_parity 子模块复用
// 其 map_readback/decode_hdr 回读助手(与 rt_fallback_gpu_tests 同惯例)。
use super::rt_raster_parity_gpu_tests::{decode_hdr, map_readback};
use deep_engine_native::{
    contract::{RenderPacket, validate_packet},
    culling_contract::prepare_gpu_culling,
    fog::FogSettings,
    ibl::builtin_default_environment,
    ies_shading::NativeIesShadingResource,
    pbr_texture::prepare_pbr_resources,
    player_view::PlayerView,
    scene::prepare_scene,
    white_furnace::{
        FURNACE_ENVIRONMENT_RADIANCE, FurnaceCheck, FurnaceRegion, evaluate_furnace_checks,
        furnace_sphere_segmentation, region_stats, uniform_furnace_environment,
    },
};
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;
use winit::dpi::PhysicalSize;

const SIZE: u32 = 256;
/// 白炉球半径;眼距 4 下轮廓盘半径 ≈ 0.64 × (h/2),安全带 8% 后仍有充足双域。
const SPHERE_RADIUS: f32 = 1.2;

fn request_furnace_device() -> Option<(wgpu::Device, wgpu::Queue)> {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12 | wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).ok()?;
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .expect("furnace adapter must create a device");
    Some((device, queue))
}

/// UV 球网格(单位方向即法线),绕序逐四边形按外向法线校验(正交凸面,
/// cross(B−A, C−A)·outward < 0 时翻转),避免手工推导绕序错漏。
fn sphere_packet() -> RenderPacket {
    let (rings, sectors) = (32u32, 64u32);
    let mut vertices: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    for ring in 0..=rings {
        let theta = std::f32::consts::PI * ring as f32 / rings as f32;
        for sector in 0..=sectors {
            let phi = std::f32::consts::TAU * sector as f32 / sectors as f32;
            let normal = [
                theta.sin() * phi.cos(),
                theta.cos(),
                theta.sin() * phi.sin(),
            ];
            vertices.extend_from_slice(&[
                SPHERE_RADIUS * normal[0],
                SPHERE_RADIUS * normal[1],
                SPHERE_RADIUS * normal[2],
                normal[0],
                normal[1],
                normal[2],
            ]);
        }
    }
    let vertex_at = |ring: u32, sector: u32| ring * (sectors + 1) + sector;
    for ring in 0..rings {
        for sector in 0..sectors {
            let quad = [
                vertex_at(ring, sector),
                vertex_at(ring, sector + 1),
                vertex_at(ring + 1, sector + 1),
                vertex_at(ring + 1, sector),
            ];
            let position = |index: u32| {
                [
                    vertices[index as usize * 6],
                    vertices[index as usize * 6 + 1],
                    vertices[index as usize * 6 + 2],
                ]
            };
            let outward = position(quad[0]);
            let cross = |a: [f32; 3], b: [f32; 3]| {
                [
                    a[1] * b[2] - a[2] * b[1],
                    a[2] * b[0] - a[0] * b[2],
                    a[0] * b[1] - a[1] * b[0],
                ]
            };
            let minus = |a: [f32; 3], b: [f32; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
            let winding = cross(
                minus(position(quad[1]), position(quad[0])),
                minus(position(quad[2]), position(quad[0])),
            );
            let dot: f32 = winding.iter().zip(outward).map(|(a, b)| a * b).sum();
            if dot >= 0.0 {
                indices.extend_from_slice(&[quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]]);
            } else {
                indices.extend_from_slice(&[quad[0], quad[2], quad[1], quad[0], quad[3], quad[2]]);
            }
        }
    }
    let vertex_count = vertices.len() / 6;
    let packet: RenderPacket = serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [{
            "id": "furnace-sphere", "revision": 1,
            "vertices": vertices, "uv0": vec![0.0f32; vertex_count * 2],
            "indices": indices,
        }],
        "materials": [{
            "id": "furnace-white-lambert", "baseColor": [1.0, 1.0, 1.0],
            "metallic": 0.0, "roughness": 1.0, "alphaMode": "OPAQUE"
        }],
        "instances": [{
            "id": "furnace-sphere", "geometry": "furnace-sphere", "material": "furnace-white-lambert",
            "transform": [1.0,0.0,0.0,0.0, 0.0,1.0,0.0,0.0, 0.0,0.0,1.0,0.0, 0.0,0.0,0.0,1.0]
        }],
        "textures": []
    }))
    .expect("furnace sphere packet JSON must deserialize");
    validate_packet(&packet).expect("furnace sphere packet must pass contract validation");
    packet
}

/// 全帧覆盖墙几何:位于相机与原点之间(距眼 2),法线朝相机,半边长 3 覆盖
/// 全视锥(垂直半角 tan ≈ 0.49 × 2 ≈ 0.98 < 3)。绕序按朝相机法线校验。
/// 墙腿与分层白炉腿共用同一几何。
fn facing_wall_vertices() -> Vec<f32> {
    let view = PlayerView::default();
    let [right, up, forward] = view.basis();
    let eye = view.eye();
    let center: [f32; 3] = std::array::from_fn(|axis| eye[axis] + forward[axis] * 2.0);
    // 朝相机法线 = −forward;若 cross(right, up) 与它反向则翻转 up,保证
    // cross(B−A, C−A) = 朝相机法线(与 rt_raster_parity push_face 同绕序规则)。
    let cross = |a: [f32; 3], b: [f32; 3]| {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    };
    let normal = cross(right, up);
    let facing: f32 = normal.iter().zip(forward).map(|(a, b)| a * b).sum();
    let up = if facing > 0.0 {
        [-up[0], -up[1], -up[2]]
    } else {
        up
    };
    let half = 3.0f32;
    let corner = |sr: f32, su: f32| -> [f32; 3] {
        std::array::from_fn(|axis| center[axis] + right[axis] * half * sr + up[axis] * half * su)
    };
    let corners = [
        corner(-1.0, -1.0),
        corner(1.0, -1.0),
        corner(1.0, 1.0),
        corner(-1.0, 1.0),
    ];
    let mut vertices: Vec<f32> = Vec::new();
    for point in corners {
        vertices.extend_from_slice(&[
            point[0],
            point[1],
            point[2],
            -forward[0],
            -forward[1],
            -forward[2],
        ]);
    }
    vertices
}

fn wall_packet() -> RenderPacket {
    let vertices = facing_wall_vertices();
    let packet: RenderPacket = serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [{
            "id": "furnace-wall", "revision": 1,
            "vertices": vertices, "uv0": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "indices": [0, 1, 2, 0, 2, 3],
        }],
        "materials": [{
            "id": "furnace-white-lambert", "baseColor": [1.0, 1.0, 1.0],
            "metallic": 0.0, "roughness": 1.0, "alphaMode": "OPAQUE"
        }],
        "instances": [{
            "id": "furnace-wall", "geometry": "furnace-wall", "material": "furnace-white-lambert",
            "transform": [1.0,0.0,0.0,0.0, 0.0,1.0,0.0,0.0, 0.0,0.0,1.0,0.0, 0.0,0.0,0.0,1.0]
        }],
        "textures": []
    }))
    .expect("furnace wall packet JSON must deserialize");
    validate_packet(&packet).expect("furnace wall packet must pass contract validation");
    packet
}

/// 白炉 frame uniform:默认相机(yaw 0.55、distance 4、focal 2.05)+ 三处覆盖——
/// row13 sunColor = rgb0/w2(直射归零 + 作者灯光模式)、row14 lightingOptions =
/// 曝光 1/阴影短路;row9 background.w 默认 1 即 IBL 开,row15 fogProjection.w
/// 默认 0 即 GI=1,probe GI 开关 row11.w 默认 0。
fn furnace_frame() -> (
    [[f32; 4]; deep_engine_native::mesh_abi::FRAME_UNIFORM_FLOATS / 4],
    PlayerView,
) {
    let view = PlayerView::default();
    let mut frame =
        frame_data_with_camera(PhysicalSize::new(SIZE, SIZE), view, FogSettings::default());
    frame[13] = [0.0, 0.0, 0.0, 2.0];
    frame[14] = [1.0, 0.0, 0.0, 0.0];
    (frame, view)
}

fn render_furnace_frame(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    packet: &RenderPacket,
    label: &'static str,
    layered: bool,
) -> Vec<[f32; 3]> {
    let (frame, view) = furnace_frame();
    render_material_frame(device, queue, packet, label, layered, frame, view)
}

fn render_material_frame(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    packet: &RenderPacket,
    label: &'static str,
    layered: bool,
    frame: [[f32; 4]; deep_engine_native::mesh_abi::FRAME_UNIFORM_FLOATS / 4],
    view: PlayerView,
) -> Vec<[f32; 3]> {
    render_material_frame_with_shader(device, queue, packet, label, layered, frame, view, None)
}

// Explicit render resources and optional shader injection.
#[allow(clippy::too_many_arguments)]
fn render_material_frame_with_shader(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    packet: &RenderPacket,
    label: &'static str,
    layered: bool,
    frame: [[f32; 4]; deep_engine_native::mesh_abi::FRAME_UNIFORM_FLOATS / 4],
    view: PlayerView,
    shader_override: Option<&wgpu::ShaderModule>,
) -> Vec<[f32; 3]> {
    let environment_radiance = FURNACE_ENVIRONMENT_RADIANCE as f32;
    let prepared = prepare_scene(packet).unwrap();
    let pbr = prepare_pbr_resources(packet).unwrap();
    let size = PhysicalSize::new(SIZE, SIZE);
    let layouts = create_frame_layouts(device);
    let shadows = create_shadow_map(device, &layouts.shadow, size, &frame, None, view).unwrap();
    let material_layout = create_material_layout(device);
    // I-C23 分层腿:普通族与分层族(扩展材质 layout + fragment_*_layered 入口)
    // 二选一;GpuScene 同步注入分层 layout,材质 group 才会建 0..19 扩展绑定。
    let layered_layout = layered.then(|| create_layered_material_layout(device));
    let default_shader = shader_override
        .is_none()
        .then(|| create_native_mesh_shader(device));
    let shader = shader_override.unwrap_or_else(|| default_shader.as_ref().unwrap());
    let pipelines = if let Some(layered_layout) = &layered_layout {
        create_mesh_pipelines_with_layered(
            device,
            &layouts.frame,
            &layouts.shadow,
            &material_layout,
            layered_layout,
            shader,
        )
    } else {
        create_mesh_pipelines(
            device,
            &layouts.frame,
            &layouts.shadow,
            &material_layout,
            shader,
        )
    };
    let scene = GpuScene::new(
        device,
        queue,
        &material_layout,
        layered_layout.as_ref(),
        packet,
        scene_content_key(packet),
        &prepared,
        &pbr,
    )
    .unwrap();
    let mut culling = GpuCulling::new(
        device,
        &scene.instance_buffer,
        &prepare_gpu_culling(packet, &prepared).unwrap(),
        &frame,
        &shadows,
        false,
    )
    .unwrap();
    let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: bytemuck::cast_slice(&frame),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let ies = NativeIesShadingResource::prepare(&[], None).unwrap();
    let ies_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("furnace IES identity"),
        contents: ies.bytes(),
        usage: wgpu::BufferUsages::STORAGE,
    });
    // 白炉环境:specular/diffuse 全 mip 均匀 E,LUT 复用内建(与环境无关)。
    let builtin = builtin_default_environment();
    let furnace = uniform_furnace_environment(&builtin, FURNACE_ENVIRONMENT_RADIANCE);
    let ibl = GpuIblEnvironment::new(device, queue, &furnace).unwrap();
    let probe_gi_placeholder = deep_engine_native::probe_gi_storage::disabled_frame_buffer(device);
    let frame_group = ibl.create_frame_bind_group(
        device,
        &layouts.frame,
        &frame_buffer,
        Some(&ies_buffer),
        &shadows,
        Some(&probe_gi_placeholder),
        label,
        true,
    );
    let mut targets = ForwardTargets::new(device, size, false);
    // 白炉背景:native 背景链是纯 clear 色链(无天空采样 pass),显式置 E。
    targets.background = Some([f64::from(environment_radiance); 3]);
    let row_bytes = u64::from(SIZE) * 8;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: row_bytes * u64::from(SIZE),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let mut encoder = device.create_command_encoder(&Default::default());
    culling.encode(queue, &mut encoder);
    encode_opaque_pass(
        &mut encoder,
        &targets,
        &frame_group,
        &scene,
        &culling,
        None,
        &pipelines,
        false,
    );
    encoder.copy_texture_to_buffer(
        targets.resolved_texture().as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row_bytes as u32),
                rows_per_image: Some(SIZE),
            },
        },
        targets.resolved_texture().size(),
    );
    queue.submit([encoder.finish()]);
    culling.commit_submission();
    let pixels = decode_hdr(&map_readback(device, &readback));
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    for error in [
        pollster::block_on(internal.pop()),
        pollster::block_on(memory.pop()),
        pollster::block_on(validation.pop()),
    ] {
        assert!(error.is_none(), "furnace frame GPU error: {error:?}");
    }
    pixels
}

fn assert_all_checks_pass(checks: &[FurnaceCheck]) {
    for check in checks {
        println!(
            "  [{}] {} — {}",
            if check.passed { "PASS" } else { "FAIL" },
            check.name,
            check.detail
        );
    }
    for check in checks {
        assert!(
            check.passed,
            "furnace check {} failed: {}",
            check.name, check.detail
        );
    }
}

#[test]
fn white_furnace_sphere_conserves_energy_two_region() {
    let Some((device, queue)) = request_furnace_device() else {
        println!("white furnace GPU leg skipped: no DX12/Vulkan adapter");
        return;
    };
    let errors = Arc::new(Mutex::new(Vec::new()));
    device.on_uncaptured_error(Arc::new({
        let errors = errors.clone();
        move |error| errors.lock().unwrap().push(error.to_string())
    }));
    let pixels = render_furnace_frame(
        &device,
        &queue,
        &sphere_packet(),
        "white furnace sphere frame",
        false,
    );
    let view = PlayerView::default();
    let segmentation = furnace_sphere_segmentation(
        SIZE as usize,
        SIZE as usize,
        f64::from(view.distance),
        f64::from(SPHERE_RADIUS),
        2.0 * (1.0 / f64::from(view.focal)).atan(),
    );
    let background = region_stats(
        &pixels,
        Some(&segmentation),
        FURNACE_ENVIRONMENT_RADIANCE,
        FurnaceRegion::Background,
    )
    .expect("sphere leg must leave a background region");
    let geometry = region_stats(
        &pixels,
        Some(&segmentation),
        FURNACE_ENVIRONMENT_RADIANCE,
        FurnaceRegion::Geometry,
    )
    .expect("sphere leg must leave a geometry region");
    println!(
        "white furnace sphere leg: background mean={} maxErr={:.4}%, geometry mean={:.6} (E={})",
        background.mean_radiance,
        100.0 * geometry.max_abs_relative_error,
        geometry.mean_radiance,
        FURNACE_ENVIRONMENT_RADIANCE
    );
    assert_all_checks_pass(&evaluate_furnace_checks(Some(background), Some(geometry)));
    let uncaptured = errors.lock().unwrap().clone();
    assert!(
        uncaptured.is_empty(),
        "uncaptured device errors: {uncaptured:?}"
    );
}

#[test]
fn white_furnace_wall_conserves_energy_full_frame() {
    let Some((device, queue)) = request_furnace_device() else {
        println!("white furnace GPU leg skipped: no DX12/Vulkan adapter");
        return;
    };
    let errors = Arc::new(Mutex::new(Vec::new()));
    device.on_uncaptured_error(Arc::new({
        let errors = errors.clone();
        move |error| errors.lock().unwrap().push(error.to_string())
    }));
    let pixels = render_furnace_frame(
        &device,
        &queue,
        &wall_packet(),
        "white furnace wall frame",
        false,
    );
    let geometry = region_stats(
        &pixels,
        None,
        FURNACE_ENVIRONMENT_RADIANCE,
        FurnaceRegion::Geometry,
    )
    .expect("wall leg must cover the full frame");
    println!(
        "white furnace wall leg: mean={} meanErr={:.4}% maxErr={:.4}% p99={:.4}%",
        geometry.mean_radiance,
        100.0 * geometry.mean_relative_error,
        100.0 * geometry.max_abs_relative_error,
        100.0 * geometry.p99_abs_relative_error
    );
    assert_all_checks_pass(&evaluate_furnace_checks(None, Some(geometry)));
    let uncaptured = errors.lock().unwrap().clone();
    assert!(
        uncaptured.is_empty(),
        "uncaptured device errors: {uncaptured:?}"
    );
}

#[path = "white_furnace_layered_gpu_tests.rs"]
mod layered_gpu_tests;

#[test]
#[ignore = "requires a real GPU with the I-C23 layered capability (>= 19 sampled \
            textures per stage); run explicitly with --ignored"]
fn white_furnace_layered_stack_matches_cpu_convexity() {
    layered_gpu_tests::white_furnace_layered_stack_matches_cpu_convexity();
}

#[path = "layered_clearcoat_gpu_tests.rs"]
mod clearcoat_gpu_tests;

#[path = "layered_metal_reflection_gpu_tests.rs"]
mod metal_reflection_gpu_tests;

#[path = "layered_combination_gpu_tests.rs"]
mod combination_gpu_tests;

#[path = "layered_texture_gpu_tests.rs"]
mod texture_gpu_tests;

#[path = "layered_texture_observer.rs"]
mod texture_observer;
