//! F2 回退证据(真机,同适配器双设备):RT 不可用时管线路径必须整体回落
//! 栅格分支、渲染不崩、结果与纯栅格一致。诚实边界:本机只有 ray-query
//! GPU,拿不到"物理无 RT"的适配器;做法是在同一适配器上按产品同一条
//! 判定路径(`device.features()` 是否含 EXPERIMENTAL_RAY_QUERY)创建一台
//! **不带该特征**的 device——与真实无 RT 设备走完全相同的降级分支,
//! 而不是在 RT 设备上假装跳过。三组证据:
//! 1. 无特征设备:frame_rt layout 不创建(frame RT 槽缺失)、驻留构建
//!    fail-closed 拒绝(MissingFeature),栅格全链(级联阴影 + opaque)
//!    干净渲染,像素与 RT 设备同路径栅格基线逐像素一致;
//! 2. 全 BLEND 场景:真机上驻留构建返回 EmptyScene(与 classify_rt_batches
//!    的 CPU 合同同口径),帧循环必然回退栅格;
//! 3. `rt_opaque_ready` 裁决函数在真实驻留/槽位/管线族对象上的边界:
//!    管线族缺失回退、槽未挂回退、custom shader 场景回退、全就绪走 RT。

use crate::{
    forward_targets::ForwardTargets,
    frame_bindings::{
        FrameLayouts, create_frame_layouts, create_native_mesh_rt_shader, create_native_mesh_shader,
    },
    gpu_culling::GpuCulling,
    gpu_ibl::GpuIblEnvironment,
    gpu_resources::{create_shadow_map, frame_data_with_camera},
    gpu_scene::GpuScene,
    gpu_textures::create_material_layout,
    mesh_pass::encode_opaque_pass,
    pipeline::{MeshPipelines, create_mesh_pipelines, create_rt_mesh_pipelines},
    player_shader_plan::scene_content_key,
    renderer::rt_residency::{RtResidencyReject, RtSceneResidency, rt_opaque_ready},
    shadow_map::ShadowMap,
    shadow_pass::{CascadeScene, encode_shadow_cascades},
};
use deep_engine_native::{
    contract::{RenderPacket, validate_packet},
    culling_contract::prepare_gpu_culling,
    fog::FogSettings,
    half_decode::half_to_f32,
    ibl::disabled_probe_environment,
    ies_shading::NativeIesShadingResource,
    mesh_abi::FrameUniform,
    pbr_texture::{PreparedPbrResources, prepare_pbr_resources},
    player_view::PlayerView,
    scene::{PreparedScene, prepare_scene},
};
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;
use winit::dpi::PhysicalSize;

const SIZE: u32 = 128;

/// 全 BLEND 场景:单地面几何 + BLEND 材质单实例。合同:BLEND 整族不进
/// TLAS(Web renderPacketRayScene 同口径),全 BLEND 场景计划核必然
/// EmptyScene 拒绝。
fn blend_packet() -> RenderPacket {
    let vertices: Vec<f32> = vec![
        // 地面 4 顶点(+y 法线,外向 CCW,与 parity 场景同绕序)。
        -1.0, -1.0, -1.0, 0.0, 1.0, 0.0, //
        -1.0, -1.0, 1.0, 0.0, 1.0, 0.0, //
        1.0, -1.0, 1.0, 0.0, 1.0, 0.0, //
        1.0, -1.0, -1.0, 0.0, 1.0, 0.0,
    ];
    let packet: RenderPacket = serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [
            {
                "id": "blend-ground", "revision": 1,
                "vertices": vertices, "uv0": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                "indices": [0, 1, 2, 0, 2, 3],
            }
        ],
        "materials": [
            { "id": "blend-pane", "baseColor": [0.4, 0.6, 0.9], "metallic": 0.0,
              "roughness": 0.5, "alphaMode": "BLEND" }
        ],
        "instances": [
            { "id": "pane", "geometry": "blend-ground", "material": "blend-pane",
              "transform": [1.0,0.0,0.0,0.0, 0.0,1.0,0.0,0.0, 0.0,0.0,1.0,0.0, 0.0,0.0,0.0,1.0] }
        ],
        "textures": []
    }))
    .expect("blend packet JSON must deserialize");
    validate_packet(&packet).expect("blend packet must pass contract validation");
    packet
}

