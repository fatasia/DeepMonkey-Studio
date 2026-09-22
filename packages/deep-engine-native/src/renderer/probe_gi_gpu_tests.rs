//! F3 探针 GI 网格三线性像素消费证据(windows 真机 ray-query 设备):
//! 同一场景(纯地面接收面)渲染两帧——唯一差异是
//! `frame.lightDirection.w` 开关通道(0 = 探针 GI 关 / 2 = 网格三线性),
//! 探针 storage 同为"2×2×2 网格头 + 8 条均匀 irradiance 探针"。
//! 由于全部探针 irradiance 均匀且 meanDistance 极大(Chebyshev 恒通过),
//! 权重归一后采样结果恒等于该均匀值,地面像素的增量应为
//! `base * (1-metal) * irradiance / π` 的确定性常数,通道比例与
//! irradiance 比例一致。CPU 参考用 `sample_probe_grid_irradiance`
//! 在三个地面采样点验证同值。非 RT 设备跳过(与同族测试同界)。

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
use deep_engine_native::{
    culling_contract::prepare_gpu_culling,
    contract::{RenderPacket, validate_packet},
    fog::FogSettings,
    half_decode::half_to_f32,
    ibl::disabled_probe_environment,
    ies_shading::NativeIesShadingResource,
    probe_gi_abi::IrradianceProbeRecord,
    probe_gi_grid::{ProbeGiGridHeader, sample_probe_grid_irradiance},
    probe_gi_storage::{FRAME_PROBE_GI_ENABLE_LANE, FRAME_PROBE_GI_ENABLE_ROW},
    pbr_texture::prepare_pbr_resources,
    scene::prepare_scene,
};
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;
use winit::dpi::PhysicalSize;

const SIZE: u32 = 256;
/// frame uniform 的 background 行(shader Frame 第 9 个字段)。
/// 两帧都置 1:探针 GI 项位于 background.w > 0.5 的环境分支内部,
/// 同时两帧共用同一 disabled IBL 纹理,环境项在逐像素差中相互抵消。
const FRAME_BACKGROUND_ROW: usize = 9;

/// 均匀探针 irradiance:三通道比例 4:2:1,便于用通道增量比例验证采样通道对齐。
const PROBE_IRRADIANCE: [f32; 3] = [0.5, 0.25, 0.125];
/// 地面 baseColor(parity-receiver 同款灰,metal=0):
/// 期望环境增量 = base * irradiance / π(线性 HDR 假设下的常数)。
const GROUND_BASE_COLOR: [f32; 3] = [0.7, 0.7, 0.7];

/// 纯地面场景:单几何单实例,法线 +y,纹理为空。
fn ground_packet() -> RenderPacket {
    let mut vertices: Vec<f32> = Vec::new();
    // 地面 y=-1,四角外向 CCW(与 parity 测试同款绕序,从上方看为正面)。
    for corner in [
        [-6.0f32, -1.0, -6.0],
        [-6.0, -1.0, 6.0],
        [6.0, -1.0, 6.0],
        [6.0, -1.0, -6.0],
    ] {
        vertices.extend_from_slice(&[corner[0], corner[1], corner[2], 0.0, 1.0, 0.0]);
    }
    let ground_uv0 = vec![0.0f32; 8];
    let packet: RenderPacket = serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [
            {
                "id": "probe-gi-ground", "revision": 1,
                "vertices": vertices, "uv0": ground_uv0,
                "indices": [0, 1, 2, 0, 2, 3],
            }
        ],
        "materials": [
            { "id": "probe-gi-receiver", "baseColor": GROUND_BASE_COLOR, "metallic": 0.0, "roughness": 0.8, "alphaMode": "OPAQUE" }
        ],
        "instances": [
            { "id": "receiver", "geometry": "probe-gi-ground", "material": "probe-gi-receiver",
              "transform": [1.0,0.0,0.0,0.0, 0.0,1.0,0.0,0.0, 0.0,0.0,1.0,0.0, 0.0,0.0,0.0,1.0] }
        ],
        "textures": []
    }))
    .expect("probe GI packet JSON must deserialize");
    validate_packet(&packet).expect("probe GI packet must pass contract validation");
    packet
}

