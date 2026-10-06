//! Brief-GI native sdf-gi 真机 GPU 探针门(#[ignore];六引擎对标刀位 1 的 WGSL leg)。
//!
//! 三个 WGSL 计算核(单源 `packages/deep-engine/wgsl/sdf*.wgsl`,经
//! [`crate::sdf_gi_wgsl`] 逐字节锁存)在真实 wgpu 设备上 dispatch,输出与 native
//! CPU 权威镜像([`crate::sdf_gi_scene`]/[`crate::sdf_gi_trace`]/[`crate::sdf_gi_probe_update`])
//! 容差对拍 —— GPU f32(可能 FMA 融合)vs CPU f64+落点 fround 的差异按 A3 布料
//! 先例口径走容差,阈值取 fixture `tolerance` 段(与 TS 真机证据同量级):
//! - bake:逐 cell 距离 mean ≤0.01 / max ≤0.15(TS M3 真机同口径);
//! - trace:可见度 ≤0.01;命中距离 ≤1 步长(步进量化边界翻转);
//! - update:记录词 ≤0.002(16 方向 f32 累加)。
//!
//! 黄金场景 = `fixtures/sdf-gi-native-parity-v1.json`(CPU 权威链已在
//! [`crate::sdf_gi_parity_tests`] 与 TS 位级对拍;本文件只对 GPU leg)。

use crate::sdf_gi_probe_update::{
    BOUNCE_ENERGY_LIMIT, ProbeShPreviousRecord, ProbeShUpdateInput,
    SDF_GI_PROBE_RECORD_VEC4_STRIDE, SdfGiProbeUpdateParams, sdf_gi_probe_geometry_stats,
    update_probe_sh_with_sdf_gi,
};
use crate::sdf_gi_scene::{
    SdfInstanceDomain, SdfSceneBakeInstance, SdfSceneBakeOptions, SdfSceneTransform,
    bake_instance_grid, bake_sdf_scene_grid, derive_sdf_gi_probe_lattice, probe_lattice_bounds,
    transform_point,
};
use crate::sdf_gi_trace::{
    SdfSkyTraceParams, pack_direction_table, pack_probe_positions,
    resolve_sdf_sky_visibility_trace_config, trace_sdf_sky_visibility_with_hits,
};
use crate::sdf_gi_wgsl::{
    DEEP_SDF_BAKE_SCENE_GRID_WGSL, DEEP_SDF_GI_PROBE_UPDATE_WGSL,
    DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL, SDF_BAKE_SCENE_GRID_ENTRY, SDF_GI_PROBE_UPDATE_ENTRY,
    SDF_SKY_VISIBILITY_ENTRY,
};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../deep-engine/fixtures/sdf-gi-native-parity-v1.json");

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

struct FixtureScene {
    grid: crate::sdf_gi_scene::SdfSceneGrid,
    lattice: crate::sdf_gi_scene::SdfGiProbeLattice,
    directions: Vec<[f64; 3]>,
    vis: Vec<f32>,
    hits: Vec<f32>,
    cell_size: f64,
}