/// 同一适配器请求两台设备:RT 基线设备(带 ray-query 特征)与降级设备
/// (默认特征,不含 ray-query)。适配器缺失或非 RT 适配器返回 None
/// (与 rt_pixel_gpu_tests 同界跳过)。
fn request_rt_and_plain_devices() -> Option<(wgpu::Device, wgpu::Queue, wgpu::Device, wgpu::Queue)>
{
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::DX12 | wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).ok()?;
    if !adapter
        .features()
        .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
    {
        return None;
    }
    let (rt_device, rt_queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            required_features: wgpu::Features::EXPERIMENTAL_RAY_QUERY,
            experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
            required_limits: {
                let available = adapter.limits();
                let mut limits = wgpu::Limits::default();
                limits.max_blas_primitive_count = available.max_blas_primitive_count;
                limits.max_blas_geometry_count = available.max_blas_geometry_count;
                limits.max_tlas_instance_count = available.max_tlas_instance_count;
                limits.max_acceleration_structures_per_shader_stage =
                    available.max_acceleration_structures_per_shader_stage;
                limits.max_buffers_and_acceleration_structures_per_shader_stage =
                    available.max_buffers_and_acceleration_structures_per_shader_stage;
                limits
            },
            ..Default::default()
        }))
        .expect("RT-capable adapter must create a ray-query device");
    // 降级设备:默认特征(不含 ray query)。与真实无 RT 设备同判定路径:
    // create_frame_layouts / 驻留构建 / 帧循环裁决都只看 device.features()。
    let (plain_device, plain_queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .expect("adapter must also create a plain device");
    assert!(
        !plain_device
            .features()
            .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY),
        "plain device must not carry the ray-query feature"
    );
    Some((rt_device, rt_queue, plain_device, plain_queue))
}

/// 单台设备上的完整栅格链(资源全部 owned:wgpu 句柄是 Arc 克隆,结构体
/// 持有不影响共享)。两台设备各自建链,CPU 输入(packet/frame/相机)逐位
/// 一致,设备差异就是唯一变量。
struct RasterChain {
    device: wgpu::Device,
    queue: wgpu::Queue,
    #[allow(dead_code)] // frame_group/shadow layout 借用方只经 bind group 消费
    layouts: FrameLayouts,
    scene: GpuScene,
    pipelines: MeshPipelines,
    culling: GpuCulling,
    targets: ForwardTargets,
    frame_group: wgpu::BindGroup,
    shadow_map: ShadowMap,
    readback: wgpu::Buffer,
}

impl RasterChain {
    /// 建链:布局/材质 layout/场景/管线族/剔除/帧绑定/读回缓冲,与
    /// rt_raster_parity_gpu_tests 的栅格侧完全同构。
    fn build(
        device: wgpu::Device,
        queue: wgpu::Queue,
        packet: &RenderPacket,
        prepared: &PreparedScene,
        pbr: &PreparedPbrResources,
        frame: &FrameUniform,
        size: PhysicalSize<u32>,
        view: PlayerView,
    ) -> Self {
        let layouts = create_frame_layouts(&device);
        let material_layout = create_material_layout(&device);
        let scene = GpuScene::new(
            &device,
            &queue,
            &material_layout,
            packet,
            scene_content_key(packet),
            prepared,
            pbr,
        )
        .expect("scene must stay resident on the raster chain");
        let pipelines = create_mesh_pipelines(
            &device,
            &layouts.frame,
            &layouts.shadow,
            &material_layout,
            &create_native_mesh_shader(&device),
        );
        let shadow_map = create_shadow_map(&device, &layouts.shadow, size, frame, None, view)
            .expect("shadow map must build");
        let culling = GpuCulling::new(
            &device,
            &scene.instance_buffer,
            &prepare_gpu_culling(packet, prepared).unwrap(),
            frame,
            &shadow_map,
            false,
        )
        .unwrap();
        let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("F2 fallback frame uniform"),
            contents: bytemuck::cast_slice(frame),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let ies = NativeIesShadingResource::prepare(&[], None).unwrap();
        let ies_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("F2 fallback IES identity"),
            contents: ies.bytes(),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let ibl = GpuIblEnvironment::new(&device, &queue, &disabled_probe_environment()).unwrap();
        // GI 探针槽用生产同款全零占位(validity=0,采样分支返回零)。
        let probe_gi_placeholder =
            deep_engine_native::probe_gi_storage::disabled_frame_buffer(&device);
        let frame_group = ibl.create_frame_bind_group(
            &device,
            &layouts.frame,
            &frame_buffer,
            Some(&ies_buffer),
            &shadow_map,
            Some(&probe_gi_placeholder),
            "F2 fallback frame bindings",
            true,
        );
        let targets = ForwardTargets::new(&device, size, false);
        let row_bytes = u64::from(SIZE) * 8;
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("F2 fallback raster readback"),
            size: row_bytes * u64::from(SIZE),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        Self {
            device,
            queue,
            layouts,
            scene,
            pipelines,
            culling,
            targets,
            frame_group,
            shadow_map,
            readback,
        }
    }

