//! F2 RT/栅格同场景阴影像素对拍(真机 ray-query 设备):
//! 同一 RenderPacket(接收地面 + 悬浮遮挡箱)各渲染一帧——
//! 栅格:级联阴影 pass 写深度图 + `fragment_main` 采样 CSM 可见性;
//! RT:场景 BLAS/TLAS 驻留 + `fragment_main_rt` 的 Ray Query 遮挡检测。
//! 两帧共用 frame uniform、场景几何、culling indirect 与光源,唯一差异是
//! 方向光可见性来源,因此逐像素亮度差可直接归因于阴影判定。
//!
//! 方向合同(硬断言):RT 判暗而栅格判亮的像素必须为 0
//! (RT shadowed ⇒ 栅格也 shadowed);反向差异(栅格独有阴影,来自
//! CSM 偏置/PCF 软边缘)只量化上报,不拦截。TLAS 经 pub 的
//! hardware_ray_query 构建器直建,输入与 renderer::rt_residency 相同
//! (GpuGeometry 驻留缓冲 + packed 行变换);驻留计划核本身已由
//! rt_residency_tests 覆盖,此处不重复。
#![allow(dead_code)]

#[path = "../src/forward_targets.rs"]
mod forward_targets;
#[path = "../src/frame_bindings.rs"]
mod frame_bindings;
#[path = "../src/gpu_culling.rs"]
mod gpu_culling;
#[path = "../src/gpu_culling_readback.rs"]
mod gpu_culling_readback;
#[path = "../src/gpu_culling_resources.rs"]
mod gpu_culling_resources;
#[path = "../src/gpu_ibl.rs"]
mod gpu_ibl;
#[path = "../src/gpu_lod.rs"]
mod gpu_lod;
#[path = "../src/gpu_lod_resources.rs"]
mod gpu_lod_resources;
#[path = "../src/gpu_lod_views.rs"]
mod gpu_lod_views;
#[path = "../src/gpu_occlusion.rs"]
mod gpu_occlusion;
#[path = "../src/gpu_occlusion_consume.rs"]
mod gpu_occlusion_consume;
#[path = "../src/gpu_resources.rs"]
mod gpu_resources;
#[path = "../src/gpu_scene.rs"]
mod gpu_scene;
#[path = "../src/gpu_scene_draw.rs"]
mod gpu_scene_draw;
#[path = "../src/gpu_shader_materials.rs"]
mod gpu_shader_materials;
#[path = "../src/gpu_texture_types.rs"]
mod gpu_texture_types;
#[path = "../src/gpu_texture_upload.rs"]
mod gpu_texture_upload;
#[path = "../src/gpu_textures.rs"]
mod gpu_textures;
#[path = "../src/half_float.rs"]
mod half_float;
#[path = "../src/mesh_pass.rs"]
mod mesh_pass;
#[path = "../src/pipeline.rs"]
mod pipeline;
#[path = "../src/player_shader_plan.rs"]
mod player_shader_plan;
#[path = "../src/render_graph.rs"]
mod render_graph;
#[path = "../src/runtime_lkg.rs"]
mod runtime_lkg;
#[path = "../src/shadow_map.rs"]
mod shadow_map;
#[path = "../src/shadow_pass.rs"]
mod shadow_pass;
#[path = "../src/telemetry.rs"]
mod telemetry;
#[path = "../src/telemetry_gpu.rs"]
mod telemetry_gpu;

use deep_engine_native::{
    culling_contract::prepare_gpu_culling,
    contract::{AlphaMode, RenderPacket, validate_packet},
    fog::FogSettings,
    half_decode::half_to_f32,
    hardware_ray_query::{ResidentBlasGeometry, build_resident_blas_set, build_tlas_from_blas},
    ibl::disabled_probe_environment,
    ies_shading::NativeIesShadingResource,
    pbr_texture::prepare_pbr_resources,
    player_view::PlayerView,
    scene::prepare_scene,
};
use forward_targets::ForwardTargets;
use frame_bindings::{
    create_frame_layouts, create_native_mesh_rt_shader, create_native_mesh_shader,
};
use gpu_culling::GpuCulling;
use gpu_ibl::GpuIblEnvironment;
use gpu_resources::{create_shadow_map, frame_data_with_camera};
use gpu_scene::GpuScene;
use gpu_textures::create_material_layout;
use mesh_pass::{encode_opaque_pass, encode_opaque_pass_rt};
use pipeline::{create_mesh_pipelines, create_rt_mesh_pipelines};
use player_shader_plan::scene_content_key;
use shadow_pass::{CascadeScene, encode_shadow_cascades};
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;
use winit::dpi::PhysicalSize;