/// CPU 权威链重放(烘焙 + lattice + 追踪;fixture 位级对拍由 parity 测试背书)。
fn replay_cpu_chain(fixture: &Value) -> FixtureScene {
    let cell_size = fixture["inputs"]["cellSize"].as_f64().unwrap();
    // 先持有几何数据再借出(实例生命周期须覆盖烘焙调用)。
    struct Owned {
        id: String,
        positions: Vec<f32>,
        indices: Vec<u32>,
        dynamic: bool,
        transform: Option<SdfSceneTransform>,
    }
    let mut owned = Vec::new();
    for entry in fixture["inputs"]["instances"].as_array().unwrap() {
        let transform = if entry["basis"].is_null() {
            None
        } else {
            let basis: Vec<f64> = entry["basis"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_f64().unwrap())
                .collect();
            Some(SdfSceneTransform {
                basis: std::array::from_fn(|index| basis[index]),
                translation: vector(&entry["translation"]),
            })
        };
        owned.push(Owned {
            id: entry["id"].as_str().unwrap().to_string(),
            positions: words(&entry["positions"]),
            indices: entry["indices"]
                .as_array()
                .unwrap()
                .iter()
                .map(|index| index.as_u64().unwrap() as u32)
                .collect(),
            dynamic: entry["dynamic"].as_bool().unwrap_or(false),
            transform,
        });
    }
    let instances: Vec<SdfSceneBakeInstance<'_>> = owned
        .iter()
        .map(|instance| SdfSceneBakeInstance {
            id: &instance.id,
            positions: &instance.positions,
            indices: &instance.indices,
            dynamic: instance.dynamic,
            transform: instance.transform.clone(),
        })
        .collect();
    let (grid, _) = bake_sdf_scene_grid(
        &instances,
        SdfSceneBakeOptions {
            cell_size,
            instance_domain: SdfInstanceDomain::Aabb,
            ..SdfSceneBakeOptions::default()
        },
    )
    .expect("golden scene must bake");
    let (bounds_min, bounds_max) = probe_lattice_bounds(&grid);
    let lattice =
        derive_sdf_gi_probe_lattice(bounds_min, bounds_max, cell_size * 4.0, 4096).unwrap();
    let config = resolve_sdf_sky_visibility_trace_config(&grid, Default::default());
    let directions: Vec<[f64; 3]> = fixture["trace"]["directions"]
        .as_array()
        .unwrap()
        .iter()
        .map(vector)
        .collect();
    let (vis, hits) =
        trace_sdf_sky_visibility_with_hits(&grid, &lattice.positions, &directions, &config);
    FixtureScene {
        grid,
        lattice,
        directions,
        vis,
        hits,
        cell_size,
    }
}

async fn gpu_device() -> (wgpu::Device, wgpu::Queue) {
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
    adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .expect("GPU device")
}

fn readback_f32(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    source: &wgpu::Buffer,
    count: usize,
) -> Vec<f32> {
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("sdf-gi gpu probe readback"),
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
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("poll");
    receiver.recv().expect("map callback").expect("map");
    let mapped = staging.get_mapped_range(..).expect("mapped range");
    mapped
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
        .collect()
}

fn storage_buffer(device: &wgpu::Device, contents: &[f32], read_only: bool) -> wgpu::Buffer {
    use wgpu::util::DeviceExt;
    let mut usage = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST;
    if !read_only {
        usage |= wgpu::BufferUsages::COPY_SRC;
    }
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("sdf-gi gpu probe storage"),
        contents: bytemuck::cast_slice(contents),
        usage,
    })
}

