//! F2 RT/栅格同场景阴影像素对拍(windows 真机 ray-query 设备):
//! 同一 RenderPacket(接收地面 + 悬浮遮挡箱)各渲染一帧——
//! 栅格:级联阴影 pass 写深度图 + `fragment_main` 采样 CSM 可见性;
//! RT:`RtSceneResidency::build` 的 BLAS/TLAS 驻留 + `fragment_main_rt`
//! 的 Ray Query 遮挡检测(与 renderer::reestablish_rt_residency 同路径)。
//! 两帧共用 frame uniform、场景几何、culling indirect 与光源,唯一差异
//! 是方向光可见性来源,因此逐像素亮度差可直接归因于阴影判定。
//!
//! 方向合同(硬断言):RT 判暗而栅格判亮的像素必须为 0
//! (RT shadowed ⇒ 栅格也 shadowed);反向差异(栅格独有阴影,来自
//! CSM 偏置/PCF 软边缘)只量化上报,不拦截。非 RT 设备跳过(与
//! rt_pixel_gpu_tests 同界)。

use crate::{
    forward_targets::ForwardTargets,
    frame_bindings::{
        create_frame_layouts, create_native_mesh_rt_shader, create_native_mesh_shader,
    },
    gpu_culling::GpuCulling,
    gpu_ibl::GpuIblEnvironment,
    gpu_resources::{create_shadow_map, frame_data_with_camera},
    gpu_scene::GpuScene,
    gpu_textures::create_material_layout,
    mesh_pass::{encode_opaque_pass, encode_opaque_pass_rt},
    pipeline::{create_mesh_pipelines, create_rt_mesh_pipelines},
    player_shader_plan::scene_content_key,
    renderer::rt_residency::RtSceneResidency,
    shadow_pass::{CascadeScene, encode_shadow_cascades},
};
use deep_engine_native::{
    culling_contract::prepare_gpu_culling,
    contract::{RenderPacket, validate_packet},
    fog::FogSettings,
    half_decode::half_to_f32,
    ibl::disabled_probe_environment,
    ies_shading::NativeIesShadingResource,
    pbr_texture::prepare_pbr_resources,
    player_view::PlayerView,
    scene::prepare_scene,
};
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;
use winit::dpi::PhysicalSize;

const SIZE: u32 = 256;
/// frame uniform 的 background 行(shader Frame 第 9 个字段)。legacy 默认
/// w=1 会叠加 IBL 环境项;对拍置 0 后阴影区为纯黑,方向判定不受环境光干扰。
const FRAME_BACKGROUND_ROW: usize = 9;