    /// 渲染一帧栅格:剔除 → 级联阴影 → opaque indirect → 读回拷贝,
    /// 单 submit FIFO(与 parity 对拍同构)。
    fn render_frame(&mut self) {
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("F2 fallback raster frame"),
            });
        self.culling.encode(&self.queue, &mut encoder);
        encode_shadow_cascades(
            &mut encoder,
            &CascadeScene {
                shadow_map: &self.shadow_map,
                scene: &self.scene,
                culling: &self.culling,
                lod: None,
                pipelines: &self.pipelines,
            },
            u16::MAX,
        );
        encode_opaque_pass(
            &mut encoder,
            &self.targets,
            &self.frame_group,
            &self.scene,
            &self.culling,
            None,
            &self.pipelines,
            false,
        );
        let row_bytes = (u64::from(SIZE) * 8) as u32;
        encoder.copy_texture_to_buffer(
            self.targets.resolved_texture().as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &self.readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row_bytes),
                    rows_per_image: Some(SIZE),
                },
            },
            self.targets.resolved_texture().size(),
        );
        self.queue.submit([encoder.finish()]);
        self.culling.commit_submission();
    }

    /// RGBA16F 读回解码。
    fn read_pixels(&self) -> Vec<[f32; 3]> {
        super::rt_raster_parity_gpu_tests::map_readback(&self.device, &self.readback)
            .chunks_exact(8)
            .map(|pixel| {
                let channel = |lane: usize| {
                    half_to_f32(u16::from_le_bytes([pixel[lane * 2], pixel[lane * 2 + 1]]))
                };
                [channel(0), channel(1), channel(2)]
            })
            .collect()
    }
}

