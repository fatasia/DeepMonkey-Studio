//! R4 遮挡消费链 GPU 证据(第二切片):紧凑 count 与遮挡判定一致性、
//! 批次区域行序 CPU 对照、双跑位级确定性、4096 实例多方时间对照。
//! 复用首切片 harness(`gpu_occlusion_tests`);需要 real GPU 的用例按
//! 本 crate 惯例 `#[ignore]`,显式 `--ignored` 运行。

use bytemuck::cast_slice;
use deep_engine_native::culling_contract::{
    MAIN_SOLID_MASK, PreparedGpuCulling, batch_ranges_from_metadata, GPU_CULLING_INSTANCE_BYTES,
};
use deep_engine_native::mesh_abi::FrameUniform;
use wgpu::util::DeviceExt;

use crate::gpu_culling::GpuCulling;
use crate::gpu_occlusion::OcclusionSource;
use crate::gpu_occlusion_consume::ConsumeCompacted;
use crate::gpu_occlusion_tests::{
    Bench, Scene, Shadows, bench_device, frame_for, grid_instances, hiz_pyramid, packed_instance,
    prepared, scenario_view, standard_depth, world_point,
};

/// 每轮 encode+submit+poll 后取回 (frustum 幸存数, 遮挡标志数, 紧凑输出)。
fn run_chain(
    culling: &mut GpuCulling,
    bench: &Bench,
    frame: &FrameUniform,
) -> (u32, Option<u32>, Option<ConsumeCompacted>) {
    culling.update_views(&bench.queue, frame, &Shadows).unwrap();
    let mut encoder = bench
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("R4 occlusion consume encoder"),
        });
    culling.encode(&bench.queue, &mut encoder);
    culling.commit_submission();
    bench.queue.submit(Some(encoder.finish()));
    bench
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    let frustum = culling.take_metrics(&bench.device).unwrap().unwrap();
    let flags = culling.take_occlusion_visible(&bench.device).unwrap();
    let compacted = culling.take_occlusion_compacted(&bench.device).unwrap();
    (frustum.main.visible_instances, flags, compacted)
}

fn build(
    bench: &Bench,
    scene: &Scene,
    prepared_culling: &PreparedGpuCulling,
    hiz: Option<(&wgpu::TextureView, u32, u32, u32)>,
    consume: bool,
    enable_readback: bool,
) -> GpuCulling {
    let source = bench
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("R4 consume test instances"),
            contents: cast_slice(&scene.instances),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
    let mut culling = GpuCulling::new(
        &bench.device,
        &source,
        prepared_culling,
        &scene.frame,
        &Shadows,
        enable_readback,
    )
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
        if consume {
            culling
                .attach_occlusion_consume(&bench.device, &source, enable_readback)
                .expect("consume stage builds");
        }
    }
    culling
}

/// 双批次 prepared:批次 0 = 前 half 实例,批次 1 = 其余(instance_start=half)。
fn prepared_two_batches(total: usize, half: usize) -> PreparedGpuCulling {
    let mut metadata = vec![[0u32; 4]; total];
    for (index, row) in metadata.iter_mut().enumerate() {
        *row = if index < half {
            [0, MAIN_SOLID_MASK, 0, 0]
        } else {
            [1, MAIN_SOLID_MASK, half as u32, 0]
        };
    }
    PreparedGpuCulling {
        bounds: vec![[0.0, 0.0, 0.0, 0.25]; total],
        metadata,
        indirect_template: vec![[36, 0, 0, 0, 0]; 2],
    }
}

/// 单个对照用例:(名称, 场景, prepared, HiZ 各层, 期望幸存数, 期望 draws)。
type ConsumeCase<'a> = (&'a str, &'a Scene, &'a PreparedGpuCulling, &'a [&'a [f32]], u32, u32);

