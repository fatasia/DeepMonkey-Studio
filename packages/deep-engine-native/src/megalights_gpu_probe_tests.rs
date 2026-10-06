//! P1 native MegaLights 真机 GPU 探针门(#[ignore];六引擎对标刀位 2 的 WGSL leg)。
//!
//! RIS 采样核(单源 `packages/deep-engine/wgsl/megaLightsRis.wgsl`,经
//! [`crate::megalights_wgsl`] 逐字节锁存)按 TS `megaLightsRuntime.ts` 同款宿主
//! 模板组合(bindings 0-8 legacy 布局 + `deepSpotIesFactor`/`deepMegaVisibilityAt`
//! 恒 1 注入 = M1 可见性关),在真实 wgpu 设备上 dispatch 趟一+趟二,与 native
//! CPU 权威镜像([`crate::megalights_ris`])对拍:
//! - 穷举帧(无 RNG):GPU f32 vs CPU f64 词容差 ≤0.002(与 sdf-gi GPU 词门同量级);
//! - 随机帧:同 RNG 整数流,f32 评价与 f64 评价经蓄水池非线性放大 → 统计腿
//!   (相对 RMSE ≤15%,如实声明;逐位一致不成立是精度域差异,非语义分歧)。
//!
//! 黄金场景 = `fixtures/megalights-native-parity-v1.json`(CPU 权威链已在
//! [`crate::megalights_parity_tests`] 与 TS fixture 对拍;本文件只对 GPU leg)。

use crate::megalights_ris::{
    mega_lights_frame, MegaLight, MegaLightsFrameConfig, MegaLightsFrameInput, MegaSurfaceRow,
};
use crate::megalights_wgsl::DEEP_MEGA_LIGHTS_RIS_WGSL;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../deep-engine/fixtures/megalights-native-parity-v1.json");

fn fixture() -> &'static Value {
    use std::sync::OnceLock;
    static FIXTURE_PARSED: OnceLock<Value> = OnceLock::new();
    FIXTURE_PARSED.get_or_init(|| serde_json::from_str(FIXTURE).expect("fixture must parse"))
}

fn vec3(value: &Value) -> [f64; 3] {
    std::array::from_fn(|index| value[index].as_f64().expect("fixture vec3"))
}

fn words(value: &Value) -> Vec<f32> {
    value
        .as_array()
        .expect("fixture words array")
        .iter()
        .map(|value| value.as_f64().expect("fixture word") as f32)
        .collect()
}

fn parse_lights(fixture: &Value) -> Vec<MegaLight> {
    fixture["inputs"]["lights"]
        .as_array()
        .expect("fixture lights")
        .iter()
        .map(|entry| {
            let kind = match entry["kind"].as_str().expect("kind") {
                "point" => crate::megalights_ris::MegaLightKind::Point,
                "spot" => crate::megalights_ris::MegaLightKind::Spot,
                "area" => crate::megalights_ris::MegaLightKind::AreaRect,
                other => panic!("unknown fixture light kind {other}"),
            };
            let scalar = |key: &str, fallback: f64| entry[key].as_f64().unwrap_or(fallback);
            MegaLight {
                kind,
                position_view: vec3(&entry["positionView"]),
                range: entry["range"].as_f64().expect("range"),
                color: vec3(&entry["color"]),
                intensity: entry["intensity"].as_f64().expect("intensity"),
                decay: scalar("decay", 2.0),
                direction_view: entry["directionView"]
                    .as_array()
                    .map(|values| -> [f64; 3] {
                        std::array::from_fn(|index| values[index].as_f64().expect("direction"))
                    })
                    .unwrap_or([0.0, 0.0, 1.0]),
                inner_cone_cos: scalar("innerConeCos", 1.0),
                outer_cone_cos: scalar("outerConeCos", -1.0),
                half_extent: entry["halfExtent"]
                    .as_array()
                    .map(|values| {
                        [values[0].as_f64().expect("hw"), values[1].as_f64().expect("hh")]
                    })
                    .unwrap_or([0.0, 0.0]),
                two_sided: entry["twoSided"].as_bool().unwrap_or(false),
            }
        })
        .collect()
}

fn parse_surfaces(fixture: &Value) -> Vec<MegaSurfaceRow> {
    fixture["inputs"]["surfaces"]
        .as_array()
        .expect("fixture surfaces")
        .iter()
        .map(|row| {
            std::array::from_fn(|index| {
                let vec4 = row[index].as_array().expect("surface vec4");
                std::array::from_fn(|slot| vec4[slot].as_f64().expect("surface word"))
            })
        })
        .collect()
}