const SIZE: u32 = 256;
/// frame uniform 的 background 行(shader Frame 第 9 个字段)。legacy 默认
/// w=1 会叠加 IBL 环境项;对拍置 0 后阴影区为纯黑,方向判定不受环境光干扰。
const FRAME_BACKGROUND_ROW: usize = 9;
/// 与 renderer::rt_residency 的 RT_SCENE_RAY_MASK 同值(pub(crate),此处对齐)。
const RT_SCENE_RAY_MASK: u8 = 1;

fn request_ray_query_device() -> Option<(wgpu::Device, wgpu::Queue)> {
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
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
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
    Some((device, queue))
}

/// 对拍场景:地面(y=-1,+y 法线)+ 悬浮箱(x∈±0.5, y∈[-0.6,0.4], z∈[-0.4,0.6])。
/// 默认方向光 ≈ normalize([0.55,0.8,0.35]),箱体投影落在相机(yaw=0.55,
/// distance=4)视野内的地面上。全部 OPAQUE、单面、无纹理:两条路径的
/// BRDF 输入逐位一致,差异只剩阴影可见性来源。
fn parity_packet() -> RenderPacket {
    let mut vertices: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    // 每面 4 顶点(法线为面法线),索引模板 [0,1,2, 0,2,3];四角按外向
    // CCW 周界排列(逐面叉积验证过朝外)。
    let mut push_face = |normal: [f32; 3], corners: [[f32; 3]; 4]| {
        let base = (vertices.len() / 6) as u32;
        for corner in corners {
            vertices.extend_from_slice(&[
                corner[0], corner[1], corner[2], normal[0], normal[1], normal[2],
            ]);
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    };
    push_face([0.0, 1.0, 0.0], [[-6.0, -1.0, -6.0], [6.0, -1.0, -6.0], [6.0, -1.0, 6.0], [-6.0, -1.0, 6.0]]);
    push_face([0.0, -1.0, 0.0], [[-0.5, -0.6, -0.4], [0.5, -0.6, -0.4], [0.5, -0.6, 0.6], [-0.5, -0.6, 0.6]]);
    push_face([0.0, 1.0, 0.0], [[-0.5, 0.4, -0.4], [-0.5, 0.4, 0.6], [0.5, 0.4, 0.6], [0.5, 0.4, -0.4]]);
    push_face([1.0, 0.0, 0.0], [[0.5, -0.6, -0.4], [0.5, 0.4, -0.4], [0.5, 0.4, 0.6], [0.5, -0.6, 0.6]]);
    push_face([-1.0, 0.0, 0.0], [[-0.5, -0.6, 0.6], [-0.5, 0.4, 0.6], [-0.5, 0.4, -0.4], [-0.5, -0.6, -0.4]]);
    push_face([0.0, 0.0, 1.0], [[-0.5, -0.6, 0.6], [0.5, -0.6, 0.6], [0.5, 0.4, 0.6], [-0.5, 0.4, 0.6]]);
    push_face([0.0, 0.0, -1.0], [[0.5, -0.6, -0.4], [-0.5, -0.6, -0.4], [-0.5, 0.4, -0.4], [0.5, 0.4, -0.4]]);
    let (ground_vertices, box_vertices) = vertices.split_at(24);
    let (ground_indices, box_indices) = indices.split_at(6);
    let ground_uv0 = vec![0.0f32; 8];
    let box_uv0 = vec![0.0f32; 48];
    let packet: RenderPacket = serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [
            {
                "id": "parity-ground", "revision": 1,
                "vertices": ground_vertices, "uv0": ground_uv0,
                "indices": ground_indices,
            },
            {
                "id": "parity-box", "revision": 1,
                "vertices": box_vertices, "uv0": box_uv0,
                "indices": box_indices,
            }
        ],
        "materials": [
            { "id": "parity-receiver", "baseColor": [0.7, 0.7, 0.7], "metallic": 0.0, "roughness": 0.8, "alphaMode": "OPAQUE" },
            { "id": "parity-caster", "baseColor": [0.8, 0.3, 0.1], "metallic": 0.0, "roughness": 0.6, "alphaMode": "OPAQUE" }
        ],
        "instances": [
            { "id": "receiver", "geometry": "parity-ground", "material": "parity-receiver",
              "transform": [1.0,0.0,0.0,0.0, 0.0,1.0,0.0,0.0, 0.0,0.0,1.0,0.0, 0.0,0.0,0.0,1.0] },
            { "id": "caster", "geometry": "parity-box", "material": "parity-caster",
              "transform": [1.0,0.0,0.0,0.0, 0.0,1.0,0.0,0.0, 0.0,0.0,1.0,0.0, 0.0,0.0,0.0,1.0] }
        ],
        "textures": []
    }))
    .expect("parity packet JSON must deserialize");
    validate_packet(&packet).expect("parity packet must pass contract validation");
    packet
}