/// 场景 A/B/C 复跑:紧凑 count 必须逐场景等于遮挡判定 count(64/0/64),
/// per-batch 计数、indirect draws、幸存行数一致。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn consume_compacted_counts_match_decision_across_three_scenarios() {
    let bench = pollster::block_on(bench_device());
    let view = scenario_view(6.0);
    let occluder_b = standard_depth(1.0);
    let occluder_c = standard_depth(3.0);
    let scene_grid = Scene { instances: grid_instances(view, 6.0), frame: frame_for(view) };
    let mut instances_mixed = grid_instances(view, 2.0);
    instances_mixed.extend(grid_instances(view, 4.0));
    let scene_mixed = Scene { instances: instances_mixed, frame: frame_for(view) };
    let prepared_single = prepared(64);
    let prepared_double = prepared(128);
    let levels_far: &[&[f32]] = &[&[1.0; 16], &[1.0; 4], &[1.0]];
    let levels_b: &[&[f32]] = &[&[occluder_b; 16], &[occluder_b; 4], &[occluder_b]];
    let levels_c: &[&[f32]] = &[&[occluder_c; 16], &[occluder_c; 4], &[occluder_c]];
    let cases: [ConsumeCase; 3] = [
        ("A all-in-frustum", &scene_grid, &prepared_single, levels_far, 64, 1),
        ("B all-occluded", &scene_grid, &prepared_single, levels_b, 0, 0),
        ("C mixed", &scene_mixed, &prepared_double, levels_c, 64, 1),
    ];
    for (name, scene, prepared_culling, levels, expected, draws) in cases {
        let (_texture, hiz_view) = hiz_pyramid(&bench.device, &bench.queue, levels);
        let mut culling = build(&bench, scene, prepared_culling, Some((&hiz_view, 4, 4, 2)), true, true);
        let (frustum, flags, compacted) = run_chain(&mut culling, &bench, &scene.frame);
        let compacted = compacted.expect("consume readback enabled");
        println!(
            "consume {name}: frustum={frustum} flags={flags:?} compacted={} per_batch={:?} draws={}",
            compacted.total(),
            compacted.per_batch,
            compacted.draws(),
        );
        assert_eq!(flags, Some(expected), "{name}: flag count mismatch");
        assert_eq!(compacted.total(), expected, "{name}: compacted count mismatch");
        assert_eq!(compacted.draws(), draws, "{name}: draw count mismatch");
        assert_eq!(compacted.per_batch, vec![expected], "{name}: per-batch mismatch");
        // rows readback 覆盖整个紧凑区容量;幸存数由 per_batch 决定。
        assert_eq!(
            compacted.rows.len(),
            prepared_culling.bounds.len(),
            "{name}: row capacity mismatch"
        );
    }
}

/// 场景 D(双批次):前景批全幸存、背景批全剔。紧凑行必须按 instance id
/// 升序落在各自批次区域内,且与 CPU 参考行逐字节一致。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn consume_places_rows_in_batch_regions_in_cpu_reference_order() {
    let bench = pollster::block_on(bench_device());
    let view = scenario_view(6.0);
    let mut instances = grid_instances(view, 2.0);
    instances.extend(grid_instances(view, 4.0));
    let scene = Scene { instances, frame: frame_for(view) };
    let prepared_culling = prepared_two_batches(128, 64);
    assert_eq!(
        batch_ranges_from_metadata(&prepared_culling.metadata, 2),
        vec![[0, 64, 0, 0], [64, 128, 0, 0]]
    );
    let occluder = standard_depth(3.0);
    let (_texture, hiz_view) =
        hiz_pyramid(&bench.device, &bench.queue, &[&[occluder; 16], &[occluder; 4], &[occluder]]);
    let mut culling = build(&bench, &scene, &prepared_culling, Some((&hiz_view, 4, 4, 2)), true, true);
    let (frustum, flags, compacted) = run_chain(&mut culling, &bench, &scene.frame);
    let compacted = compacted.expect("consume readback enabled");
    println!(
        "consume two-batch: frustum={frustum} flags={flags:?} compacted={} per_batch={:?}",
        compacted.total(),
        compacted.per_batch,
    );
    assert_eq!(frustum, 128);
    assert_eq!(flags, Some(64));
    assert_eq!(compacted.per_batch, vec![64, 0], "front batch survives, back batch culled");
    // CPU 参考:批次 0 的幸存行 = 实例 0..64 按 id 升序,逐字节一致;
    // 背景批无幸存,其区域槽位保持初始零(不被触碰)。
    assert_eq!(
        compacted.rows[..64],
        scene.instances[..64],
        "compacted rows must equal source rows of the surviving front batch, in id order"
    );
    assert!(
        compacted.rows[64..].iter().all(|row| row.iter().all(|value| *value == 0.0)),
        "slots beyond the compacted count must stay zero"
    );
}