/// 宿主模板(TS composeMegaLightsShader 同构;可见性档关 = M1 注入恒 1):
/// DeepMegaParams 16 f32 字 + bindings 0-8 + 恒 1 注入 + RIS 核 + 两 entrypoint。
fn compose_probe_shader() -> String {
    format!(
        r#"
// DeepMegaParams 结构由 RIS 核体自带声明(单源);此处只声明绑定面。

@group(0) @binding(0) var<uniform> deepMegaFrame: DeepMegaParams;
@group(0) @binding(1) var<storage, read> deepMegaLights: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> deepMegaSurfaces: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> deepMegaMotion: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> deepMegaReservoirsA: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> deepMegaReservoirsB: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> deepMegaColor: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> deepMegaColorHistory: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read> deepIesShading: array<vec4<f32>>;

// M1 注入:IES 因子恒 1(fixture 灯池 iesWord 全 0,不触达);可见性恒 1(M1 逐位)。
fn deepSpotIesFactor(_row: u32, _surfaceToLight: vec3f, _lightDirection: vec3f) -> f32 {{
  return 1.0;
}}
fn deepMegaVisibilityAt(_pixelIndex: u32) -> f32 {{
  return 1.0;
}}

{DEEP_MEGA_LIGHTS_RIS_WGSL}

const DEEP_MEGA_SURFACES_STRIDE: u32 = 3u;

@compute @workgroup_size(8, 8)
fn megaProbeBuildMain(@builtin(global_invocation_id) gid: vec3u) {{
  if (gid.x >= deepMegaFrame.viewport.x || gid.y >= deepMegaFrame.viewport.y) {{ return; }}
  let pixelIndex = gid.y * deepMegaFrame.viewport.x + gid.x;
  let surfaceA = deepMegaSurfaces[pixelIndex * DEEP_MEGA_SURFACES_STRIDE];
  let surfaceB = deepMegaSurfaces[pixelIndex * DEEP_MEGA_SURFACES_STRIDE + 1u];
  let surfaceC = deepMegaSurfaces[pixelIndex * DEEP_MEGA_SURFACES_STRIDE + 2u];
  let built = deepMegaBuildReservoir(deepMegaFrame, pixelIndex,
    surfaceA, surfaceB, surfaceC, deepMegaReservoirsB[pixelIndex], deepMegaMotion[pixelIndex].xy);
  deepMegaReservoirsA[pixelIndex] = built;
}}

@compute @workgroup_size(8, 8)
fn megaProbeShadeMain(@builtin(global_invocation_id) gid: vec3u) {{
  if (gid.x >= deepMegaFrame.viewport.x || gid.y >= deepMegaFrame.viewport.y) {{ return; }}
  let pixelIndex = gid.y * deepMegaFrame.viewport.x + gid.x;
  let surfaceA = deepMegaSurfaces[pixelIndex * DEEP_MEGA_SURFACES_STRIDE];
  let surfaceB = deepMegaSurfaces[pixelIndex * DEEP_MEGA_SURFACES_STRIDE + 1u];
  let surfaceC = deepMegaSurfaces[pixelIndex * DEEP_MEGA_SURFACES_STRIDE + 2u];
  var center = deepMegaReservoirUnpack(deepMegaReservoirsA[pixelIndex]);
  let color = deepMegaReuseAndShade(deepMegaFrame, pixelIndex, surfaceA, surfaceB, surfaceC, &center);
  var blended = color;
  if (deepMegaFrame.temporalEnabled != 0u) {{
    blended = mix(deepMegaColorHistory[pixelIndex].rgb, color, vec3f(deepMegaFrame.alphaBlend));
  }}
  deepMegaColor[pixelIndex] = vec4f(blended, 0.0);
  deepMegaColorHistory[pixelIndex] = vec4f(blended, 0.0);
  deepMegaReservoirsB[pixelIndex] = deepMegaReservoirPack(center, surfaceA.w);
}}
"#
    )
}

