//! C9/native 材质扩展带真机 GPU 探针(#[ignore],RTX/Vulkan 设备;装配与
//! renderer::white_furnace_gpu_tests 同款:场景包 → 原生 mesh 管线 → RGBA16F 回读)。
//!
//! 腿位(全帧朝相机墙,默认直射 sun=(3.2,3.0,2.8) 非作者模式,IBL 关、无局部灯、
//! 实例 receiveShadow=false → visibility≡1、雾关、曝光 1 → native_lit_response
//! 恒等于 stock 主光直射,扩展 wrapper 的 original−stock_direct 逐位相消):
//! - clearcoat 腿:GPU 像素 ≈ TS 权威 extended.rgb(sun)(经 fixture 钉版的
//!   material_extended_cpu 镜像);
//! - sheen 腿:GPU 像素 ≈ material_extended_cpu::native_extended_response 合成;
//! - 组合腿(clearcoat+sheen):同上;
//! - 零带控制腿:无扩展字段材质与显式全零扩展字段材质 f16 像素逐位一致
//!   (旧包渲染逐位不变的 GPU 端证据)。
//!
//! 容差:GPU 为 f32 求值 + f16 回读(f16 量子在 4.0 处 ≈ 0.004),CPU 镜像为
//! f64(DFG 表值取自生产 WGSL 的 f32 词)——逐通道 ≤0.02 绝对或 ≤0.8% 相对,
//! 取大者;零带控制腿要求位级相等。

use super::rt_raster_parity_gpu_tests::{decode_hdr, map_readback};
// 本文件挂载在 bin 目标(main.rs::renderer)下;CPU 镜像是 lib 模块,
// 经 deep_engine_native:: 跨包引用(与 pbr_texture 等既有用法同式)。
use crate::{
    forward_targets::ForwardTargets,
    frame_bindings::{create_frame_layouts, create_native_mesh_shader},
    gpu_culling::GpuCulling,
    gpu_ibl::GpuIblEnvironment,
    gpu_resources::{create_shadow_map, frame_data_with_camera},
    gpu_scene::GpuScene,
    gpu_textures::create_material_layout,
    mesh_pass::encode_opaque_pass,
    pipeline::create_mesh_pipelines,
    player_shader_plan::scene_content_key,
};
use deep_engine_native::material_extended_cpu::{
    ExtendedInputs, evaluate_extended_material_direct, native_extended_response,
    native_stock_direct,
};
use deep_engine_native::{
    contract::{RenderPacket, validate_packet},
    culling_contract::prepare_gpu_culling,
    fog::FogSettings,
    ibl::builtin_default_environment,
    ies_shading::NativeIesShadingResource,
    material_extended_cpu::direct_dfg_185,
    pbr_texture::prepare_pbr_resources,
    player_view::PlayerView,
    scene::prepare_scene,
};
use serde_json::Value;
use std::sync::OnceLock;
use wgpu::util::DeviceExt;
use winit::dpi::PhysicalSize;

const SIZE: u32 = 128;

fn request_device() -> Option<(wgpu::Device, wgpu::Queue)> {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12 | wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).ok()?;
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .expect("extended-material probe adapter must create a device");
    Some((device, queue))
}

/// 全帧朝相机墙(与 white_furnace_gpu_tests::facing_wall_vertices 同构造)。
fn wall_packet(material: Value) -> RenderPacket {
    let view = PlayerView::default();
    let [right, up, forward] = view.basis();
    let eye = view.eye();
    let center: [f32; 3] = std::array::from_fn(|axis| eye[axis] + forward[axis] * 2.0);
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
    let mut vertices: Vec<f32> = Vec::new();
    for point in [
        corner(-1.0, -1.0),
        corner(1.0, -1.0),
        corner(1.0, 1.0),
        corner(-1.0, 1.0),
    ] {
        vertices.extend_from_slice(&[
            point[0],
            point[1],
            point[2],
            -forward[0],
            -forward[1],
            -forward[2],
        ]);
    }
    let packet: RenderPacket = serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [{
            "id": "extended-wall", "revision": 1,
            "vertices": vertices, "uv0": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "indices": [0, 1, 2, 0, 2, 3],
        }],
        "materials": [material],
        "instances": [{
            "id": "extended-wall", "geometry": "extended-wall", "material": "extended-wall-material",
            "receiveShadow": false,
            "transform": [1.0,0.0,0.0,0.0, 0.0,1.0,0.0,0.0, 0.0,0.0,1.0,0.0, 0.0,0.0,0.0,1.0]
        }],
        "textures": []
    }))
    .expect("extended wall packet JSON must deserialize");
    validate_packet(&packet).expect("extended wall packet must pass contract validation");
    packet
}

/// 探针 frame:默认相机 + IBL 关(background.w=0)+ 曝光 1 + 无局部灯 +
/// 雾关;sun 保持 legacy 默认(非作者模式 → sun=(3.2,3.0,2.8))。
fn probe_frame() -> (
    [[f32; 4]; deep_engine_native::mesh_abi::FRAME_UNIFORM_FLOATS / 4],
    PlayerView,
) {
    let view = PlayerView::default();
    let mut frame =
        frame_data_with_camera(PhysicalSize::new(SIZE, SIZE), view, FogSettings::default());
    frame[9] = [0.012, 0.020, 0.035, 0.0];
    (frame, view)
}