/// 位级确定性:同场景两次完整 encode→readback,紧凑计数与幸存行逐字节一致。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn consume_output_is_bit_identical_across_runs() {
    let bench = pollster::block_on(bench_device());
    let view = scenario_view(6.0);
    let scene = Scene { instances: grid_instances(view, 6.0), frame: frame_for(view) };
    let (_texture, hiz_view) =
        hiz_pyramid(&bench.device, &bench.queue, &[&[1.0; 16], &[1.0; 4], &[1.0]]);
    let mut culling = build(&bench, &scene, &prepared(64), Some((&hiz_view, 4, 4, 2)), true, true);
    let first = run_chain(&mut culling, &bench, &scene.frame).2.expect("first run readback");
    let second = run_chain(&mut culling, &bench, &scene.frame).2.expect("second run readback");
    assert_eq!(first.per_batch, second.per_batch);
    assert_eq!(first.rows.len(), second.rows.len());
    assert_eq!(
        cast_slice::<[f32; (GPU_CULLING_INSTANCE_BYTES / 4) as usize], u8>(&first.rows),
        cast_slice::<[f32; (GPU_CULLING_INSTANCE_BYTES / 4) as usize], u8>(&second.rows),
        "compacted rows must be bit-identical across runs"
    );
}

/// 性能对照:4096 实例混合深度(前 2048 幸存 / 后 2048 被剔),四条链
/// 交替采样:全量提交下限(空编码器)/ frustum-only / +遮挡 / +遮挡+消费。
/// 口径(如实,与首切片一致):CPU 墙钟包住 encode+submit+poll,非 GPU
/// timestamp;「全量」在本 compute harness 中只能给出提交下限,不含 draw
/// 工作量,draw 侧收益以幸存实例数换算并如实标注。21 轮交替,丢 5 预热,
/// 取 16 样本中位。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn performance_consume_chain_three_way_at_4096() {
    let bench = pollster::block_on(bench_device());
    let view = scenario_view(6.0);
    let mut instances = Vec::with_capacity(4096);
    for row in 0..32 {
        for column in 0..64 {
            instances.push(packed_instance(world_point(
                view,
                2.0,
                (column as f32 - 31.5) * 0.035,
                (row as f32 - 15.5) * 0.035,
            )));
        }
    }
    for row in 0..32 {
        for column in 0..64 {
            instances.push(packed_instance(world_point(
                view,
                4.0,
                (column as f32 - 31.5) * 0.035,
                (row as f32 - 15.5) * 0.035,
            )));
        }
    }
    let scene = Scene { instances, frame: frame_for(view) };
    let mut metadata = vec![[0u32; 4]; 4096];
    for (index, row) in metadata.iter_mut().enumerate() {
        *row = if index < 2048 {
            [0, MAIN_SOLID_MASK, 0, 0]
        } else {
            [1, MAIN_SOLID_MASK, 2048, 0]
        };
    }
    let prepared_culling = PreparedGpuCulling {
        bounds: vec![[0.0, 0.0, 0.0, 0.25]; 4096],
        metadata,
        indirect_template: vec![[36, 0, 0, 0, 0]; 2],
    };
    let occluder = standard_depth(3.0);
    let (_texture, hiz_view) =
        hiz_pyramid(&bench.device, &bench.queue, &[&[occluder; 16], &[occluder; 4], &[occluder]]);
    // 计数核对(单次,readback 开启):4096 → 2048 → 2048,per-batch [2048, 0]。
    {
        let mut verify = build(&bench, &scene, &prepared_culling, Some((&hiz_view, 4, 4, 2)), true, true);
        let (frustum, flags, compacted) = run_chain(&mut verify, &bench, &scene.frame);
        let compacted = compacted.expect("verify readback");
        println!(
            "consume 4096 counts: frustum={frustum} flags={flags:?} compacted={} per_batch={:?} draws={}",
            compacted.total(),
            compacted.per_batch,
            compacted.draws(),
        );
        assert_eq!(frustum, 4096);
        assert_eq!(flags, Some(2048));
        assert_eq!(compacted.total(), 2048);
        assert_eq!(compacted.per_batch, vec![2048, 0]);
    }
    let mut frustum_only = build(&bench, &scene, &prepared_culling, None, false, false);
    let mut occlusion_only =
        build(&bench, &scene, &prepared_culling, Some((&hiz_view, 4, 4, 2)), false, false);
    let mut consume_chain =
        build(&bench, &scene, &prepared_culling, Some((&hiz_view, 4, 4, 2)), true, false);
    let mut floor_samples = Vec::new();
    let mut frustum_samples = Vec::new();
    let mut occlusion_samples = Vec::new();
    let mut consume_samples = Vec::new();
    for round in 0..21 {
        floor_samples.push(timed_floor(&bench));
        frustum_samples.push(timed(&mut frustum_only, &bench, &scene.frame));
        occlusion_samples.push(timed(&mut occlusion_only, &bench, &scene.frame));
        consume_samples.push(timed(&mut consume_chain, &bench, &scene.frame));
        let _ = round;
    }
    for samples in [&mut floor_samples, &mut frustum_samples, &mut occlusion_samples, &mut consume_samples] {
        samples.sort();
    }
    let median = |samples: &[std::time::Duration]| samples[13];
    println!(
        "performance 4096 (median of 16, CPU wall clock): floor={:?} frustum_only={:?} plus_occlusion={:?} plus_consume={:?}",
        median(&floor_samples),
        median(&frustum_samples),
        median(&occlusion_samples),
        median(&consume_samples),
    );
    println!(
        "performance 4096 full samples: floor={floor_samples:?} frustum={frustum_samples:?} occlusion={occlusion_samples:?} consume={consume_samples:?}"
    );
    // 合理性断言:消费链不引发病态放大(阈值宽松防误报;方向不作物理结论)。
    assert!(
        median(&consume_samples).as_secs_f64() < median(&frustum_samples).as_secs_f64() * 5.0 + 0.005,
        "consume chain exploded frame time: {:?} -> {:?}",
        median(&frustum_samples),
        median(&consume_samples),
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
            label: Some("R4 consume perf encoder"),
        });
    culling.encode(&bench.queue, &mut encoder);
    bench.queue.submit(Some(encoder.finish()));
    bench
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    start.elapsed()
}