async fn gpu_device() -> (wgpu::Device, wgpu::Queue) {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    // VULKAN 与 DX12 都试:naga→驱动编译器路径不同(RIS 核在 Vulkan 驱动编译触发设备重置时换 DX12)。
    // 真机门后端:优先 Vulkan(naga→SPIR-V);RIS 核在部分 naga/驱动组合的
    // SPIR-V 路径触发设备重置时,DEEP_MEGA_PROBE_BACKEND=dx12 走 HLSL 路径复验。
    descriptor.backends = match std::env::var("DEEP_MEGA_PROBE_BACKEND").as_deref() {
        Ok("dx12") => wgpu::Backends::DX12,
        _ => wgpu::Backends::VULKAN,
    };
    let instance = wgpu::Instance::new(descriptor);
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            ..Default::default()
        })
        .await
        .expect("real GPU adapter");
    adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .expect("GPU device")
}

fn readback_f32(device: &wgpu::Device, queue: &wgpu::Queue, source: &wgpu::Buffer, count: usize, label: &str) -> Vec<f32> {
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("megalights gpu probe readback"),
        size: (count * 4) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(source, 0, &staging, 0, (count * 4) as u64);
    queue.submit(Some(encoder.finish()));
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    staging.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    receiver
        .recv()
        .expect("map callback")
        .unwrap_or_else(|error| panic!("map failed for buffer '{label}': {error:?}"));
    let mapped = staging.get_mapped_range(..).expect("mapped range");
    mapped
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
        .collect()
}

fn buffer_init(device: &wgpu::Device, label: &str, contents: &[u8], usage: wgpu::BufferUsages) -> wgpu::Buffer {
    use wgpu::util::DeviceExt;
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents,
        usage,
    })
}

/// 穷举帧 GPU leg:无 RNG,输出与 CPU 镜像词容差对拍(≤0.002,f32 vs f64 落点)。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn exhaustive_gpu_output_tracks_cpu_mirror() {
    let fixture = fixture();
    let lights = parse_lights(fixture);
    let surfaces = parse_surfaces(fixture);
    let packed = words(&fixture["packed"]["data"]);
    let width = fixture["inputs"]["width"].as_u64().unwrap() as u32;
    let height = fixture["inputs"]["height"].as_u64().unwrap() as u32;
    let pixel_count = (width * height) as usize;

    // surfaces 摊平为 3 vec4/像素 storage 词。
    let mut surfaces_words = Vec::with_capacity(pixel_count * 12);
    for row in &surfaces {
        for vec4 in row {
            for slot in vec4 {
                surfaces_words.push(*slot as f32);
            }
        }
    }
    let motion_words = vec![0.0f32; pixel_count * 4];
    let reservoirs_b_init = vec![0.0f32; pixel_count * 4];
    let color_history_init = vec![0.0f32; pixel_count * 4];
    let params: [f32; 16] = [
        width as f32,
        height as f32,
        lights.len() as f32,
        44.0, // frameSeed = fixture 穷举帧
        1.0,  // spatialEnabled
        1.0,  // temporalEnabled(穷举趟二不消费 EMA,与 CPU exhaustive 分支同)
        1.0,  // exhaustive
        1.0,  // visibilitySlot
        1.0,  // alphaBlend(首帧全量替换;穷举腿无 EMA)
        0.0,  // visibilityEnabled = 关
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
    ];

    let device_pollster = pollster::block_on(gpu_device());
    let (device, queue) = (&device_pollster.0, &device_pollster.1);
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("megalights ris probe"),
        source: wgpu::ShaderSource::Wgsl(compose_probe_shader().into()),
    });
    // wgpu 30 管线单 entrypoint:分建 build/shade 两条管线,单 pass 依次 set。
    let (build_pipeline, shade_pipeline) = probe_pipelines(device, &shader);
    let (color_out, _reservoirs) = dispatch_two_pipelines(
        device,
        queue,
        &build_pipeline,
        &shade_pipeline,
        &params,
        &packed,
        &surfaces_words,
        &motion_words,
        &reservoirs_b_init,
        &color_history_init,
        pixel_count,
    );

    // CPU 镜像同帧同配置(可见性关、temporal 开但穷举分支跳过 EMA)。
    let mut config = MegaLightsFrameConfig::new(width, height);
    config.exhaustive = true;
    config.temporal = true;
    config.spatial = true;
    let input = MegaLightsFrameInput {
        lights: &lights,
        surfaces: &surfaces,
        previous: None,
        motion_uv: None,
        previous_color: None,
        visibility: None,
        frame: 44,
        config,
    };
    let expected = mega_lights_frame(&input).color;
    assert_eq!(color_out.len(), pixel_count * 4);
    for pixel in 0..pixel_count {
        for channel in 0..3 {
            let actual = f64::from(color_out[pixel * 4 + channel]);
            let expect = f64::from(expected[pixel * 3 + channel]);
            assert!(
                (actual - expect).abs() <= 0.002 * f64::max(1.0, expect.abs()),
                "exhaustive GPU leg pixel {pixel} channel {channel}: {actual} vs {expect}"
            );
        }
    }
}