/// 无 ray-query 特征设备的全链降级:布局/驻留/栅格渲染逐级断言,并与
/// RT 设备上的同路径栅格基线逐像素对拍。
#[test]
fn device_without_ray_query_feature_stays_on_raster_and_matches_baseline() {
    let Some((rt_device, rt_queue, plain_device, plain_queue)) = request_rt_and_plain_devices()
    else {
        return;
    };
    // 两台设备各自挂 uncaptured error 收集:任何一台报错都算失败(不崩)。
    let rt_errors = Arc::new(Mutex::new(Vec::new()));
    let plain_errors = Arc::new(Mutex::new(Vec::new()));
    for (device, errors) in [(&rt_device, &rt_errors), (&plain_device, &plain_errors)] {
        let captured = errors.clone();
        device.on_uncaptured_error(Arc::new(move |error| {
            captured.lock().unwrap().push(error.to_string())
        }));
    }

    let packet = super::rt_raster_parity_gpu_tests::parity_packet();
    let prepared = prepare_scene(&packet).unwrap();
    let pbr = prepare_pbr_resources(&packet).unwrap();
    let size = PhysicalSize::new(SIZE, SIZE);
    let view = PlayerView {
        yaw: 0.55,
        ..Default::default()
    };
    let frame = frame_data_with_camera(size, view, FogSettings::default());

    // 降级设备的判定链(与 init.rs/reestablish_rt_residency 同源):
    // ① frame_rt layout 不创建——frame RT 槽在无特征设备上根本不存在;
    let plain_layouts_probe = create_frame_layouts(&plain_device);
    assert!(
        plain_layouts_probe.frame_rt.is_none(),
        "no-feature device must not create the RT frame layout"
    );
    // ② 驻留构建 fail-closed:驻留槽保持空,帧循环据此逐帧回退栅格。
    //    (build 的 Result 载荷含 wgpu 资源,不可 Debug,用 matches! 断言。)
    let plain_material_layout = create_material_layout(&plain_device);
    let plain_scene = GpuScene::new(
        &plain_device,
        &plain_queue,
        &plain_material_layout,
        &packet,
        scene_content_key(&packet),
        &prepared,
        &pbr,
    )
    .unwrap();
    assert!(
        matches!(
            RtSceneResidency::build(&plain_device, &plain_scene),
            Err(RtResidencyReject::MissingFeature)
        ),
        "no-feature device must reject residency build fail-closed"
    );
    drop(plain_scene);
    drop(plain_material_layout);

    // ③ 两台设备各建完整栅格链,各渲染一帧:无特征设备的栅格主通路必须
    //    照常工作(不崩、无 validation/uncaptured 错误)。
    let mut plain_chain = RasterChain::build(
        plain_device,
        plain_queue,
        &packet,
        &prepared,
        &pbr,
        &frame,
        size,
        view,
    );
    let mut rt_chain = RasterChain::build(
        rt_device, rt_queue, &packet, &prepared, &pbr, &frame, size, view,
    );
    let plain_validation = plain_chain
        .device
        .push_error_scope(wgpu::ErrorFilter::Validation);
    let rt_validation = rt_chain
        .device
        .push_error_scope(wgpu::ErrorFilter::Validation);
    plain_chain.render_frame();
    rt_chain.render_frame();
    let plain_pixels = plain_chain.read_pixels();
    let rt_pixels = rt_chain.read_pixels();
    for (name, error) in [
        ("plain", pollster::block_on(plain_validation.pop())),
        ("rt", pollster::block_on(rt_validation.pop())),
    ] {
        assert!(error.is_none(), "{name} device validation error: {error:?}");
    }
    for (name, errors) in [("plain", &plain_errors), ("rt", &rt_errors)] {
        assert!(
            errors.lock().unwrap().is_empty(),
            "{name} device uncaptured GPU errors: {:?}",
            errors.lock().unwrap()
        );
    }

    // 逐像素对拍:两台设备跑同一栅格路径、同一 CPU 输入,唯一差异是
    // device 对象;f16 半浮点量化下应当逐位一致,容差只留 2 ulp 防驱动
    // 非确定性。同时校验画面非空转(有直射光、有阴影带),避免全黑对拍。
    let luminance = |rgb: &[f32; 3]| 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    let lit_scale = rt_pixels.iter().map(luminance).fold(0.0f32, f32::max);
    let shadow_band = rt_pixels
        .iter()
        .filter(|rgb| luminance(rgb) < 0.05 * lit_scale)
        .count();
    assert!(
        lit_scale > 0.2,
        "baseline must receive direct sun: {lit_scale}"
    );
    assert!(
        shadow_band > 50,
        "baseline must contain shadows: {shadow_band}"
    );
    // RGBA16F 在 1.0 附近的 ulp 是 2^-10;给 2 ulp 容差。
    let tau = 2.0 / 512.0;
    let total = rt_pixels.len();
    let mut close = 0usize;
    let mut delta_sum = 0.0f64;
    let mut max_delta = 0.0f32;
    for (a, b) in rt_pixels.iter().zip(plain_pixels.iter()) {
        let delta = (0..3).map(|c| (a[c] - b[c]).abs()).fold(0.0f32, f32::max);
        if delta <= tau {
            close += 1;
        }
        delta_sum += f64::from((luminance(a) - luminance(b)).abs());
        max_delta = max_delta.max(delta);
    }
    let close_ratio = close as f64 / total as f64;
    println!(
        "F2 no-RT-device raster parity: pixels={total} close={close} ({:.4}%) \
         mean|dlum|={:.6} max|dchan|={max_delta:.6} tau={tau:.5} lit={lit_scale:.4} \
         shadow_band={shadow_band}",
        close_ratio * 100.0,
        delta_sum / total as f64,
    );
    assert!(
        close_ratio >= 0.999,
        "fallback raster output must match the RT-device raster baseline: {close_ratio}"
    );
}