/// 网格头 + 8 条均匀探针:origin [-3,-2,-3]、spacing 2、grid 2×2×2,
/// 覆盖 x∈[-3,1]、y∈[-2,2]、z∈[-3,1],地面 y=-1 的可见区域在网格内。
/// meanDistance 极大使 Chebyshev 恒通过;positionOffset 置零(重定位增量语义)。
fn probe_grid_records() -> Vec<IrradianceProbeRecord> {
    let header = ProbeGiGridHeader {
        origin: [-3.0, -2.0, -3.0],
        spacing: 2.0,
        grid_size: [2, 2, 2],
        probe_count: 8,
    };
    let mut records = vec![header.encode().expect("probe grid header must encode")];
    for _ in 0..header.probe_count {
        let mut record = IrradianceProbeRecord::zero();
        record.irradiance = PROBE_IRRADIANCE;
        record.validity = 1.0;
        record.mean_distance = 1_000_000.0;
        record.distance_variance = 0.0;
        record.occlusion_floor = 0.0;
        records.push(record);
    }
    records
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
fn probe_grid_trilinear_adds_uniform_ambient_on_real_gpu() {
    let Some((device, queue)) = super::request_ray_query_device() else {
        return;
    };
    let errors = Arc::new(Mutex::new(Vec::new()));
    let captured = errors.clone();
    device.on_uncaptured_error(Arc::new(move |error| {
        captured.lock().unwrap().push(error.to_string())
    }));

    // CPU 参考先钉住:网格内三个地面点的采样值必须等于均匀 irradiance,
    // 网格外的点返回零;GPU 像素增量因此可以对照这一确定性值。
    let records = probe_grid_records();
    for world in [[-1.0, -1.0, -1.0], [0.0, -1.0, 0.0], [-2.5, -1.0, -0.5]] {
        assert_eq!(
            sample_probe_grid_irradiance(&records, world, [0.0, 1.0, 0.0]),
            PROBE_IRRADIANCE,
            "CPU 参考在 {world:?} 应返回均匀探针值"
        );
    }
    assert_eq!(
        sample_probe_grid_irradiance(&records, [2.0, -1.0, 0.0], [0.0, 1.0, 0.0]),
        [0.0; 3],
        "网格外的点必须 fail-closed 返零"
    );

    let packet = ground_packet();
    let prepared = prepare_scene(&packet).unwrap();
    let pbr = prepare_pbr_resources(&packet).unwrap();
    let size = PhysicalSize::new(SIZE, SIZE);
    let view = PlayerViewLike::default_view();
    let mut frames = [frame_data_with_camera(size, view, FogSettings::default()), frame_data_with_camera(size, view, FogSettings::default())];
    for frame in &mut frames {
        // 环境分支必须开启(background.w > 0.5),探针 GI 项在其内部;
        // 两帧共用同一 disabled IBL 纹理,IBL 环境项在逐像素差中相互抵消,
        // 差值只剩探针 GI 项,不会污染归因。
        frame[FRAME_BACKGROUND_ROW][3] = 1.0;
    }
    // 两帧只差探针 GI 开关:0 = 关,2 = 网格三线性。
    frames[0][FRAME_PROBE_GI_ENABLE_ROW][FRAME_PROBE_GI_ENABLE_LANE] = 0.0;
    frames[1][FRAME_PROBE_GI_ENABLE_ROW][FRAME_PROBE_GI_ENABLE_LANE] = 2.0;

    let layouts = create_frame_layouts(&device);
    let shadows = create_shadow_map(&device, &layouts.shadow, size, &frames[1], None, view).unwrap();
    let material_layout = create_material_layout(&device);
    let pipelines = create_mesh_pipelines(
        &device,
        &layouts.frame,
        &layouts.shadow,
        &material_layout,
        &create_native_mesh_shader(&device),
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
        &frames[1],
        &shadows,
        false,
    )
    .unwrap();

    let frame_buffers: Vec<wgpu::Buffer> = frames
        .iter()
        .map(|frame| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("probe GI frame uniform"),
                contents: bytemuck::cast_slice(frame),
                usage: wgpu::BufferUsages::UNIFORM,
            })
        })
        .collect();
    let ies = NativeIesShadingResource::prepare(&[], None).unwrap();
    let ies_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("probe GI IES identity"),
        contents: ies.bytes(),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let ibl = GpuIblEnvironment::new(&device, &queue, &disabled_probe_environment()).unwrap();
    // 真实探针 storage:网格头 + 8 条均匀探针,两帧共用同一份。
    let probe_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("probe GI grid storage"),
        contents: bytemuck::cast_slice(&records),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let frame_groups: Vec<wgpu::BindGroup> = [0usize, 1]
        .map(|index| {
            ibl.create_frame_bind_group(
                &device,
                &layouts.frame,
                &frame_buffers[index],
                Some(&ies_buffer),
                &shadows,
                Some(&probe_buffer),
                "probe GI frame",
                true,
            )
        })
        .to_vec();

    let targets: Vec<ForwardTargets> = (0..2).map(|_| ForwardTargets::new(&device, size, false)).collect();
    let row_bytes = u64::from(SIZE) * 8;
    let readbacks: Vec<wgpu::Buffer> = (0..2)
        .map(|index| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(&format!("probe GI readback {index}")),
                size: row_bytes * u64::from(SIZE),
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            })
        })
        .collect();

    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let mut encoder = device.create_command_encoder(&Default::default());
    culling.encode(&queue, &mut encoder);
    for index in 0..2 {
        encode_opaque_pass(
            &mut encoder,
            &targets[index],
            &frame_groups[index],
            &scene,
            &culling,
            None,
            &pipelines,
            false,
        );
        encoder.copy_texture_to_buffer(
            targets[index].resolved_texture().as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readbacks[index],
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row_bytes as u32),
                    rows_per_image: Some(SIZE),
                },
            },
            targets[index].resolved_texture().size(),
        );
    }
    queue.submit([encoder.finish()]);
    culling.commit_submission();
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    for error in [
        pollster::block_on(internal.pop()),
        pollster::block_on(memory.pop()),
        pollster::block_on(validation.pop()),
    ] {
        assert!(
            error.is_none(),
            "probe GI 帧提交不得产生 GPU 错误: {error:?}"
        );
    }

    let off = decode_hdr(&map_readback(&device, &readbacks[0]));
    let on = decode_hdr(&map_readback(&device, &readbacks[1]));

    // 逐像素差:几何覆盖像素应均匀增加;无几何覆盖处(天空)两帧逐位一致。
    let mut deltas: Vec<[f32; 3]> = Vec::new();
    let mut changed = 0usize;
    let mut positive = 0usize;
    let mut unchanged = 0usize;
    for (off_pixel, on_pixel) in off.iter().zip(on.iter()) {
        let delta = [on_pixel[0] - off_pixel[0], on_pixel[1] - off_pixel[1], on_pixel[2] - off_pixel[2]];
        let magnitude = delta[0].abs() + delta[1].abs() + delta[2].abs();
        if magnitude > 1.0 / 512.0 {
            changed += 1;
            if delta[0] > 0.0 && delta[1] > 0.0 && delta[2] > 0.0 {
                positive += 1;
            }
            deltas.push(delta);
        } else {
            unchanged += 1;
        }
    }
    assert!(
        changed > (SIZE * SIZE / 8) as usize,
        "探针 GI 打开后几何覆盖像素必须变亮,changed={changed}"
    );
    assert_eq!(
        positive,
        changed,
        "所有差异像素的三个通道都必须为正增量,positive={positive}/{changed}"
    );
    // 天空/背景无几何:探针 GI 不应泄漏进空像素,这部分必须保持零差。
    assert!(
        unchanged > (SIZE * SIZE / 4) as usize,
        "非几何像素必须保持零差(探针项不得泄漏进天空),unchanged={unchanged}"
    );
    assert!(
        errors.lock().unwrap().is_empty(),
        "设备错误必须为空: {:?}",
        errors.lock().unwrap()
    );

    // 通道比例对账:Δg/Δr ≈ 0.25/0.5、Δb/Δr ≈ 0.125/0.5(均匀 irradiance
    // 经权重归一后逐通道独立缩放,不受色调映射常数影响的比例指纹)。
    let sum_red: f32 = deltas.iter().map(|delta| delta[0]).sum();
    let sum_green: f32 = deltas.iter().map(|delta| delta[1]).sum();
    let sum_blue: f32 = deltas.iter().map(|delta| delta[2]).sum();
    let green_ratio = sum_green / sum_red;
    let blue_ratio = sum_blue / sum_red;
    assert!(
        (green_ratio - PROBE_IRRADIANCE[1] / PROBE_IRRADIANCE[0]).abs() < 0.05,
        "绿/红增量比例 {green_ratio} 应接近 irradiance 比例 {}",
        PROBE_IRRADIANCE[1] / PROBE_IRRADIANCE[0]
    );
    assert!(
        (blue_ratio - PROBE_IRRADIANCE[2] / PROBE_IRRADIANCE[0]).abs() < 0.05,
        "蓝/红增量比例 {blue_ratio} 应接近 irradiance 比例 {}",
        PROBE_IRRADIANCE[2] / PROBE_IRRADIANCE[0]
    );
    // 幅度对账:线性 HDR 假设下地面增量 ≈ base * irradiance / π ≈ 0.1114;
    // 即使存在输出变换,单帧常数性(采样点标准差/均值 < 10%)也钉死
    // "均匀探针 → 空间均匀增量"这一采样合同。
    let mean_red = sum_red / deltas.len() as f32;
    let variance: f32 = deltas
        .iter()
        .map(|delta| (delta[0] - mean_red) * (delta[0] - mean_red))
        .sum();
    let spread = variance.sqrt() / mean_red;
    assert!(
        spread < 0.10,
        "均匀探针的增量应空间均匀(相对标准差 {spread} < 0.10),mean_red={mean_red}"
    );
}

/// 该测试只借用 PlayerView 的默认取景,避免直接依赖其字段构造;
/// 用类型别名保持与 parity 测试同款视图。
type PlayerViewLike = deep_engine_native::player_view::PlayerView;

trait DefaultView {
    fn default_view() -> Self;
}
impl DefaultView for deep_engine_native::player_view::PlayerView {
    fn default_view() -> Self {
        Self { yaw: 0.55, ..Default::default() }
    }
}