/// 探针管线对(auto 布局;TS composeMegaLightsShader 的 legacy/shade 双布局同款——
/// 每 entrypoint 自反射触达绑定面;dispatch 侧按各自布局分别建 bind group)。
fn probe_pipelines(
    device: &wgpu::Device,
    shader: &wgpu::ShaderModule,
) -> (wgpu::ComputePipeline, wgpu::ComputePipeline) {
    let build = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("megalights ris probe build pipeline"),
        layout: None,
        module: shader,
        entry_point: Some("megaProbeBuildMain"),
        compilation_options: Default::default(),
        cache: None,
    });
    let shade = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("megalights ris probe shade pipeline"),
        layout: None,
        module: shader,
        entry_point: Some("megaProbeShadeMain"),
        compilation_options: Default::default(),
        cache: None,
    });
    (build, shade)
}

/// 双管线 dispatch(探针宿主;build→shade 同一 bind group)。
#[allow(clippy::too_many_arguments)]
fn dispatch_two_pipelines(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    build: &wgpu::ComputePipeline,
    shade: &wgpu::ComputePipeline,
    params_words: &[f32; 16],
    packed_lights: &[f32],
    surfaces_words: &[f32],
    motion_words: &[f32],
    reservoirs_b_init: &[f32],
    color_history_init: &[f32],
    pixel_count: usize,
) -> (Vec<f32>, Vec<f32>) {
    let params = buffer_init(device, "params", bytemuck::cast_slice(params_words), wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST);
    let lights = buffer_init(device, "lights", bytemuck::cast_slice(packed_lights), wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
    let surfaces = buffer_init(device, "surfaces", bytemuck::cast_slice(surfaces_words), wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
    let motion = buffer_init(device, "motion", bytemuck::cast_slice(motion_words), wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
    let reservoirs_a = buffer_init(device, "reservoirs A", bytemuck::cast_slice(&vec![0.0f32; pixel_count * 4]), wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC);
    let reservoirs_b = buffer_init(device, "reservoirs B", bytemuck::cast_slice(reservoirs_b_init), wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC);
    let color = buffer_init(device, "color", bytemuck::cast_slice(&vec![0.0f32; pixel_count * 4]), wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC);
    let color_history = buffer_init(device, "color history", bytemuck::cast_slice(color_history_init), wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
    let ies = buffer_init(device, "ies", bytemuck::cast_slice(&[-1.0f32; 4]), wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
    // auto 布局按 entrypoint 反射触达面:build 趟一 = 0-5(params/pool/surfaces/
    // motion/reservoirsA/B);shade 趟二 = 0-2,4-8(不用 motion;可见性档关)。
    let build_entries = [
        wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: lights.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 2, resource: surfaces.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 3, resource: motion.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 4, resource: reservoirs_a.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 5, resource: reservoirs_b.as_entire_binding() },
    ];
    let shade_entries = [
        wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: lights.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 2, resource: surfaces.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 4, resource: reservoirs_a.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 5, resource: reservoirs_b.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 6, resource: color.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 7, resource: color_history.as_entire_binding() },
    ];
    let bind_group_build = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("megalights probe bindings (build)"),
        layout: &build.get_bind_group_layout(0),
        entries: &build_entries,
    });
    let bind_group_shade = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("megalights probe bindings (shade)"),
        layout: &shade.get_bind_group_layout(0),
        entries: &shade_entries,
    });
    let (width, height) = (params_words[0] as u32, params_words[1] as u32);
    let groups = ((width + 7) / 8, (height + 7) / 8);
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("megalights probe frame"),
            ..Default::default()
        });
        pass.set_pipeline(build);
        pass.set_bind_group(0, &bind_group_build, &[]);
        pass.dispatch_workgroups(groups.0, groups.1, 1);
        pass.set_pipeline(shade);
        pass.set_bind_group(0, &bind_group_shade, &[]);
        pass.dispatch_workgroups(groups.0, groups.1, 1);
    }
    queue.submit(Some(encoder.finish()));
    device.poll(wgpu::PollType::wait_indefinitely()).expect("post-dispatch poll");
    let color_out = readback_f32(device, queue, &color, pixel_count * 4, "color");
    let reservoirs_out = readback_f32(device, queue, &reservoirs_a, pixel_count * 4, "reservoirs A");
    (color_out, reservoirs_out)
}

