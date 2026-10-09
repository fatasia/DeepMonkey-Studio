//! sdf-gi GPU 三核生产链真机探针(#[ignore];renderer 生产通路的端到端 leg)。
//!
//! 与 lib 侧 `crate::sdf_gi_gpu_probe_tests`(单核合同两腿: bake / trace+update)
//! 的分工:本文件钉死 **renderer 生产链编排** —— `plan_gpu → SdfGiGpuChain::
//! create → submit_initial_dispatch(bake→trace 全域→update 全域→publish copy)
//! → advance 窗口 → evaluate_scene_change(哈希缓存三态)`。
//!
//! == 期望侧口径(三层证据链,如实)==
//! bake 核的退化射线翻转(共棱计数差,腿 1 已按场级预算背书)经 trace 级联
//! 会放大到记录面(探针遮挡语义差),与 CPU bake 场直接对拍必然超核级预算
//! (实测 24 探针黄金场景 occlusionFloor 差至 0.23)。因此本腿期望侧 =
//! **读回 GPU 场后按 CPU 权威数学重追**(trace/update 镜像,场差为共同输入):
//! 记录词 ≤0.002 严预算下,钉死编排正确性(dispatch 序/publish 96B 偏移/
//! 窗口计划/α 首帧语义/哈希三态)+ trace/update 核在生产绑定面上的行为;
//! 场质量由腿 1 背书,核数学由腿 2 背书。
//! - validity 逐位同;F5/padding 通道恒零(生产者合同);
//! - publish copy 不动网格头(偏移 96B 合同)。
//!
//! 黄金场景 = `fixtures/sdf-gi-native-parity-v1.json`(CPU 权威链已与 TS 位级
//! 对拍背书)。真机运行:`cargo test --bin deep-engine-native gpu_production_chain
//! -- --ignored`。

use std::sync::Arc;

use deep_engine_native::probe_gi_abi::PROBE_GI_RECORD_BYTES;
use deep_engine_native::sdf_gi_scene::SdfSceneTransform;

use super::sdf_gi_runtime::{SdfGiBakeSource, SdfGiFrameRuntime};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../deep-engine/fixtures/sdf-gi-native-parity-v1.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("golden fixture must parse")
}

fn vector(value: &Value) -> [f64; 3] {
    std::array::from_fn(|index| value[index].as_f64().expect("fixture vec3"))
}

fn words(value: &Value) -> Vec<f32> {
    value
        .as_array()
        .expect("fixture words")
        .iter()
        .map(|value| value.as_f64().expect("word") as f32)
        .collect()
}

/// 黄金场景 → 烘焙源(顶点 xyz 直用;basis 缺省 = 恒等,与生产解包层同款)。
fn fixture_sources() -> Vec<SdfGiBakeSource> {
    fixture()["inputs"]["instances"]
        .as_array()
        .expect("fixture instances")
        .iter()
        .map(|entry| {
            let transform = if entry["basis"].is_null() {
                SdfSceneTransform::default()
            } else {
                let basis: Vec<f64> = entry["basis"]
                    .as_array()
                    .expect("basis")
                    .iter()
                    .map(|value| value.as_f64().expect("basis lane"))
                    .collect();
                SdfSceneTransform {
                    basis: std::array::from_fn(|index| basis[index]),
                    translation: vector(&entry["translation"]),
                }
            };
            SdfGiBakeSource {
                id: entry["id"].as_str().expect("instance id").to_string(),
                positions: Arc::new(words(&entry["positions"])),
                indices: entry["indices"]
                    .as_array()
                    .expect("indices")
                    .iter()
                    .map(|index| index.as_u64().expect("index") as u32)
                    .collect(),
                transform,
            }
        })
        .collect()
}

/// 天空辐射面(fixture 单色天空 → mip0 六纹素,生产环境均值同构输入)。
fn fixture_diffuse() -> Vec<[f32; 4]> {
    let sky = vector(&fixture()["inputs"]["skyRadianceRgb"]);
    vec![[sky[0] as f32, sky[1] as f32, sky[2] as f32, 1.0]; 6]
}

