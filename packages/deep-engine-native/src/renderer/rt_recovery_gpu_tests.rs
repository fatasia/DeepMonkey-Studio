//! F2 设备恢复证据(真机 ray-query 设备):设备丢失后原生查看器的恢复链是
//! `gpu_context.rs` 的 `set_device_lost_callback` → `GpuEvent::DeviceLost` →
//! `app/recovery.rs` 把整个 Renderer 丢弃重建(`app.renderer = None` →
//! `initialize_renderer`),init.rs 从场景全新 `RtSceneResidency::build`。
//! RT 驻留、RT frame 槽绑定、RT pixel 管线族都是 Renderer 的普通字段,没有
//! 任何跨 Renderer 的全局/静态句柄,因此旧资源随旧实例一次性析构——本测试
//! 在资源层面钉住这条链:
//! 1. 初建驻留被真实 Ray Query 探针命中(基线可用);
//! 2. 整体 drop 旧驻留(模拟旧 Renderer 析构)后,全新 build 自足可用:
//!    探针仍然命中,计划逐槽一致——重建是 (device, scene) 的纯函数,
//!    BLAS/TLAS 槽位从零重新派生,不复用旧实例的任何状态;
//! 3. 重建后 frame RT 槽按生产路径重挂、RT 管线族重新安装,逐帧裁决
//!    `rt_opaque_ready` 从回退栅格(None)恢复到 RT 就绪(Some);
//! 4. 全程 error scope 与 uncaptured error 干净(不崩、不悬挂)。
//!
//! 非 RT 适配器跳过(与 rt_pixel_gpu_tests 同界)。Renderer 结构体本身
//! 持有窗口表面,无法脱离 winit 构造,故在驻留/槽位资源层等价重建,
//! 与 init.rs/reestablish_rt_residency 消费同一批函数。

use crate::{
    frame_bindings::{create_frame_layouts, create_native_mesh_rt_shader},
    gpu_ibl::GpuIblEnvironment,
    gpu_resources::{create_shadow_map, frame_data_with_camera},
    gpu_scene::GpuScene,
    gpu_textures::create_material_layout,
    pipeline::create_rt_mesh_pipelines,
    player_shader_plan::scene_content_key,
    renderer::rt_residency::{RtSceneResidency, rt_opaque_ready},
};
use deep_engine_native::{
    fog::FogSettings,
    hardware_ray_query::encode_ray_query_for_tlas,
    ibl::disabled_probe_environment,
    ies_shading::NativeIesShadingResource,
    pbr_texture::prepare_pbr_resources,
    player_view::PlayerView,
    scene::prepare_scene,
};
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;
use winit::dpi::PhysicalSize;

const SIZE: u32 = 128;

/// 经真实 Ray Query dispatch 探测 TLAS:射线 (0,0,2)→-z 命中悬浮箱前表面。
/// 返回 hit[0](1=命中)。先清零结果缓冲再单 submit(build 已在前序 submit
/// 按 FIFO 完成),与 hardware_ray_query 的真机探针同序。
fn probe_hit(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    result: &wgpu::Buffer,
    readback: &wgpu::Buffer,
    tlas: &wgpu::Tlas,
) -> u32 {
    queue.write_buffer(result, 0, bytemuck::cast_slice(&[0u32]));
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("F2 recovery ray-query probe"),
    });
    encode_ray_query_for_tlas(device, &mut encoder, tlas, result);
    encoder.copy_buffer_to_buffer(result, 0, readback, 0, 4);
    queue.submit([encoder.finish()]);
    let bytes = super::rt_raster_parity_gpu_tests::map_readback(device, readback);
    u32::from_le_bytes(bytes[0..4].try_into().expect("u32 readback"))
}