/// 随机帧 GPU leg:同 RNG 整数流,f32(GPU)vs f64(CPU)评价差异 → 统计腿。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn random_gpu_output_tracks_cpu_mirror_statistically() {
    let fixture = fixture();
    let lights = parse_lights(fixture);
    let surfaces = parse_surfaces(fixture);
    let packed = words(&fixture["packed"]["data"]);
    let width = fixture["inputs"]["width"].as_u64().unwrap() as u32;
    let height = fixture["inputs"]["height"].as_u64().unwrap() as u32;
    let pixel_count = (width * height) as usize;

    let mut surfaces_words = Vec::with_capacity(pixel_count * 12);
    for row in &surfaces {
        for vec4 in row {
            for slot in vec4 {
                surfaces_words.push(*slot as f32);
            }
        }
    }
    let motion_words = vec![0.0f32; pixel_count * 4];
    let reservoirs_b_init = vec![0.0f32; pixel_count * 4];
    let color_history_init = vec![0.0f32; pixel_count * 4];
    let params: [f32; 16] = [
        width as f32,
        height as f32,
        lights.len() as f32,
        40.0, // frameSeed = fixture 首帧
        1.0,
        1.0,
        0.0, // 随机模式
        1.0,
        1.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
    ];

    let device_pollster = pollster::block_on(gpu_device());
    let (device, queue) = (&device_pollster.0, &device_pollster.1);
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("megalights ris probe"),
        source: wgpu::ShaderSource::Wgsl(compose_probe_shader().into()),
    });
    let (build, shade) = probe_pipelines(device, &shader);
    let (color_out, reservoirs_out) = dispatch_two_pipelines(
        device,
        queue,
        &build,
        &shade,
        &params,
        &packed,
        &surfaces_words,
        &motion_words,
        &reservoirs_b_init,
        &color_history_init,
        pixel_count,
    );

    let mut config = MegaLightsFrameConfig::new(width, height);
    config.exhaustive = false;
    let input = MegaLightsFrameInput {
        lights: &lights,
        surfaces: &surfaces,
        previous: None,
        motion_uv: None,
        previous_color: None,
        visibility: None,
        frame: 40,
        config,
    };
    let expected = mega_lights_frame(&input);
    // 结构腿:winner 打包(+1 f32)与 m 逐位(GPU 蓄水池合并是纯算术,f32 weightSum
    // 量化在 1 ulp 内不改变 winner 竞选——黄金场景取值远离比较边界)。
    for pixel in 0..pixel_count {
        let gpu_words = &reservoirs_out[pixel * 4..pixel * 4 + 4];
        let cpu = &expected.reservoirs[pixel];
        let gpu_winner = if gpu_words[1] == 0.0 {
            crate::megalights_ris::MEGALIGHTS_INVALID_LIGHT
        } else {
            (gpu_words[1] as u32).wrapping_sub(1)
        };
        assert_eq!(gpu_winner, cpu.winner, "random GPU leg pixel {pixel} winner drift");
        assert_eq!(gpu_words[2] as u32, cpu.m, "random GPU leg pixel {pixel} m drift");
    }
    // 统计腿:f32 vs f64 评价链差异 → 相对 RMSE ≤15%(能量均值;如实声明)。
    let mut total = 0.0f64;
    for index in 0..pixel_count * 3 {
        let d = f64::from(color_out[index / 3 * 4 + index % 3]) - f64::from(expected.color[index]);
        total += d * d;
    }
    let error = f64::sqrt(total / (pixel_count * 3) as f64);
    let energy: f64 = expected.color.iter().map(|value| f64::from(value.abs())).sum::<f64>()
        / (pixel_count * 3) as f64;
    assert!(
        error <= f64::max(0.05, energy * 0.15),
        "random GPU leg relative RMSE {error} exceeds 15% energy envelope (energy mean {energy})"
    );
}