/// 对拍场景:地面(y=-1,+y 法线)+ 悬浮箱(x∈±0.5, y∈[-0.6,0.4], z∈[-0.4,0.6])。
/// 默认方向光 ≈ normalize([0.55,0.8,0.35]),箱体投影落在相机(yaw=0.55,
/// distance=4)视野内的地面上。全部 OPAQUE、单面、无纹理:两条路径的
/// BRDF 输入逐位一致,差异只剩阴影可见性来源。
/// F2 后续切片(rt_recovery_gpu_tests / rt_fallback_gpu_tests)复用同一
/// 场景,保证设备恢复/回退证据与像素对拍基准可互相引用。
pub(crate) fn parity_packet() -> RenderPacket {
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
    // 地面绕序与箱顶面同款(外向 CCW):叉积验证 (D-A)×(C-A) = +y,
    // 从上方(相机侧)看为正面;初始版本沿用底面序导致整面被背面剔除。
    push_face([0.0, 1.0, 0.0], [[-6.0, -1.0, -6.0], [-6.0, -1.0, 6.0], [6.0, -1.0, 6.0], [6.0, -1.0, -6.0]]);
    push_face([0.0, -1.0, 0.0], [[-0.5, -0.6, -0.4], [0.5, -0.6, -0.4], [0.5, -0.6, 0.6], [-0.5, -0.6, 0.6]]);
    push_face([0.0, 1.0, 0.0], [[-0.5, 0.4, -0.4], [-0.5, 0.4, 0.6], [0.5, 0.4, 0.6], [0.5, 0.4, -0.4]]);
    push_face([1.0, 0.0, 0.0], [[0.5, -0.6, -0.4], [0.5, 0.4, -0.4], [0.5, 0.4, 0.6], [0.5, -0.6, 0.6]]);
    push_face([-1.0, 0.0, 0.0], [[-0.5, -0.6, 0.6], [-0.5, 0.4, 0.6], [-0.5, 0.4, -0.4], [-0.5, -0.6, -0.4]]);
    push_face([0.0, 0.0, 1.0], [[-0.5, -0.6, 0.6], [0.5, -0.6, 0.6], [0.5, 0.4, 0.6], [-0.5, 0.4, 0.6]]);
    push_face([0.0, 0.0, -1.0], [[0.5, -0.6, -0.4], [-0.5, -0.6, -0.4], [-0.5, 0.4, -0.4], [0.5, 0.4, -0.4]]);
    let (ground_vertices, box_vertices) = vertices.split_at(24);
    let (ground_indices, box_indices) = indices.split_at(6);
    // box 索引在 push_face 里沿全局顶点编号递增;切分成独立几何后必须
    // 减去地面顶点数(4)变回本地索引,否则逐几何校验越界。
    let box_indices: Vec<u32> = box_indices.iter().map(|index| index - 4).collect();
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
/// rt_fallback_gpu_tests 的跨设备栅格对拍复用同一读回助手。
pub(crate) fn map_readback(device: &wgpu::Device, buffer: &wgpu::Buffer) -> Vec<u8> {
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

/// RGBA16F 半浮点解码;rt_fallback_gpu_tests 复用。
pub(crate) fn decode_hdr(bytes: &[u8]) -> Vec<[f32; 3]> {
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
fn rt_and_raster_shadows_agree_directionally_same_scene() {
    let Some((device, queue)) = super::request_ray_query_device() else {
        return;
    };
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
    // 绑定槽仍需合法纹理;GI 探针槽用生产同款全零占位(validity=0,
    // 采样分支返回零,与无探针路径一致)。
    let ibl = GpuIblEnvironment::new(&device, &queue, &disabled_probe_environment()).unwrap();
    let probe_gi_placeholder = deep_engine_native::probe_gi_storage::disabled_frame_buffer(&device);
    let frame_group = ibl.create_frame_bind_group(
        &device,
        &layouts.frame,
        &frame_buffer,
        Some(&ies_buffer),
        &shadows,
        Some(&probe_gi_placeholder),
        "RT/raster parity frame",
        true,
    );

    // TLAS 驻留:与 renderer::reestablish_rt_residency 完全同路径
    // (BLAS 先于 TLAS,单次 submit FIFO 保证执行序)。
    let (residency, blas_encoder, tlas_encoder) =
        RtSceneResidency::build(&device, &scene).expect("parity scene must stay resident");
    let plan = residency.plan();
    assert_eq!(plan.instances.len(), 2, "both opaque instances must enter TLAS");
    assert_eq!(plan.triangles, 14, "ground 2 + box 12 triangles");
    assert_eq!(plan.excluded_blend_instances, 0);
    queue.submit([blas_encoder.finish(), tlas_encoder.finish()]);
    let rt_group = ibl.create_rt_frame_bind_group(
        &device,
        &frame_rt,
        &frame_buffer,
        Some(&ies_buffer),
        &shadows,
        residency.tlas(),
        Some(&probe_gi_placeholder),
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
    // 画面构成统计:lit band ≈ 被直射光照亮的地面,shadow band ≈ 近黑
    // (阴影地面或天空)。两者必须同时大量存在,否则对拍退化为全亮/全黑
    // 空转;图像落盘(test-output)供目视核验阴影形状。
    let (mut lit_band, mut shadow_band) = (0usize, 0usize);
    for rgb in &rt {
        let lum = luminance(rgb);
        if (0.6 * lit_scale..=1.4 * lit_scale).contains(&lum) {
            lit_band += 1;
        }
        if lum < 0.05 * lit_scale {
            shadow_band += 1;
        }
    }
    // 阈值 12% 满量程:真违例(整项直射光差)远高于它,半影/量化噪声
    // (f16 精度 ≈ 5e-4)远低于它。
    let tau = 0.12 * lit_scale;
    let dark_threshold = 0.25 * lit_scale;
    let total = rt.len();
    let (mut agree, mut raster_only_shadowed) = (0usize, 0usize);
    let (mut rt_dark, mut raster_dark) = (0usize, 0usize);
    let mut rt_only_shadowed_pixels: Vec<usize> = Vec::new();
    let mut max_abs_delta = 0.0f32;
    let mut delta_sum = 0.0f64;
    for (index, (rt_rgb, raster_rgb)) in rt.iter().zip(raster.iter()).enumerate() {
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
            // RT 判影、栅格判亮:方向合同违例候选(再按边缘/内部分级)。
            rt_only_shadowed_pixels.push(index);
        } else if delta < -tau {
            // 栅格判影、RT 判亮:CSM 偏置/PCF 软边缘的合法方向。
            raster_only_shadowed += 1;
        } else {
            agree += 1;
        }
    }
    // 违例分级:CSM 的深度偏置按设计会把阴影边界回缩约一个阴影纹素,
    // 因此边界带(3x3 栅格邻域内存在判暗像素)的 RT 判影属预期差异;
    // 而被栅格判亮区完整包围的"内部违例"才是方向合同的真实破坏。
    let at = |index: usize| -> (u32, u32) { (index as u32 % SIZE, index as u32 / SIZE) };
    let mut interior_violations = 0usize;
    let mut boundary_violations = 0usize;
    for &index in &rt_only_shadowed_pixels {
        let (x, y) = at(index);
        let mut raster_dark_nearby = false;
        for dy in -1i32..=1 {
            for dx in -1i32..=1 {
                let nx = x as i32 + dx;
                let ny = y as i32 + dy;
                if nx < 0 || ny < 0 || nx >= SIZE as i32 || ny >= SIZE as i32 {
                    continue;
                }
                let neighbor = (ny as u32 * SIZE + nx as u32) as usize;
                if luminance(&raster[neighbor]) < dark_threshold {
                    raster_dark_nearby = true;
                }
            }
        }
        if raster_dark_nearby {
            boundary_violations += 1;
        } else {
            interior_violations += 1;
        }
    }
    let rt_only_shadowed = rt_only_shadowed_pixels.len();
    // 场景有效性:直射光确实照亮画面,近黑区域大量存在(阴影/天空),
    // 被照亮地面构成第三带;三带齐全才说明对拍画面真实。
    assert!(lit_scale > 0.2, "scene must receive direct sun: lit={lit_scale}");
    assert!(
        rt_dark > 200 && raster_dark > 200,
        "shadow must exist in both frames: rt_dark={rt_dark} raster_dark={raster_dark}"
    );
    assert!(
        lit_band > 200 && shadow_band > 200,
        "frame must contain lit ground and near-black regions: lit_band={lit_band} shadow_band={shadow_band}"
    );
    write_parity_artifacts(&raster, &rt, lit_scale);
    // 方向合同硬断言:RT shadowed ⇒ 栅格也 shadowed。内部违例必须为 0;
    // 边界违例是 CSM 深度偏置的预期亚纹素回缩带,按占比小额预算拦截。
    assert_eq!(
        interior_violations, 0,
        "interior RT-shadowed-but-raster-lit pixels violate the direction contract"
    );
    let violation_ratio = rt_only_shadowed as f64 / total as f64;
    assert!(
        violation_ratio <= 0.002,
        "boundary violation fraction too high: {violation_ratio} ({rt_only_shadowed}/{total})"
    );
    // 反向差异只量化:占比必须保持极小(CSM 偏置/软边缘属预期)。
    let raster_only_ratio = raster_only_shadowed as f64 / total as f64;
    assert!(
        raster_only_ratio <= 0.02,
        "raster-only shadow fraction too high: {raster_only_ratio}"
    );
    println!(
        "F2 RT/raster shadow parity: pixels={total} agree={agree} ({:.3}%) \
         violations rt_only={rt_only_shadowed} (interior={interior_violations} boundary={boundary_violations}, {:.4}%) \
         raster_only={raster_only_shadowed} ({:.4}%) mean|delta|={:.6} max|delta|={:.6} lit={lit_scale:.4} \
         rt_dark={rt_dark} raster_dark={raster_dark} tau={tau:.4} \
         lit_band={lit_band} shadow_band={shadow_band}",
        agree as f64 / total as f64 * 100.0,
        violation_ratio * 100.0,
        raster_only_ratio * 100.0,
        delta_sum / total as f64,
        max_abs_delta,
    );
}

/// 把两帧与放大 8 倍的差值图落盘为 PPM(test-output/),供人工/工具目视
/// 核验阴影形状与逐位一致结论;线性值按 gamma 2.2 做显示编码。
fn write_parity_artifacts(raster: &[[f32; 3]], rt: &[[f32; 3]], lit_scale: f32) {
    let luminance = |rgb: &[f32; 3]| 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    let encode = |value: f32| ((value.max(0.0)).powf(1.0 / 2.2).min(1.0) * 255.0) as u8;
    let frame = |pixels: &[[f32; 3]], name: &str| {
        let mut bytes = Vec::with_capacity(pixels.len() * 3);
        for rgb in pixels {
            bytes.extend_from_slice(&[encode(rgb[0]), encode(rgb[1]), encode(rgb[2])]);
        }
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/test-output/").to_string() + name;
        std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).ok();
        std::fs::write(
            &path,
            [format!("P6\n{SIZE} {SIZE}\n255\n").as_bytes(), &bytes].concat(),
        )
        .unwrap();
        println!("parity artifact: {path}");
    };
    frame(raster, "f2-rt-raster-parity-raster.ppm");
    frame(rt, "f2-rt-raster-parity-rt.ppm");
    // 差值图:|Δlum| / lit_scale 放大 8 倍,逐位一致时应为全黑。
    let diff: Vec<[f32; 3]> = raster
        .iter()
        .zip(rt.iter())
        .map(|(r, t)| {
            let d = 8.0 * (luminance(r) - luminance(t)).abs() / lit_scale;
            [d, d, d]
        })
        .collect();
    frame(&diff, "f2-rt-raster-parity-diff8x.ppm");
}