/// probe storage([网格头 + 探针记录];COPY_DST|COPY_SRC 供 readback)。
fn probe_storage(device: &wgpu::Device, record_count: usize) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("sdf-gi production probe storage"),
        size: ((1 + record_count) * PROBE_GI_RECORD_BYTES) as u64,
        usage: wgpu::BufferUsages::COPY_DST
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    })
}

fn readback_records(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    source: &wgpu::Buffer,
    record_count: usize,
) -> Vec<[f32; 24]> {
    let bytes = (record_count * PROBE_GI_RECORD_BYTES) as u64;
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("sdf-gi production readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(source, 0, &staging, 0, bytes);
    queue.submit(Some(encoder.finish()));
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    staging.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("poll");
    receiver.recv().expect("map callback").expect("map");
    let mapped = staging.get_mapped_range(..).expect("mapped range");
    mapped
        .chunks_exact(PROBE_GI_RECORD_BYTES)
        .map(|record| {
            std::array::from_fn(|word| {
                f32::from_le_bytes(record[word * 4..word * 4 + 4].try_into().unwrap())
            })
        })
        .collect()
}

/// ABI 词面(irradiance.rgb / validity / meanDistance / variance /
/// occlusionFloor)与 F5/padding 恒零合同的同时校验,返回七词差的最大值。
fn record_words_gap(
    gpu: &[f32; 24],
    cpu: &deep_engine_native::probe_gi_abi::IrradianceProbeRecord,
) -> f64 {
    let cpu_layout = [
        f64::from(cpu.irradiance[0]),
        f64::from(cpu.irradiance[1]),
        f64::from(cpu.irradiance[2]),
        f64::from(cpu.validity),
        f64::from(cpu.mean_distance),
        f64::from(cpu.distance_variance),
        f64::from(cpu.occlusion_floor),
    ];
    assert!(
        f64::from(gpu[3]) == f64::from(cpu.validity),
        "validity 逐位透传"
    );
    assert!(
        gpu[7..].iter().all(|word| *word == 0.0),
        "F5/padding 通道恒零(生产者合同)"
    );
    cpu_layout
        .iter()
        .enumerate()
        .map(|(word, cpu_value)| (f64::from(gpu[word]) - cpu_value).abs())
        .fold(0.0f64, |worst, gap| worst.max(gap))
}

/// 镜像链输入组装(统一 'a 生命周期;与生产链同 plan/lattice/方向/天空辐射)。
fn mirror_input<'a>(
    plan: &'a super::sdf_gi_runtime::SdfGiGpuPlan,
    vis: &'a [f32],
    previous: &'a [Option<deep_engine_native::sdf_gi_probe_update::ProbeShPreviousRecord>],
    stats: &'a [(f64, f64)],
    alpha: Option<f64>,
) -> deep_engine_native::sdf_gi_probe_update::ProbeShUpdateInput<'a> {
    deep_engine_native::sdf_gi_probe_update::ProbeShUpdateInput {
        previous,
        directions: &plan.directions,
        visibilities: vis,
        direction_sky_radiance: &plan.sky_radiance,
        ssgdi: &[],
        bounce_albedo: None,
        alpha,
        geometry_stats: Some(stats),
    }
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn gpu_production_chain_matches_cpu_authority_within_declared_tolerance() {
    pollster::block_on(async {
        let sources = fixture_sources();
        let diffuse = fixture_diffuse();
        let skipped = 0usize;

        // GPU 生产链:规划 → 资源创建(独立 error scope,与 init.rs 同款三过滤)。
        let plan = SdfGiFrameRuntime::plan_gpu(&sources, &diffuse).expect("GPU plan");
        let probe_count = plan.lattice.positions.len();
        let direction_count = plan.directions.len();
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::VULKAN;
        let instance = wgpu::Instance::new(descriptor);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .expect("GPU device");
        let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
        let chain = super::sdf_gi_gpu::SdfGiGpuChain::create(&plan, &sources, &device)
            .expect("GPU chain must build");
        let mut runtime = SdfGiFrameRuntime::from_gpu_chain(chain, skipped);
        let gpu_errors = [
            internal.pop().await,
            memory.pop().await,
            validation.pop().await,
        ];
        assert!(
            gpu_errors.iter().flatten().next().is_none(),
            "GPU 资源创建 error scope 必须干净"
        );

        // init 全域首追:bake → trace → update → publish copy 进 storage。
        // storage 先按 init.rs 物化路径预填(网格头 + 烘焙初值;网格头为 CPU
        // 构造,验证 publish copy 只覆盖探针区)。
        let storage = probe_storage(&device, probe_count);
        let cpu_header = runtime.initial_records().expect("GPU initial records")[0];
        {
            let mut initial = runtime.initial_records().expect("GPU initial records");
            initial[0] = cpu_header;
            let bytes: Vec<u8> = initial
                .iter()
                .flat_map(|record| bytemuck::bytes_of(record).to_vec())
                .collect();
            queue.write_buffer(&storage, 0, &bytes);
        }
        if let Some(chain) = runtime.gpu_chain_mut() {
            chain.submit_initial_dispatch(&device, &queue, &storage);
        }

        // 期望侧 = 读回 GPU 场后按 CPU 权威数学重追(场差为共同输入;三层证据
        // 链见模块头)。镜像链与生产链同 lattice/方向/追踪配置/天空辐射。
        let (grid_origin, cell_size, grid_dims) =
            runtime.gpu_chain_mut().expect("GPU leg").grid_geometry();
        let gpu_field = {
            let chain = runtime.gpu_chain_mut().expect("GPU leg");
            let cells = chain.cells_for_test();
            let staging = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("sdf-gi field readback"),
                size: (cells * 4) as u64,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            let mut encoder = device.create_command_encoder(&Default::default());
            encoder.copy_buffer_to_buffer(chain.field_buffer(), 0, &staging, 0, (cells * 4) as u64);
            queue.submit(Some(encoder.finish()));
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            staging.map_async(wgpu::MapMode::Read, .., move |result| {
                let _ = sender.send(result);
            });
            device
                .poll(wgpu::PollType::wait_indefinitely())
                .expect("poll");
            receiver.recv().expect("map callback").expect("map");
            let mapped = staging.get_mapped_range(..).expect("mapped range");
            mapped
                .chunks_exact(4)
                .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
                .collect::<Vec<f32>>()
        };
        let mirror_grid = deep_engine_native::sdf_gi_scene::SdfSceneGrid {
            origin: grid_origin,
            cell_size,
            dimensions: grid_dims,
            distances: gpu_field,
        };
        let (mirror_vis, mirror_hits) =
            deep_engine_native::sdf_gi_trace::trace_sdf_sky_visibility_with_hits(
                &mirror_grid,
                &plan.lattice.positions,
                &plan.directions,
                &plan.trace_config,
            );
        // 首帧语义:previous = None(与 CPU 权威腿全域首追同款;GPU 侧由 α=1 落实)。
        let mirror_stats = deep_engine_native::sdf_gi_probe_update::sdf_gi_probe_geometry_stats(
            &mirror_hits,
            direction_count,
            plan.trace_config.max_distance,
        );
        let no_previous: Vec<
            Option<deep_engine_native::sdf_gi_probe_update::ProbeShPreviousRecord>,
        > = vec![None; probe_count];
        let mirror_init = deep_engine_native::sdf_gi_probe_update::update_probe_sh_with_sdf_gi(
            &mirror_input(&plan, &mirror_vis, &no_previous, &mirror_stats, None),
        );

        // 对拍 1:init 后记录面 vs 镜像链(≤0.002 严预算;publish 96B 偏移不动头)。
        let gpu_after_init = readback_records(&device, &queue, &storage, 1 + probe_count);
        let record_budget = fixture()["tolerance"]["gpuRecordWord"].as_f64().unwrap();
        let mut worst_init = 0.0f64;
        for (probe, cpu_record) in mirror_init.records.iter().enumerate() {
            worst_init = worst_init.max(record_words_gap(&gpu_after_init[1 + probe], cpu_record));
        }
        assert!(
            worst_init <= record_budget,
            "GPU 生产链 init 记录词最大误差 {worst_init} 超预算 {record_budget}"
        );
        let header_words: [f32; 24] = std::array::from_fn(|word| {
            f32::from_le_bytes(
                bytemuck::bytes_of(&cpu_header)[word * 4..word * 4 + 4]
                    .try_into()
                    .unwrap(),
            )
        });
        assert_eq!(
            readback_records(&device, &queue, &storage, 1)[0],
            header_words,
            "publish copy 不动网格头(96B 偏移合同)"
        );

        // 对拍 2:advance 一窗(黄金探针数 ≤ 预算 → 全域一窗,α=0.1)vs 镜像链
        // 同 α 时域滤波(previous = init 结果,与 GPU 记录面链式一致)。
        if let Some(chain) = runtime.gpu_chain_mut() {
            chain.advance(&device, &queue, &storage);
        }
        let gpu_after_window = readback_records(&device, &queue, &storage, 1 + probe_count);
        let previous: Vec<Option<deep_engine_native::sdf_gi_probe_update::ProbeShPreviousRecord>> =
            mirror_init.records_f64.iter().cloned().map(Some).collect();
        let mirror_window = deep_engine_native::sdf_gi_probe_update::update_probe_sh_with_sdf_gi(
            &mirror_input(&plan, &mirror_vis, &previous, &mirror_stats, Some(0.1)),
        );
        let mut worst_window = 0.0f64;
        for (probe, cpu_record) in mirror_window.records.iter().enumerate() {
            worst_window =
                worst_window.max(record_words_gap(&gpu_after_window[1 + probe], cpu_record));
        }
        assert!(
            worst_window <= record_budget,
            "GPU 生产链窗口记录词最大误差 {worst_window} 超预算 {record_budget}"
        );

        // 对拍 3:重烘焙哈希缓存三态。
        let hash_before = runtime.gpu_chain_mut().expect("GPU leg").content_hash();
        let same_plan = SdfGiFrameRuntime::plan_gpu(&sources, &diffuse).expect("same plan");
        if let Some(chain) = runtime.gpu_chain_mut() {
            assert_eq!(
                chain.evaluate_scene_change(&same_plan, &sources, &device, &queue, &storage),
                super::sdf_gi_gpu::SdfGiRebakeOutcome::CacheHit,
                "同内容再评估 = 哈希命中跳过"
            );
        }
        let mut renamed = sources.clone();
        renamed[0].id = format!("{}-renamed", renamed[0].id);
        let renamed_plan = SdfGiFrameRuntime::plan_gpu(&renamed, &diffuse).expect("renamed plan");
        if let Some(chain) = runtime.gpu_chain_mut() {
            assert_eq!(
                chain.evaluate_scene_change(&renamed_plan, &renamed, &device, &queue, &storage),
                super::sdf_gi_gpu::SdfGiRebakeOutcome::Rebaked,
                "内容变(哈希变)而格几何不变 = 原位重烘焙"
            );
            assert_ne!(chain.content_hash(), hash_before, "重烘焙后哈希推进");
        }
        // 格几何变化反例:首实例平移(哈希变 + bounds 并集变 → dims/cells 变,
        // 仍在 cells 预算内;远域实例会把 cells 推爆成 BakeContract,不入此臂)。
        let mut grown = sources.clone();
        grown[0].transform.translation[0] += 3.0;
        let grown_plan = SdfGiFrameRuntime::plan_gpu(&grown, &diffuse).expect("grown plan");
        assert_ne!(
            grown_plan.grid_plan.dimensions, plan.grid_plan.dimensions,
            "反例前提:平移必须实际改变格几何"
        );
        if let Some(chain) = runtime.gpu_chain_mut() {
            assert_eq!(
                chain.evaluate_scene_change(&grown_plan, &grown, &device, &queue, &storage),
                super::sdf_gi_gpu::SdfGiRebakeOutcome::GridGeometryChanged,
                "格几何变化 = fail-closed 维持旧静态层"
            );
        }
        let (_, windows, _) = runtime.telemetry();
        assert_eq!(windows, 1, "窗口游标:advance 一次(重烘焙不推进节奏)");
        println!(
            "sdf gi production chain probe: probes={probe_count} init_worst={worst_init:.6} \
             window_worst={worst_window:.6} cache_hit/rebaked/grid_changed asserted"
        );
    });
}