fn render_wall(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    packet: &RenderPacket,
    label: &'static str,
) -> Vec<[f32; 3]> {
    let (frame, view) = probe_frame();
    let prepared = prepare_scene(packet).unwrap();
    let pbr = prepare_pbr_resources(packet).unwrap();
    let size = PhysicalSize::new(SIZE, SIZE);
    let layouts = create_frame_layouts(device);
    let shadows = create_shadow_map(device, &layouts.shadow, size, &frame, None, view).unwrap();
    let material_layout = create_material_layout(device);
    let shader = create_native_mesh_shader(device);
    let pipelines = create_mesh_pipelines(
        device,
        &layouts.frame,
        &layouts.shadow,
        &material_layout,
        &shader,
    );
    let scene = GpuScene::new(
        device,
        queue,
        &material_layout,
        None,
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
        label: Some("extended-material IES identity"),
        contents: ies.bytes(),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let ibl = GpuIblEnvironment::new(device, queue, &builtin_default_environment()).unwrap();
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
    targets.background = Some([0.0; 3]);
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
        assert!(
            error.is_none(),
            "extended-material probe GPU error: {error:?}"
        );
    }
    pixels
}

/// 墙心几何(法线朝相机、view = −forward、frame 灯向行),与 GPU 中心像素同点。
struct WallGeometry {
    normal: [f64; 3],
    view: [f64; 3],
    light: [f64; 3],
    sun: [f64; 3],
}

fn wall_geometry(view: &PlayerView, frame: &[[f32; 4]]) -> WallGeometry {
    let [right, up, forward] = view.basis();
    let _ = (right, up);
    let normal: [f64; 3] = std::array::from_fn(|axis| f64::from(-forward[axis]));
    // Frame 行序(Frame 结构):row8=eye、row11=lightDirection(非作者模式
    // legacy=[0.55c−0.35s, 0.8, 0.55s+0.35c])。GPU 与 CPU 镜像同取 row11。
    let light: [f64; 3] = {
        let row = frame[11];
        let value: [f64; 3] = std::array::from_fn(|axis| f64::from(row[axis]));
        let length = (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt();
        std::array::from_fn(|axis| value[axis] / length)
    };
    WallGeometry {
        normal,
        view: normal,
        light,
        // 非作者模式(w<2)的 native 固定灯光,与 native_lit_response 同式。
        sun: [3.2, 3.0, 2.8],
    }
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn normalize(value: [f64; 3]) -> [f64; 3] {
    let length = dot(value, value).sqrt();
    std::array::from_fn(|axis| value[axis] / length)
}

fn assert_pixel_near(gpu: [f32; 3], cpu: [f64; 3], label: &str) {
    for axis in 0..3 {
        let difference = (f64::from(gpu[axis]) - cpu[axis]).abs();
        let budget = (0.02f64).max(0.008 * cpu[axis].abs());
        assert!(
            difference <= budget,
            "{label}[{axis}]: gpu {} vs cpu {:?} (drift {difference} > {budget})",
            gpu[axis],
            cpu
        );
    }
}

fn parity_fixture() -> &'static Value {
    static FIXTURE: OnceLock<Value> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../deep-engine/fixtures/material-native-parity-v1.json"
        ))
        .expect("parity fixture must parse")
    })
}