/// 全 BLEND 场景真机驻留拒绝:整族不进 TLAS,驻留槽保持空,帧循环必然
/// 回退栅格(BLEND 实例由既有 transparent 栅格 pass 渲染,与 Web
/// renderPacketRayScene 同口径)。
#[test]
fn all_blend_scene_is_rejected_from_residency_on_rt_device() {
    let Some((device, queue)) = super::request_ray_query_device() else {
        return;
    };
    let errors = Arc::new(Mutex::new(Vec::new()));
    let captured = errors.clone();
    device.on_uncaptured_error(Arc::new(move |error| {
        captured.lock().unwrap().push(error.to_string())
    }));
    let packet = blend_packet();
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
    // 真机构建路径走到计划核后被 EmptyScene 拒绝:拒绝原因即生产诊断
    // 的 tlas_no_resident_instances,不产生任何 BLAS/TLAS 资源。
    assert!(
        matches!(
            RtSceneResidency::build(&device, &scene),
            Err(RtResidencyReject::EmptyScene)
        ),
        "all-BLEND scene must be rejected from residency"
    );
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    assert!(
        errors.lock().unwrap().is_empty(),
        "uncaptured GPU errors: {:?}",
        errors.lock().unwrap()
    );
}

/// `rt_opaque_ready` 裁决函数在真实对象上的边界(与 frame.rs 的消费顺序
/// 一致):管线族缺失回退、槽未挂回退、custom shader 场景回退、全就绪
/// 走 RT。CPU 侧(None 驻留分支)由 rt_residency_tests 钉死,这里补上
/// 需要 GPU 资源才能构造的分支。
#[test]
fn rt_opaque_ready_matches_frame_loop_contract_on_real_objects() {
    let Some((device, queue)) = super::request_ray_query_device() else {
        return;
    };
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
    // build 出的驻留尚未安装 pixel 管线族(init 在 error scope 内创建成功
    // 才注入)——正对应"管线族创建失败"的真实形态。
    let (mut residency, blas_encoder, tlas_encoder) =
        RtSceneResidency::build(&device, &scene).expect("parity scene must stay resident");
    queue.submit([blas_encoder.finish(), tlas_encoder.finish()]);

    let layouts = create_frame_layouts(&device);
    let frame_rt = layouts
        .frame_rt
        .expect("ray-query device must expose the RT frame layout");
    let size = PhysicalSize::new(SIZE, SIZE);
    let view = PlayerView {
        yaw: 0.55,
        ..Default::default()
    };
    let frame = frame_data_with_camera(size, view, FogSettings::default());
    let shadows = create_shadow_map(&device, &layouts.shadow, size, &frame, None, view).unwrap();
    let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("F2 decision frame uniform"),
        contents: bytemuck::cast_slice(&frame),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let ies = NativeIesShadingResource::prepare(&[], None).unwrap();
    let ies_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("F2 decision IES identity"),
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
        residency.tlas(),
        Some(&probe_gi_placeholder),
        "F2 decision RT frame bindings",
    );

    // ① 驻留在、槽已挂,但管线族缺失(error scope 捕获过创建错误后
    //    drop_pixel_pipelines 的形态)→ 回退栅格。
    assert!(
        rt_opaque_ready(Some(&residency), Some(&rt_group), false).is_none(),
        "missing pixel pipelines must fall back to raster"
    );
    // ② 槽未挂(重建事务中段)→ 回退,即使管线族在。
    residency.install_pixel_pipelines(create_rt_mesh_pipelines(
        &device,
        &frame_rt,
        &material_layout,
        &create_native_mesh_rt_shader(&device),
    ));
    assert!(
        rt_opaque_ready::<wgpu::BindGroup>(Some(&residency), None, false).is_none(),
        "unbound frame RT slot must fall back to raster"
    );
    // ③ custom shader 批次场景 → 整帧回退(custom 只能绑普通 frame layout)。
    assert!(
        rt_opaque_ready(Some(&residency), Some(&rt_group), true).is_none(),
        "custom shader scenes must fall back to raster"
    );
    // ④ 全就绪 → RT 分支,返回的正是 encode_opaque_pass_rt 消费的二元组。
    let ready = rt_opaque_ready(Some(&residency), Some(&rt_group), false);
    assert!(
        ready.is_some(),
        "fully ready residency must take the RT branch"
    );
}