/// 提交完成后把 RGBA16F 读回缓冲 map 出原始字节(256*8 行距恰 256 对齐)。
fn map_readback(device: &wgpu::Device, buffer: &wgpu::Buffer) -> Vec<u8> {
    let (sender, receiver) = std::sync::mpsc::channel();
    buffer.map_async(wgpu::MapMode::Read, .., move |result| sender.send(result).unwrap());
    device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(std::time::Duration::from_secs(10)),
        })
        .unwrap();
    receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap()
        .unwrap();
    let bytes = buffer.get_mapped_range(..).unwrap().to_vec();
    buffer.unmap();
    bytes
}

fn decode_hdr(bytes: &[u8]) -> Vec<[f32; 3]> {
    bytes
        .chunks_exact(8)
        .map(|pixel| {
            let channel = |lane: usize| {
                half_to_f32(u16::from_le_bytes([pixel[lane * 2], pixel[lane * 2 + 1]]))
            };
            [channel(0), channel(1), channel(2)]
        })
        .collect()
}

#[test]
#[ignore = "requires hardware GPU with ray query; run explicitly with --ignored"]
fn rt_and_raster_shadows_agree_directionally_same_scene() {
    let Some((device, queue)) = request_ray_query_device() else {
        println!("no ray-query adapter; parity test skipped");
        return;
    };
    println!("RT/raster parity adapter: {:?}", device.adapter_info());
    let errors = Arc::new(Mutex::new(Vec::new()));
    let captured = errors.clone();
    device.on_uncaptured_error(Arc::new(move |error| {
        captured.lock().unwrap().push(error.to_string())
    }));
    let packet = parity_packet();
    let prepared = prepare_scene(&packet).unwrap();
    let pbr = prepare_pbr_resources(&packet).unwrap();
    let size = PhysicalSize::new(SIZE, SIZE);
    let view = PlayerView { yaw: 0.55, ..Default::default() };
    let mut frame = frame_data_with_camera(size, view, FogSettings::default());
    frame[FRAME_BACKGROUND_ROW][3] = 0.0;
    let layouts = create_frame_layouts(&device);
    let frame_rt = layouts
        .frame_rt
        .clone()
        .expect("ray-query device must expose the RT frame layout");
    // 与产品帧循环同源的阴影图:相机/光线方向均取自同一份 frame 数据。
    let shadows = create_shadow_map(&device, &layouts.shadow, size, &frame, None, view).unwrap();
    let material_layout = create_material_layout(&device);
    let pipelines = create_mesh_pipelines(
        &device,
        &layouts.frame,
        &layouts.shadow,
        &material_layout,
        &create_native_mesh_shader(&device),
    );
    let rt_pipelines = create_rt_mesh_pipelines(
        &device,
        &frame_rt,
        &material_layout,
        &create_native_mesh_rt_shader(&device),
    );
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
    let mut culling = GpuCulling::new(
        &device,
        &scene.instance_buffer,
        &prepare_gpu_culling(&packet, &prepared).unwrap(),
        &frame,
        &shadows,
        false,
    )
    .unwrap();
    let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("RT/raster parity frame uniform"),
        contents: bytemuck::cast_slice(&frame),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let ies = NativeIesShadingResource::prepare(&[], None).unwrap();
    let ies_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("RT/raster parity IES identity"),
        contents: ies.bytes(),
        usage: wgpu::BufferUsages::STORAGE,
    });
    // 环境只用 disabled probe 占位(background.w=0 时 shader 不采样),
    // 绑定槽仍需合法纹理。
    let ibl = GpuIblEnvironment::new(&device, &queue, &disabled_probe_environment()).unwrap();
    let frame_group = ibl.create_frame_bind_group(
        &device,
        &layouts.frame,
        &frame_buffer,
        Some(&ies_buffer),
        &shadows,
        None,
        "RT/raster parity frame",
        true,
    );

    // TLAS 驻留:与 renderer::rt_residency 同源输入(驻留 GpuGeometry 缓冲
    // + packed 行变换、custom_index = packed 行号、掩码 1),按几何去重
    // 建 BLAS 后 TLAS;BLAS/TLAS 编码器按序提交(单次 submit FIFO)。
    let packed = scene.packed_instances();
    let mut blas_geometries: Vec<ResidentBlasGeometry> = Vec::new();
    let mut blas_slots: Vec<Option<u32>> = vec![None; scene.geometries.len()];
    let mut tlas_instances: Vec<(u32, [f32; 12], u32)> = Vec::new();
    for batch in &scene.batches {
        assert_eq!(
            batch.alpha_mode,
            AlphaMode::Opaque,
            "parity scene must stay opaque-only"
        );
        let slot = match blas_slots[batch.geometry_index] {
            Some(slot) => slot,
            None => {
                let geometry = &scene.geometries[batch.geometry_index];
                blas_geometries.push(ResidentBlasGeometry {
                    vertex_buffer: &geometry.vertex_buffer,
                    index_buffer: &geometry.index_buffer,
                    vertex_count: geometry.vertex_count,
                    index_count: geometry.index_count,
                });
                let slot = (blas_geometries.len() - 1) as u32;
                blas_slots[batch.geometry_index] = Some(slot);
                slot
            }
        };
        let start = batch.instance_start as usize;
        for (offset, row) in packed[start..start + batch.instance_count as usize]
            .iter()
            .enumerate()
        {
            tlas_instances.push((
                slot,
                row[..12].try_into().expect("packed row carries a 3x4 model"),
                (start + offset) as u32,
            ));
        }
    }
    let (blas_set, blas_encoder) = build_resident_blas_set(&device, &blas_geometries)
        .expect("parity geometries must build BLAS");
    let tlas_input: Vec<_> = tlas_instances
        .iter()
        .map(|(slot, transform, custom_index)| {
            (&blas_set[*slot as usize], *transform, *custom_index, RT_SCENE_RAY_MASK)
        })
        .collect();
    let (tlas, tlas_encoder) =
        build_tlas_from_blas(&device, &tlas_input).expect("parity scene must build TLAS");
    queue.submit([blas_encoder.finish(), tlas_encoder.finish()]);
    let rt_group = ibl.create_rt_frame_bind_group(
        &device,
        &frame_rt,
        &frame_buffer,
        Some(&ies_buffer),
        &shadows,
        &tlas,
        None,
        "RT/raster parity RT frame",
    );

    let targets_raster = ForwardTargets::new(&device, size, false);
    let targets_rt = ForwardTargets::new(&device, size, false);
    let row_bytes = u64::from(SIZE) * 8;
    let make_readback = |label| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: row_bytes * u64::from(SIZE),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        })
    };
    let raster_readback = make_readback("RT/raster parity raster readback");
    let rt_readback = make_readback("RT/raster parity RT readback");

    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let mut encoder = device.create_command_encoder(&Default::default());
    // 单 submit FIFO:culling compute → 级联阴影 → 栅格 opaque → RT opaque
    // → 两次读回拷贝。两条 opaque 路径消费同一份 indirect draw 缓冲。
    culling.encode(&queue, &mut encoder);
    encode_shadow_cascades(
        &mut encoder,
        &CascadeScene {
            shadow_map: &shadows,
            scene: &scene,
            culling: &culling,
            lod: None,
            pipelines: &pipelines,
        },
        u16::MAX,
    );
    encode_opaque_pass(
        &mut encoder,
        &targets_raster,
        &frame_group,
        &scene,
        &culling,
        None,
        &pipelines,
        false,
    );
    encode_opaque_pass_rt(
        &mut encoder,
        &targets_rt,
        &rt_group,
        &scene,
        &culling,
        None,
        &rt_pipelines,
        false,
    );
    for (target, readback) in [(&targets_raster, &raster_readback), (&targets_rt, &rt_readback)] {
        encoder.copy_texture_to_buffer(
            target.resolved_texture().as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row_bytes as u32),
                    rows_per_image: Some(SIZE),
                },
            },
            target.resolved_texture().size(),
        );
    }
    queue.submit([encoder.finish()]);
    culling.commit_submission();
    let raster = decode_hdr(&map_readback(&device, &raster_readback));
    let rt = decode_hdr(&map_readback(&device, &rt_readback));
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    for error in [
        pollster::block_on(internal.pop()),
        pollster::block_on(memory.pop()),
        pollster::block_on(validation.pop()),
    ] {
        assert!(error.is_none(), "parity frame GPU error: {error:?}");
    }
    assert!(
        errors.lock().unwrap().is_empty(),
        "uncaptured GPU errors: {:?}",
        errors.lock().unwrap()
    );

    // 逐像素亮度对拍:两条路径除阴影可见性外完全同源,亮度差即阴影判定差。
    let luminance = |rgb: &[f32; 3]| 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    let lit_scale = rt
        .iter()
        .chain(raster.iter())
        .map(luminance)
        .fold(0.0f32, f32::max);
    // 阈值 12% 满量程:真违例(整项直射光差)远高于它,半影/量化噪声
    // (f16 精度 ≈ 5e-4)远低于它。
    let tau = 0.12 * lit_scale;
    let dark_threshold = 0.25 * lit_scale;
    let total = rt.len();
    let (mut agree, mut rt_only_shadowed, mut raster_only_shadowed) = (0usize, 0usize, 0usize);
    let (mut rt_dark, mut raster_dark) = (0usize, 0usize);
    let mut max_abs_delta = 0.0f32;
    let mut delta_sum = 0.0f64;
    for (rt_rgb, raster_rgb) in rt.iter().zip(raster.iter()) {
        let (rt_lum, raster_lum) = (luminance(rt_rgb), luminance(raster_rgb));
        let delta = raster_lum - rt_lum;
        max_abs_delta = max_abs_delta.max(delta.abs());
        delta_sum += f64::from(delta.abs());
        if rt_lum < dark_threshold {
            rt_dark += 1;
        }
        if raster_lum < dark_threshold {
            raster_dark += 1;
        }
        if delta > tau {
            // RT 判影、栅格判亮:方向合同违例。
            rt_only_shadowed += 1;
        } else if delta < -tau {
            // 栅格判影、RT 判亮:CSM 偏置/PCF 软边缘的合法方向。
            raster_only_shadowed += 1;
        } else {
            agree += 1;
        }
    }
    // 场景有效性:直射光确实照亮画面,阴影在两侧都真实存在(否则对拍空转)。
    assert!(lit_scale > 0.2, "scene must receive direct sun: lit={lit_scale}");
    assert!(
        rt_dark > 200 && raster_dark > 200,
        "shadow must exist in both frames: rt_dark={rt_dark} raster_dark={raster_dark}"
    );
    // 方向合同硬断言:RT shadowed ⇒ 栅格也 shadowed。
    assert_eq!(
        rt_only_shadowed, 0,
        "RT-shadowed-but-raster-lit pixels violate the direction contract"
    );
    // 反向差异只量化:占比必须保持极小(CSM 偏置/软边缘属预期)。
    let raster_only_ratio = raster_only_shadowed as f64 / total as f64;
    assert!(
        raster_only_ratio <= 0.02,
        "raster-only shadow fraction too high: {raster_only_ratio}"
    );
    println!(
        "F2 RT/raster shadow parity: pixels={total} agree={agree} ({:.3}%) \
         rt_only_shadowed={rt_only_shadowed} raster_only_shadowed={raster_only_shadowed} \
         ({:.4}%) mean|delta|={:.6} max|delta|={:.6} lit={lit_scale:.4} \
         rt_dark={rt_dark} raster_dark={raster_dark} tau={tau:.4}",
        agree as f64 / total as f64 * 100.0,
        raster_only_ratio * 100.0,
        delta_sum / total as f64,
        max_abs_delta,
    );
}