/// 「全量」口径:无剔除时的提交下限(空编码器 encode+submit+poll),
/// 不含 draw 工作量——draw 侧省略需渲染接线,如实标注。
fn timed_floor(bench: &Bench) -> std::time::Duration {
    let start = std::time::Instant::now();
    let encoder = bench
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("R4 consume perf floor encoder"),
        });
    bench.queue.submit(Some(encoder.finish()));
    bench
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    start.elapsed()
}

/// WGSL 契约冻结:定序纪律(无原子、无共享内存、workgroup_size 64、
/// 五 entry point)与槽位写法不回退。
#[test]
fn freezes_occlusion_compaction_shader_contract() {
    let shader = include_str!("../assets/shaders/native_gpu_occlusion_compact_v1.wgsl");
    for entry_point in [
        "fn scan_blocks(",
        "fn scan_block_offsets(",
        "fn scan_instance_prefix(",
        "fn compact_instances(",
        "fn write_indirect(",
    ] {
        assert!(shader.contains(entry_point), "missing entry point {entry_point}");
    }
    assert_eq!(shader.matches("@compute @workgroup_size(64)").count(), 5);
    assert!(!shader.contains("atomic"), "compaction must stay atomic-free");
    assert!(
        !shader.contains("var<workgroup>"),
        "compaction must stay shared-memory-free"
    );
    assert!(shader.contains("compact_visible[slot] = source_instances[id.x]"));
}

/// 失败路径:未挂遮挡判定时挂消费链必须报错,不得静默空转。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn consume_attach_requires_the_decision_stage() {
    let bench = pollster::block_on(bench_device());
    let view = scenario_view(6.0);
    let scene = Scene { instances: grid_instances(view, 6.0), frame: frame_for(view) };
    let source = bench
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("R4 consume failure-path instances"),
            contents: cast_slice(&scene.instances),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
    let mut culling =
        GpuCulling::new(&bench.device, &source, &prepared(64), &scene.frame, &Shadows, false)
            .expect("frustum culling builds");
    let error = culling
        .attach_occlusion_consume(&bench.device, &source, false)
        .expect_err("consume without occlusion must fail");
    assert!(error.contains("requires the occlusion stage"), "{error}");
}