#[test]
fn rt_residency_rebuild_after_device_loss_is_self_sufficient() {
    let Some((device, queue)) = super::request_ray_query_device() else {
        return;
    };
    let errors = Arc::new(Mutex::new(Vec::new()));
    let captured = errors.clone();
    device.on_uncaptured_error(Arc::new(move |error| {
        captured.lock().unwrap().push(error.to_string())
    }));

    // 场景与像素对拍基准同源(地面 + 悬浮箱,双 opaque 实例)。
    let packet = super::rt_raster_parity_gpu_tests::parity_packet();
    let prepared = prepare_scene(&packet).unwrap();
    let pbr = prepare_pbr_resources(&packet).unwrap();
    let material_layout = create_material_layout(&device);
    let scene = GpuScene::new(
        &device,
        &queue,
        &material_layout,
        &packet,
        scene_content_key(&packet),
        &prepared,
        &pbr,
    )
    .unwrap();

    // 共享探针结果缓冲:两阶段各走一次 dispatch,读回比对。
    // (COPY_DST 供 queue.write_buffer 每次探针前清零;STORAGE 供 ray
    // query 写入;COPY_SRC 供读回拷贝。)
    let probe_result = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("F2 recovery probe result"),
        contents: bytemuck::cast_slice(&[0u32]),
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
    });
    let probe_readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("F2 recovery probe readback"),
        size: 4,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    // ---- 阶段 A:初建驻留(与 init.rs 首建同路径)----
    let (residency_a, blas_encoder_a, tlas_encoder_a) =
        RtSceneResidency::build(&device, &scene).expect("initial residency must build");
    // 计划快照:重建后逐槽比对(槽位派生只依赖场景,不依赖旧实例)。
    let plan_a = residency_a.plan().clone();
    let blas_count_a = residency_a.blas_count();
    assert_eq!(plan_a.instances.len(), 2, "both opaque instances resident");
    assert_eq!(blas_count_a, 2, "ground + box = one BLAS each");
    queue.submit([blas_encoder_a.finish(), tlas_encoder_a.finish()]);
    let hit_a = probe_hit(&device, &queue, &probe_result, &probe_readback, residency_a.tlas());
    assert_eq!(hit_a, 1, "initial TLAS must answer the ray-query probe");

    // ---- 阶段 B:模拟设备丢失——旧 Renderer 连同其全部 RT 资源析构 ----
    // 生产路径是 app/recovery.rs 整体丢弃 Renderer;此处显式 drop 驻留,
    // 保证后续重建不可能隐式借用旧 BLAS/TLAS。
    drop(residency_a);

    // 重建 = 全新 RtSceneResidency::build(与 initialize_renderer→init.rs
    // 同路径)。旧实例已析构,重建必须完全自足。
    let (mut residency_b, blas_encoder_b, tlas_encoder_b) =
        RtSceneResidency::build(&device, &scene)
            .expect("rebuild after device loss must succeed from the scene alone");
    assert_eq!(
        *residency_b.plan(),
        plan_a,
        "rebuild plan must be re-derived per slot, identical to the initial plan"
    );
    assert_eq!(
        residency_b.blas_count(),
        blas_count_a,
        "rebuild BLAS cache must match the initial geometry dedup"
    );
    queue.submit([blas_encoder_b.finish(), tlas_encoder_b.finish()]);
    let hit_b = probe_hit(&device, &queue, &probe_result, &probe_readback, residency_b.tlas());
    assert_eq!(
        hit_b, 1,
        "rebuilt TLAS must answer the probe without the dropped residency"
    );

    // ---- 阶段 C:重建后的 frame RT 槽恢复(生产路径的槽位状态机)----
    // 干净态:刚重建、槽未挂、管线族未装——逐帧裁决必须回退栅格,绝不
    // 使用半途状态。
    let ready_before_slot = rt_opaque_ready::<wgpu::BindGroup>(
        Some(&residency_b),
        None,
        false,
    );
    assert!(
        ready_before_slot.is_none(),
        "rebuilt residency without the frame RT slot must fall back to raster"
    );
    // 按生产路径重挂 frame RT 槽(ibl.create_rt_frame_bind_group 引用重建
    // 后的 TLAS)并重装 RT 管线族,裁决恢复到 RT 就绪。
    let layouts = create_frame_layouts(&device);
    let frame_rt = layouts
        .frame_rt
        .expect("ray-query device must expose the RT frame layout");
    let size = PhysicalSize::new(SIZE, SIZE);
    let view = PlayerView { yaw: 0.55, ..Default::default() };
    let frame = frame_data_with_camera(size, view, FogSettings::default());
    let shadows =
        create_shadow_map(&device, &layouts.shadow, size, &frame, None, view).unwrap();
    let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("F2 recovery frame uniform"),
        contents: bytemuck::cast_slice(&frame),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let ies = NativeIesShadingResource::prepare(&[], None).unwrap();
    let ies_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("F2 recovery IES identity"),
        contents: ies.bytes(),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let ibl = GpuIblEnvironment::new(&device, &queue, &disabled_probe_environment()).unwrap();
    let probe_gi_placeholder = deep_engine_native::probe_gi_storage::disabled_frame_buffer(&device);
    let rt_group = ibl.create_rt_frame_bind_group(
        &device,
        &frame_rt,
        &frame_buffer,
        Some(&ies_buffer),
        &shadows,
        residency_b.tlas(),
        Some(&probe_gi_placeholder),
        "F2 recovery RT frame bindings",
    );
    let rt_pipelines = create_rt_mesh_pipelines(
        &device,
        &frame_rt,
        &material_layout,
        &create_native_mesh_rt_shader(&device),
    );
    residency_b.install_pixel_pipelines(rt_pipelines);
    let ready_after_recovery =
        rt_opaque_ready(Some(&residency_b), Some(&rt_group), false);
    assert!(
        ready_after_recovery.is_some(),
        "after re-binding the frame RT slot and reinstalling pipelines the frame loop must take the RT branch again"
    );

    // 干净收尾:无 uncaptured 错误。
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    assert!(
        errors.lock().unwrap().is_empty(),
        "uncaptured GPU errors during recovery: {:?}",
        errors.lock().unwrap()
    );
}