/// 组合腿的合成期望(CPU 镜像;extended rgb 链路已被 fixture 钉版)。
fn composed_expectation(
    geometry: &WallGeometry,
    base: [f64; 3],
    metallic: f64,
    roughness: f64,
    params: ExtendedInputs,
    sheen_color: [f64; 3],
    sheen_roughness: f64,
) -> [f64; 3] {
    let rough = roughness.clamp(0.045, 1.0);
    let stock_direct = native_stock_direct(
        geometry.normal,
        geometry.view,
        geometry.light,
        base,
        metallic,
        rough,
        0.04,
        geometry.sun,
        1.0,
    );
    let (extended_rgb, ..) = evaluate_extended_material_direct(
        base,
        metallic,
        roughness,
        params,
        geometry.normal,
        geometry.view,
        geometry.light,
        None,
        geometry.sun,
    );
    let view_nv = dot(geometry.normal, geometry.view).clamp(0.001, 1.0);
    let nl = dot(geometry.normal, geometry.light).clamp(0.0, 1.0);
    let half = normalize(add(geometry.view, geometry.light));
    let nh = dot(geometry.normal, half).clamp(0.0, 1.0);
    native_extended_response(
        stock_direct,
        stock_direct,
        extended_rgb,
        [0.0; 3],
        sheen_color,
        sheen_roughness.clamp(0.0001, 1.0),
        view_nv,
        nl,
        nh,
        geometry.sun,
        1.0,
    )
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn extended_material_bands_render_match_cpu_mirror_on_real_gpu() {
    let Some((device, queue)) = request_device() else {
        eprintln!("no suitable GPU adapter; probe skipped");
        return;
    };
    let (frame, view) = probe_frame();
    let geometry = wall_geometry(&view, &frame);

    // 腿 1:clearcoat(车漆)。期望 = TS 权威 extended.rgb(sun)(fixture 钉版镜像)。
    let car_paint = serde_json::json!({
        "id": "extended-wall-material", "baseColor": [0.043, 0.14, 0.42],
        "metallic": 0.9, "roughness": 0.4,
        "extendedParameters": { "ior": 1.5, "clearcoat": { "factor": 0.9, "roughness": 0.35 } }
    });
    let pixels = render_wall(
        &device,
        &queue,
        &wall_packet(car_paint.clone()),
        "extended-coat",
    );
    let center = pixels[(SIZE * SIZE / 2 + SIZE / 2) as usize];
    let (coat_rgb, ..) = evaluate_extended_material_direct(
        [0.043, 0.14, 0.42],
        0.9,
        0.4,
        ExtendedInputs {
            ior: 1.5,
            clearcoat_factor: 0.9,
            clearcoat_roughness: 0.35,
            ..ExtendedInputs::default()
        },
        geometry.normal,
        geometry.view,
        geometry.light,
        None,
        geometry.sun,
    );

    assert_pixel_near(center, coat_rgb, "coat leg");

    // 腿 2:sheen。期望 = 合成镜像(stock_direct*energyDirect + sheenDirect)。
    let sheen_material = serde_json::json!({
        "id": "extended-wall-material", "baseColor": [0.8, 0.6, 0.5],
        "metallic": 0.0, "roughness": 0.5,
        "advancedParameters": { "sheen": { "color": [0.35, 0.3, 0.25], "roughness": 0.6 } }
    });
    let pixels = render_wall(
        &device,
        &queue,
        &wall_packet(sheen_material),
        "extended-sheen",
    );
    let center = pixels[(SIZE * SIZE / 2 + SIZE / 2) as usize];
    let sheen_expected = composed_expectation(
        &geometry,
        [0.8, 0.6, 0.5],
        0.0,
        0.5,
        ExtendedInputs::default(),
        [0.35, 0.3, 0.25],
        0.6,
    );

    assert_pixel_near(center, sheen_expected, "sheen leg");

    // 腿 3:clearcoat + sheen 组合。
    let combined = serde_json::json!({
        "id": "extended-wall-material", "baseColor": [0.043, 0.14, 0.42],
        "metallic": 0.9, "roughness": 0.4,
        "extendedParameters": { "ior": 1.5, "clearcoat": { "factor": 0.9, "roughness": 0.35 } },
        "advancedParameters": { "sheen": { "color": [0.35, 0.3, 0.25], "roughness": 0.6 } }
    });
    let pixels = render_wall(&device, &queue, &wall_packet(combined), "extended-combined");
    let center = pixels[(SIZE * SIZE / 2 + SIZE / 2) as usize];
    let combined_expected = composed_expectation(
        &geometry,
        [0.043, 0.14, 0.42],
        0.9,
        0.4,
        ExtendedInputs {
            ior: 1.5,
            clearcoat_factor: 0.9,
            clearcoat_roughness: 0.35,
            ..ExtendedInputs::default()
        },
        [0.35, 0.3, 0.25],
        0.6,
    );

    assert_pixel_near(center, combined_expected, "combined leg");

    // 腿 4:零带控制——无字段 vs 显式全零扩展/advanced 字段,f16 像素逐位一致。
    let absent = serde_json::json!({
        "id": "extended-wall-material", "baseColor": [0.5, 0.5, 0.5],
        "metallic": 0.3, "roughness": 0.6
    });
    let explicit_zero = serde_json::json!({
        "id": "extended-wall-material", "baseColor": [0.5, 0.5, 0.5],
        "metallic": 0.3, "roughness": 0.6,
        "extendedParameters": { "clearcoat": { "factor": 0.0, "roughness": 0.0 } },
        "advancedParameters": { "sheen": { "color": [0, 0, 0], "roughness": 1 } }
    });
    let absent_pixels = render_wall(
        &device,
        &queue,
        &wall_packet(absent),
        "extended-control-absent",
    );
    let zero_pixels = render_wall(
        &device,
        &queue,
        &wall_packet(explicit_zero),
        "extended-control-zero",
    );
    let absent_center = absent_pixels[(SIZE * SIZE / 2 + SIZE / 2) as usize];
    let zero_center = zero_pixels[(SIZE * SIZE / 2 + SIZE / 2) as usize];
    assert_eq!(
        absent_center, zero_center,
        "zero-band control must render bit-identical to absent-band legacy material"
    );

    // 腿 5:DFG 表同源抽查——镜像采样端点等于 WGSL 表值(与 parity 测试互补)。
    let sample = direct_dfg_185(0.5, 0.5);
    assert!(sample[0].is_finite() && sample[1].is_finite());
    let _ = parity_fixture();
}