fn uniform_buffer(device: &wgpu::Device, contents: &[u8]) -> wgpu::Buffer {
    use wgpu::util::DeviceExt;
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("sdf-gi gpu probe uniform"),
        contents,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    })
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn gpu_bake_kernel_matches_cpu_mirror_within_declared_tolerance() {
    let fixture = fixture();
    let scene = replay_cpu_chain(&fixture);
    let device_pollster = pollster::block_on(gpu_device());
    let (device, queue) = (&device_pollster.0, &device_pollster.1);

    // 世界系三角形表(每三角形 5 vec4:顶点 ×3 + 域 origin/dims;与 TS GPU 上传同构)。
    let mut triangles: Vec<f32> = Vec::new();
    for entry in fixture["inputs"]["instances"].as_array().unwrap() {
        if entry["dynamic"].as_bool().unwrap_or(false) {
            continue;
        }
        let positions: Vec<f32> = words(&entry["positions"]);
        let indices: Vec<u32> = entry["indices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|index| index.as_u64().unwrap() as u32)
            .collect();
        let transform = if entry["basis"].is_null() {
            None
        } else {
            let basis: Vec<f64> = entry["basis"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_f64().unwrap())
                .collect();
            Some(SdfSceneTransform {
                basis: std::array::from_fn(|index| basis[index]),
                translation: vector(&entry["translation"]),
            })
        };
        // 域行 = CPU bakeInstanceGrid 的 origin/dims(aabb 域;由 mirror 求值)。
        let (bounds_min, bounds_max) = crate::sdf_gi_scene::transformed_triangle_bounds(
            &positions,
            &indices,
            transform.as_ref(),
        );
        let (local, _) = bake_instance_grid(
            &positions,
            &indices,
            transform.as_ref(),
            bounds_min,
            bounds_max,
            scene.cell_size,
            scene.grid.dimensions,
            scene.grid.origin,
            SdfInstanceDomain::Aabb,
        )
        .map_err(|reason| format!("golden instance must bake: {reason}"))
        .unwrap();
        let world: Vec<f32> = (0..positions.len() / 3)
            .flat_map(|vertex| {
                let point = transform_point(
                    transform.as_ref(),
                    f64::from(positions[vertex * 3]),
                    f64::from(positions[vertex * 3 + 1]),
                    f64::from(positions[vertex * 3 + 2]),
                );
                [point[0] as f32, point[1] as f32, point[2] as f32]
            })
            .collect();
        for triangle in 0..indices.len() / 3 {
            for corner in 0..3 {
                let offset = indices[triangle * 3 + corner] as usize * 3;
                triangles.extend_from_slice(&world[offset..offset + 3]);
                triangles.push(0.0);
            }
            triangles.extend_from_slice(&[
                local.origin[0] as f32,
                local.origin[1] as f32,
                local.origin[2] as f32,
                local.dimensions[0] as f32,
            ]);
            triangles.extend_from_slice(&[
                local.dimensions[1] as f32,
                local.dimensions[2] as f32,
                0.0,
                0.0,
            ]);
        }
    }

    #[repr(C)]
    #[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
    struct BakeParams {
        dimensions: [u32; 3],
        triangle_count: u32,
        cell_size: f32,
        pad0: [f32; 3],
        origin: [f32; 3],
        exterior_distance: f32,
        cell_count: u32,
        pad1: [f32; 3],
    }
    let cell_count = scene.grid.distances.len();
    let params = BakeParams {
        dimensions: [
            scene.grid.dimensions[0] as u32,
            scene.grid.dimensions[1] as u32,
            scene.grid.dimensions[2] as u32,
        ],
        triangle_count: (triangles.len() / 20) as u32,
        cell_size: scene.cell_size as f32,
        pad0: [0.0; 3],
        origin: [
            scene.grid.origin[0] as f32,
            scene.grid.origin[1] as f32,
            scene.grid.origin[2] as f32,
        ],
        exterior_distance: fixture["bake"]["exteriorDistance"].as_f64().unwrap() as f32,
        cell_count: cell_count as u32,
        pad1: [0.0; 3],
    };
    assert_eq!(std::mem::size_of::<BakeParams>(), 64);

    let params_buffer = uniform_buffer(device, bytemuck::bytes_of(&params));
    let triangle_buffer = storage_buffer(device, &triangles, true);
    let field_buffer = storage_buffer(device, &vec![0.0f32; cell_count], false);
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("sdf bake scene grid"),
        source: wgpu::ShaderSource::Wgsl(DEEP_SDF_BAKE_SCENE_GRID_WGSL.into()),
    });
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("sdf bake layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("sdf bake bindings"),
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: triangle_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: field_buffer.as_entire_binding(),
            },
        ],
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("sdf bake pipeline"),
        layout: Some(
            &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("sdf bake pipeline layout"),
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            }),
        ),
        module: &module,
        entry_point: Some(SDF_BAKE_SCENE_GRID_ENTRY),
        compilation_options: Default::default(),
        cache: None,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups(cell_count.div_ceil(64) as u32, 1, 1);
    }
    queue.submit(Some(encoder.finish()));
    let gpu_field = readback_f32(device, queue, &field_buffer, cell_count);

    // 容差对拍(TS M3 真机口径):场质量预算(mean ≤0.01 / max ≤0.15)作用于
    // **非翻转 cell**;符号翻转是 WGSL 核的文档化退化射线限制(共棱射线逐三角形
    // 直接计数无排序去重,parity 可能翻转;TS 真机证据 0.28% cells,同源如实)。
    // 翻转单独设预算:计数 ≤5% cells、翻转幅度 ≤ 半对角线( garbage 哨兵)。
    let tolerance = &fixture["tolerance"];
    let mean_budget = tolerance["gpuBakeCellMean"].as_f64().unwrap();
    let max_budget = tolerance["gpuBakeCellMax"].as_f64().unwrap();
    let mut total = 0.0f64;
    let mut worst = 0.0f64;
    let mut kept = 0usize;
    let mut sign_flips = 0usize;
    let mut worst_flip = 0.0f64;
    let diagonal = ((f64::from(scene.grid.dimensions[0] as u32 - 1) * scene.cell_size).powi(2)
        + (f64::from(scene.grid.dimensions[1] as u32 - 1) * scene.cell_size).powi(2)
        + (f64::from(scene.grid.dimensions[2] as u32 - 1) * scene.cell_size).powi(2))
    .sqrt();
    for (gpu, cpu) in gpu_field.iter().zip(&scene.grid.distances) {
        let difference = (f64::from(*gpu) - f64::from(*cpu)).abs();
        let flipped = gpu.signum() != cpu.signum() && difference > max_budget * 0.5;
        if flipped {
            sign_flips += 1;
            worst_flip = worst_flip.max(f64::from(*cpu).abs());
        } else {
            total += difference;
            worst = worst.max(difference);
            kept += 1;
        }
    }
    let mean = if kept > 0 { total / kept as f64 } else { 0.0 };
    let flip_budget = (cell_count as f64 * 0.05) as usize;
    assert!(
        mean <= mean_budget,
        "GPU 烘焙非翻转 cell 平均误差 {mean} 超预算 {mean_budget}"
    );
    assert!(
        worst <= max_budget,
        "GPU 烘焙非翻转 cell 最大误差 {worst} 超预算 {max_budget}"
    );
    assert!(
        sign_flips <= flip_budget,
        "GPU 烘焙符号翻转 {sign_flips} 超 cells×5% 预算 {flip_budget}(退化射线如实口径)"
    );
    assert!(
        worst_flip <= diagonal * 0.5,
        "翻转幅度 {worst_flip} 超半对角线哨兵(garbage 防线)"
    );
    println!(
        "sdf bake gpu probe: cells={cell_count} kept={kept} mean={mean:.6} max={worst:.6} \
         sign_flips={sign_flips}({flip_budget} budget) worst_flip_distance={worst_flip:.4}"
    );
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn gpu_trace_and_update_kernels_match_cpu_mirror_within_declared_tolerance() {
    let fixture = fixture();
    let scene = replay_cpu_chain(&fixture);
    let device_pollster = pollster::block_on(gpu_device());
    let (device, queue) = (&device_pollster.0, &device_pollster.1);
    let config = resolve_sdf_sky_visibility_trace_config(&scene.grid, Default::default());
    let direction_count = scene.directions.len();
    let probe_count = scene.lattice.positions.len();
    let lanes = probe_count * direction_count;

    // ===== 天光追踪核 =====
    let params = SdfSkyTraceParams::from_config(
        &scene.grid,
        &config,
        direction_count as u32,
        probe_count as u32,
    );
    let params_buffer = uniform_buffer(device, bytemuck::bytes_of(&params));
    let field_buffer = storage_buffer(device, &scene.grid.distances, true);
    let position_buffer = storage_buffer(
        device,
        &pack_probe_positions(&scene.lattice.positions),
        true,
    );
    let direction_buffer = storage_buffer(device, &pack_direction_table(&scene.directions), true);
    let visibility_buffer = storage_buffer(device, &vec![0.0f32; lanes], false);
    let hit_buffer = storage_buffer(device, &vec![0.0f32; lanes], false);
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("sdf sky visibility trace"),
        source: wgpu::ShaderSource::Wgsl(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL.into()),
    });
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("sdf sky trace layout"),
        entries: &(0..6u32)
            .map(|binding| wgpu::BindGroupLayoutEntry {
                binding,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: if binding == 0 {
                        wgpu::BufferBindingType::Uniform
                    } else {
                        wgpu::BufferBindingType::Storage {
                            read_only: matches!(binding, 1..=3),
                        }
                    },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            })
            .collect::<Vec<_>>(),
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("sdf sky trace bindings"),
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: field_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: position_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: direction_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: visibility_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: hit_buffer.as_entire_binding(),
            },
        ],
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("sdf sky trace pipeline"),
        layout: Some(
            &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("sdf sky trace pipeline layout"),
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            }),
        ),
        module: &module,
        entry_point: Some(SDF_SKY_VISIBILITY_ENTRY),
        compilation_options: Default::default(),
        cache: None,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups(lanes.div_ceil(64) as u32, 1, 1);
    }
    queue.submit(Some(encoder.finish()));
    let gpu_vis = readback_f32(device, queue, &visibility_buffer, lanes);
    let gpu_hits = readback_f32(device, queue, &hit_buffer, lanes);

    let tolerance = &fixture["tolerance"];
    let visibility_budget = tolerance["gpuVisibility"].as_f64().unwrap();
    let step_length = config.max_distance / f64::from(config.steps);
    let hit_budget = tolerance["gpuHitDistanceStepLengths"].as_f64().unwrap() * step_length;
    let mut worst_vis = 0.0f64;
    let mut worst_hit = 0.0f64;
    for index in 0..lanes {
        worst_vis = worst_vis.max((f64::from(gpu_vis[index]) - f64::from(scene.vis[index])).abs());
        let gpu_hit = f64::from(gpu_hits[index]);
        let cpu_hit = f64::from(scene.hits[index]);
        let difference = if gpu_hit < 0.0 || cpu_hit < 0.0 {
            // 哨兵翻转 = 邻近步 contribution==1 边界;按 1 步长容差口径。
            if (gpu_hit < 0.0) != (cpu_hit < 0.0) {
                step_length
            } else {
                0.0
            }
        } else {
            (gpu_hit - cpu_hit).abs()
        };
        worst_hit = worst_hit.max(difference);
    }
    assert!(
        worst_vis <= visibility_budget,
        "GPU 可见度最大误差 {worst_vis} 超预算 {visibility_budget}"
    );
    assert!(
        worst_hit <= hit_budget,
        "GPU 命中距离最大误差 {worst_hit} 超 {hit_budget:.4}(1 步长口径)"
    );

    // ===== 探针 SH 更新核(输入 = CPU 追踪输出;窗口覆盖全部探针)=====
    let sky = vector(&fixture["inputs"]["skyRadianceRgb"]);
    let sky_table: Vec<f32> = (0..direction_count)
        .flat_map(|_| [sky[0] as f32, sky[1] as f32, sky[2] as f32, 0.0])
        .collect();
    let initial =
        crate::sdf_gi_probe_update::pack_initial_sdf_gi_records(probe_count, config.max_distance);
    let record_words: Vec<f32> = initial
        .iter()
        .flat_map(|record| {
            bytemuck::bytes_of(record)
                .chunks_exact(4)
                .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
                .collect::<Vec<f32>>()
        })
        .collect();
    let update_input = ProbeShUpdateInput {
        previous: &initial
            .iter()
            .map(|record| {
                Some(ProbeShPreviousRecord {
                    irradiance: record.irradiance.map(f64::from),
                    validity: f64::from(record.validity),
                    mean_distance: f64::from(record.mean_distance),
                    distance_variance: f64::from(record.distance_variance),
                    occlusion_floor: f64::from(record.occlusion_floor),
                    position_offset: record.position_offset.map(f64::from),
                })
            })
            .collect::<Vec<_>>(),
        directions: &scene.directions,
        visibilities: &scene.vis,
        direction_sky_radiance: &vec![sky; direction_count],
        ssgdi: &[],
        bounce_albedo: Some(vector(&fixture["inputs"]["bounceAlbedo"])),
        alpha: None,
        geometry_stats: Some(&sdf_gi_probe_geometry_stats(
            &scene.hits,
            direction_count,
            config.max_distance,
        )),
    };
    let update_params =
        SdfGiProbeUpdateParams::pack(&update_input, 0, probe_count, config.max_distance);
    let update_params_buffer = uniform_buffer(device, bytemuck::bytes_of(&update_params));
    let vis_buffer = storage_buffer(device, &scene.vis, true);
    let sky_buffer = storage_buffer(device, &sky_table, true);
    let records_buffer = storage_buffer(device, &record_words, false);
    let hits_buffer = storage_buffer(device, &scene.hits, true);
    let update_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("sdf gi probe update"),
        source: wgpu::ShaderSource::Wgsl(DEEP_SDF_GI_PROBE_UPDATE_WGSL.into()),
    });
    let update_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("sdf gi probe update layout"),
        entries: &(0..5u32)
            .map(|binding| wgpu::BindGroupLayoutEntry {
                binding,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: if binding == 0 {
                        wgpu::BufferBindingType::Uniform
                    } else {
                        wgpu::BufferBindingType::Storage {
                            read_only: matches!(binding, 1 | 2 | 4),
                        }
                    },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            })
            .collect::<Vec<_>>(),
    });
    let update_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("sdf gi probe update bindings"),
        layout: &update_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: update_params_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: vis_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: sky_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: records_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: hits_buffer.as_entire_binding(),
            },
        ],
    });
    let update_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("sdf gi probe update pipeline"),
        layout: Some(
            &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("sdf gi probe update pipeline layout"),
                bind_group_layouts: &[Some(&update_layout)],
                immediate_size: 0,
            }),
        ),
        module: &update_module,
        entry_point: Some(SDF_GI_PROBE_UPDATE_ENTRY),
        compilation_options: Default::default(),
        cache: None,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&update_pipeline);
        pass.set_bind_group(0, &update_bind_group, &[]);
        pass.dispatch_workgroups(probe_count.div_ceil(64) as u32, 1, 1);
    }
    queue.submit(Some(encoder.finish()));
    let gpu_record_words = readback_f32(
        device,
        queue,
        &records_buffer,
        probe_count * SDF_GI_PROBE_RECORD_VEC4_STRIDE * 4,
    );

    let record_budget = tolerance["gpuRecordWord"].as_f64().unwrap();
    let cpu_result = update_probe_sh_with_sdf_gi(&update_input);
    let mut worst_word = 0.0f64;
    for (probe, record) in cpu_result.records.iter().enumerate() {
        let cpu_words: Vec<f32> = bytemuck::bytes_of(record)
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
            .collect();
        for (word, cpu) in cpu_words.iter().enumerate() {
            let index = probe * SDF_GI_PROBE_RECORD_VEC4_STRIDE * 4 + word;
            worst_word =
                worst_word.max((f64::from(gpu_record_words[index]) - f64::from(*cpu)).abs());
        }
    }
    assert!(
        worst_word <= record_budget,
        "GPU 记录词最大误差 {worst_word} 超预算 {record_budget}"
    );
    assert_eq!(BOUNCE_ENERGY_LIMIT, 2.01, "bounce 哨兵常量漂移守卫");
    println!(
        "sdf trace+update gpu probe: lanes={lanes} worst_vis={worst_vis:.6} \
         worst_hit={worst_hit:.4} worst_record_word={worst_word:.6}"
    );
}
