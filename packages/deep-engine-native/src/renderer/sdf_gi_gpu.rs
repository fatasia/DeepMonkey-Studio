//! Brief-GI native sdf-gi GPU 三核 dispatch 生产链(bake → trace → update → 发布)。
//!
//! 三个 WGSL 计算核经 [`deep_engine_native::sdf_gi_wgsl`] 逐字节单源消费(与
//! 真机探针门 [`crate::sdf_gi_gpu_probe_tests`] 同源同绑定面):
//! - `sdfBakeSceneGrid` —— 场景距离场 compute 烘焙(每 lane = 一个 cell);
//! - `traceSkyVisibility` —— 天光圆锥追踪(每 lane = 一对 探针×方向);
//! - `sdfGiProbeUpdate` —— 探针 SH 更新(每 lane = 更新窗口内一个探针,记录行
//!   96B ABI 原地读改写,时域级联发生在 GPU f32 记录面)。
//!
//! == 发布(TS sdfGiPublish 的 native 形)==
//! TS 侧 publish 核把记录物化为 clipmap 采样纹理;native 的探针消费面是
//! `ProbeGiStorage`(binding 11 storage buffer,mesh 采样直读)。因此 native
//! 发布 = `copy_buffer_to_buffer`(records 面复制进 probe storage,偏移 96B
//! 网格头之后)—— 全程驻留 GPU,零读回零逐窗口 write_buffer,与 CPU 腿的
//! 窗口上传同帧序合同(先于本帧 submit,opaque 采样读到新记录)。
//!
//! == 帧合同(与 CPU 权威腿同构;如实差异)==
//! - 窗口计划同源(同一 `plan_sdf_gi_probe_window` 预算),update 核按
//!   windowOffset/windowCount 只更新窗口探针记录 —— 每探针每周期恰更新一次,
//!   与 CPU 腿逐帧语义等价;
//! - 天光追踪核无窗口参数(全 lane 合同),GPU 腿每帧全域重追(≤4096×16 lane,
//!   GPU 毫秒下量级):窗口探针消费的可见度同为当帧新鲜值,非窗口 lane 的
//!   刷新不被 update 消费(记录行不动)—— 记录流与 CPU 腿一致,如实声明;
//! - 时域级联在 GPU f32 记录面(原地读改写);CPU 腿是 f64 链式面 —— GPU f32
//!   量化按真机探针容差对拍(≤0.002/词),与 TS 生产 GPU 核同口径。
//!
//! == 重烘焙 + 内容哈希缓存(sdfGiBakeContentHash 语义 native 对齐)==
//! 帧内包更新(publish_render_packet_update 唯一提交点)触发评估:SHA-256
//! 内容哈希(实例序 × (id+顶点+索引+变换) × cellSize,域前缀与 TS 同串)命中
//! → 跳过整次烘焙(旧场/记录/lattice 原样续用);未命中且格几何(scene_min/
//! cellSize/dims/cells/lattice 逐位)不变 → 原位重烘焙(三角形表/烘焙参数/
//! 记录面重置重上传 + bake→trace 全域→update 全域→发布);格几何变化 →
//! fail-closed 维持旧静态层并诊断披露(不半挂载)。哈希只在本进程内与上次
//! 烘焙对比,跨机一致性不作承诺(与 TS 同语义;字段按小端落盘)。

use deep_engine_native::sdf_gi_probe_update::{
    SDF_GI_PROBE_UPDATE_PARAMS_BYTES, SdfGiProbeUpdateParams, pack_initial_sdf_gi_records,
    plan_sdf_gi_probe_window,
};
use deep_engine_native::sdf_gi_scene::{SdfSceneGrid, transform_point};
use deep_engine_native::sdf_gi_scene_compose::SdfGiProbeLattice;
use deep_engine_native::sdf_gi_trace::{
    SdfSkyTraceParams, SdfSkyVisibilityTraceConfig, pack_direction_table, pack_probe_positions,
};
use deep_engine_native::sdf_gi_wgsl::{
    DEEP_SDF_BAKE_SCENE_GRID_WGSL, DEEP_SDF_GI_PROBE_UPDATE_WGSL,
    DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL, SDF_BAKE_SCENE_GRID_ENTRY, SDF_GI_PROBE_UPDATE_ENTRY,
    SDF_SKY_VISIBILITY_ENTRY,
};

use super::sdf_gi_runtime::{
    SDF_GI_PROBE_WINDOW_BUDGET, SdfGiBakeSource, SdfGiGpuPlan, SdfGiReject,
};
use deep_engine_native::probe_gi_abi::{IrradianceProbeRecord, PROBE_GI_RECORD_BYTES};
use deep_engine_native::sdf_gi_probe_update::{
    BOUNCE_ENERGY_LIMIT, DEEP_GI_PROBE_TEMPORAL_ALPHA, SDF_GI_PROBE_RECORD_VEC4_STRIDE,
};

/// WGSL bake 参数块(TS `packBakeParams` 同布局 64B:vec3f 对齐 16 把 origin 顶到
/// 32;真机按 struct 全长取 minBindingSize,52 舍入 64,布局互钉)。
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct SdfBakeParams {
    dimensions: [u32; 3],
    triangle_count: u32,
    cell_size: f32,
    pad0: [f32; 3],
    origin: [f32; 3],
    exterior_distance: f32,
    cell_count: u32,
    pad1: [f32; 3],
}

/// sdf-gi GPU 三核链(renderer 独占;所有 GPU 资源随链释放)。
pub(crate) struct SdfGiGpuChain {
    // ===== CPU 规划面(与 CPU 腿同源;重烘焙原位条件判定用)=====
    grid_origin: [f64; 3],
    cell_size: f64,
    dimensions: [usize; 3],
    cells: usize,
    /// 探针 lattice(原位条件判定与网格头构造共用)。
    lattice: SdfGiProbeLattice,
    /// Fibonacci 方向集(诊断面;GPU 侧常驻的是打包 direction_table buffer)。
    #[cfg_attr(not(test), allow(dead_code))]
    directions: Vec<[f64; 3]>,
    trace_config: SdfSkyVisibilityTraceConfig,
    /// 烘焙内容哈希(上次 GPU 烘焙的输入指纹;重烘焙缓存键)。
    content_hash: [u8; 32],
    probe_count: usize,
    direction_count: usize,
    lanes: usize,
    records_bytes: usize,
    triangle_word_count: usize,

    // ===== GPU 资源 =====
    bake_pipeline: wgpu::ComputePipeline,
    trace_pipeline: wgpu::ComputePipeline,
    update_pipeline: wgpu::ComputePipeline,
    bake_bind_group: wgpu::BindGroup,
    trace_bind_group: wgpu::BindGroup,
    update_bind_group: wgpu::BindGroup,
    bake_params: wgpu::Buffer,
    update_params: wgpu::Buffer,
    triangle_buffer: wgpu::Buffer,
    /// 距离场(bind group 保活 + 真机编排腿读回;生产代码不读回)。
    #[cfg_attr(not(all(test, windows)), allow(dead_code))]
    field: wgpu::Buffer,
    records: wgpu::Buffer,
    /// 已派发更新窗口数(窗口计划游标;与 CPU 腿同语义)。
    dispatched_windows: usize,
}

/// 重烘焙评估结论(诊断披露词汇)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SdfGiRebakeOutcome {
    /// 内容哈希命中:静态层未变,零 GPU 工作跳过。
    CacheHit,
    /// 原位重烘焙完成(格几何不变;记录面已重置并全域首追)。
    Rebaked,
    /// 格几何变化(scene_min/cellSize/dims/cells/lattice 逐位不同):
    /// fail-closed 维持旧静态层。
    GridGeometryChanged,
}

/// 世界系三角形表展平(TS `flattenWorldTriangles` 同式):每三角形 5 vec4 =
/// 顶点 ×3(w=0)+ (域 origin.xyz, dimX) + (dimY, dimZ, 0, 0)。aabb 域 =
/// 变换后 AABB ± cellSize 外推圈(origin 逐分量 fround,与 bake_instance_grid
/// 同式);域 dims = ceil((max+pad−origin)/cs)+1。域上限不在此检查(WGSL 核按
/// 上传 dims 域裁剪自洽;与 TS GPU 路径同口径,如实差异于 CPU 逐实例
/// grid-extent skip)。
fn flatten_world_triangles(sources: &[SdfGiBakeSource], plan: &SdfGiGpuPlan) -> Vec<f32> {
    let cell_size = plan.cell_size;
    let mut triangles = Vec::new();
    for (ordinal, bounds) in plan
        .grid_plan
        .static_indices
        .iter()
        .zip(&plan.grid_plan.static_bounds)
    {
        let source = &sources[*ordinal];
        let (bounds_min, bounds_max) = *bounds;
        let pad = cell_size;
        let domain_origin = [
            (bounds_min[0] - pad) as f32,
            (bounds_min[1] - pad) as f32,
            (bounds_min[2] - pad) as f32,
        ];
        let domain_dims: [usize; 3] = std::array::from_fn(|axis| {
            (((bounds_max[axis] + pad - f64::from(domain_origin[axis])) / cell_size).ceil() + 1.0)
                as usize
        });
        for triangle in 0..source.indices.len() / 3 {
            for corner in 0..3 {
                let offset = source.indices[triangle * 3 + corner] as usize * 3;
                let point = transform_point(
                    Some(&source.transform),
                    f64::from(source.positions[offset]),
                    f64::from(source.positions[offset + 1]),
                    f64::from(source.positions[offset + 2]),
                );
                triangles.extend_from_slice(&[
                    point[0] as f32,
                    point[1] as f32,
                    point[2] as f32,
                    0.0,
                ]);
            }
            triangles.extend_from_slice(&[
                domain_origin[0],
                domain_origin[1],
                domain_origin[2],
                domain_dims[0] as f32,
            ]);
            triangles.extend_from_slice(&[domain_dims[1] as f32, domain_dims[2] as f32, 0.0, 0.0]);
        }
    }
    triangles
}

/// 烘焙内容哈希(TS `sdfGiBakeContentHash` native 对齐):域前缀 +
/// u32 实例数 + 逐实例(u32 id 长度 + id 字节 + 顶点 f32 字节 + u32 索引数 +
/// 索引 u32 字节 + 9×f32 行主 basis + 3×f32 平移)+ f64 cellSize + 域字节。
/// native GPU 链烘焙域恒 aabb(TS scene 域字节 =1;native 恒 0)。字段小端
/// 显式落盘;哈希只与本进程上次烘焙对比。
pub(crate) fn sdf_gi_bake_content_hash(sources: &[SdfGiBakeSource], cell_size: f64) -> [u8; 32] {
    const DOMAIN: &[u8] = b"deep-engine.sdf-gi.bake.content.v1\n";
    let mut stream: Vec<u8> =
        Vec::with_capacity(DOMAIN.len() + 4 + sources.len() * (4 + 64 + 4 + 48) + 8 + 1);
    stream.extend_from_slice(DOMAIN);
    stream.extend_from_slice(&(sources.len() as u32).to_le_bytes());
    for source in sources {
        stream.extend_from_slice(&(source.id.len() as u32).to_le_bytes());
        stream.extend_from_slice(source.id.as_bytes());
        for value in source.positions.iter() {
            stream.extend_from_slice(&value.to_le_bytes());
        }
        stream.extend_from_slice(&(source.indices.len() as u32).to_le_bytes());
        for index in &source.indices {
            stream.extend_from_slice(&index.to_le_bytes());
        }
        for basis in source.transform.basis {
            stream.extend_from_slice(&(basis as f32).to_le_bytes());
        }
        for translation in source.transform.translation {
            stream.extend_from_slice(&(translation as f32).to_le_bytes());
        }
    }
    stream.extend_from_slice(&cell_size.to_le_bytes());
    // 域字节:TS scene=1/aabb=0;native GPU 链烘焙域恒 aabb(与 CPU 腿同)。
    stream.push(0);
    deep_engine_native::shader_package::hash::sha256_bytes(&stream)
}

/// 记录面字节 → f32 词(96B ABI;storage 打包与真机探针同式)。
fn record_words(records: &[IrradianceProbeRecord]) -> Vec<f32> {
    records
        .iter()
        .flat_map(|record| {
            bytemuck::bytes_of(record)
                .chunks_exact(4)
                .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("96B ABI word")))
        })
        .collect()
}

/// update 核 uniform 参数(帧/全域共用构造面;window 两参与 α 为变量)。
/// α=1 用于 init/重烘焙的全域首追:记录面 previous 是烘焙零初值,α=1 使
/// blended = target,与 CPU 权威腿"previous=None → 全量目标场"的首帧语义
/// 逐值一致;帧窗口用缺省 α(0.1,时域滤波)。
fn update_params_struct(
    probe_count: usize,
    direction_count: usize,
    window_offset: u32,
    window_count: u32,
    max_distance: f64,
    alpha: f64,
) -> SdfGiProbeUpdateParams {
    SdfGiProbeUpdateParams {
        probe_count: probe_count as u32,
        direction_count: direction_count as u32,
        window_offset,
        window_count,
        alpha: alpha as f32,
        bounce_enabled: 0,
        record_vec4_stride: SDF_GI_PROBE_RECORD_VEC4_STRIDE as u32,
        bounce_energy_limit: BOUNCE_ENERGY_LIMIT as f32,
        bounce_albedo: [0.0; 4],
        max_distance: max_distance as f32,
        padding: [0.0; 3],
    }
}

impl SdfGiGpuChain {
    /// GPU 资源创建与常驻上传(同步;调用方包 error scope 并 await pop 判
    /// GpuDeviceRejected)。尺寸护栏超限 = GpuResourceLimit(fail-closed 回退
    /// CPU 权威链)。记录面初值 = 烘焙期有界先验(真实记录由 init dispatch
    /// 在首帧渲染前算出并发布进 probe storage)。
    pub(crate) fn create(
        plan: &SdfGiGpuPlan,
        sources: &[SdfGiBakeSource],
        device: &wgpu::Device,
    ) -> Result<Self, SdfGiReject> {
        assert_eq!(
            std::mem::size_of::<SdfBakeParams>(),
            64,
            "bake 参数块布局漂移(WGSL struct 互钉)"
        );
        assert_eq!(
            std::mem::size_of::<SdfGiProbeUpdateParams>(),
            SDF_GI_PROBE_UPDATE_PARAMS_BYTES,
            "update 参数块布局漂移(WGSL struct 互钉)"
        );
        let limit = device.limits().max_storage_buffer_binding_size;
        let probe_count = plan.lattice.positions.len();
        let direction_count = plan.directions.len();
        let lanes = probe_count * direction_count;
        let triangles = flatten_world_triangles(sources, plan);
        let cells = plan.grid_plan.cells;
        let field_bytes = cells * 4;
        let lanes_bytes = lanes * 4;
        let triangle_bytes = triangles.len() * 4;
        let records_bytes = probe_count * PROBE_GI_RECORD_BYTES;
        // 尺寸护栏(任一超 binding 上限 → fail-closed 回退 CPU 链)。
        if triangle_bytes as u64 > limit
            || field_bytes as u64 > limit
            || lanes_bytes as u64 > limit
            || records_bytes as u64 > limit
        {
            return Err(SdfGiReject::GpuResourceLimit);
        }
        use wgpu::util::DeviceExt;
        let bake_params_struct = SdfBakeParams {
            dimensions: [
                plan.grid_plan.dimensions[0] as u32,
                plan.grid_plan.dimensions[1] as u32,
                plan.grid_plan.dimensions[2] as u32,
            ],
            triangle_count: (triangles.len() / 20) as u32,
            cell_size: plan.cell_size as f32,
            pad0: [0.0; 3],
            origin: [
                plan.grid_plan.scene_min[0] as f32,
                plan.grid_plan.scene_min[1] as f32,
                plan.grid_plan.scene_min[2] as f32,
            ],
            exterior_distance: plan.grid_plan.exterior_distance,
            cell_count: cells as u32,
            pad1: [0.0; 3],
        };
        // SdfSkyTraceParams::from_config 只读格几何三字段(距离场视图零长)。
        let trace_params = SdfSkyTraceParams::from_config(
            &SdfSceneGrid {
                origin: plan.grid_plan.scene_min,
                cell_size: plan.cell_size,
                dimensions: plan.grid_plan.dimensions,
                distances: Vec::new(),
            },
            &plan.trace_config,
            direction_count as u32,
            probe_count as u32,
        );
        let update_initial = update_params_struct(
            probe_count,
            direction_count,
            0,
            probe_count as u32,
            plan.trace_config.max_distance,
            1.0,
        );
        let initial_words = record_words(&pack_initial_sdf_gi_records(
            probe_count,
            plan.trace_config.max_distance,
        ));
        let bake_params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("sdf-gi gpu bake params"),
            contents: bytemuck::bytes_of(&bake_params_struct),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let trace_params_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("sdf-gi gpu trace params"),
            contents: bytemuck::bytes_of(&trace_params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let update_params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("sdf-gi gpu update params"),
            contents: bytemuck::bytes_of(&update_initial),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let triangle_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("sdf-gi gpu bake triangles"),
            contents: bytemuck::cast_slice(&triangles),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        let field = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("sdf-gi gpu field"),
            size: field_bytes as u64,
            // COPY_SRC:真机编排腿读回场做镜像重追(生产代码不读回)。
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let position_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("sdf-gi gpu probe positions"),
            contents: bytemuck::cast_slice(&pack_probe_positions(&plan.lattice.positions)),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let direction_table = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("sdf-gi gpu directions"),
            contents: bytemuck::cast_slice(&pack_direction_table(&plan.directions)),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let sky_table: Vec<f32> = plan
            .sky_radiance
            .iter()
            .flat_map(|rgb| [rgb[0] as f32, rgb[1] as f32, rgb[2] as f32, 0.0])
            .collect();
        let sky_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("sdf-gi gpu sky radiance"),
            contents: bytemuck::cast_slice(&sky_table),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let visibilities = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("sdf-gi gpu visibilities"),
            size: lanes_bytes as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let hit_distances = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("sdf-gi gpu hit distances"),
            size: lanes_bytes as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let records = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("sdf-gi gpu records"),
            contents: bytemuck::cast_slice(&initial_words),
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
        });
        // bake:uniform(参数) + read triangles + write field。
        let (bake_pipeline, bake_bind_group) = {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("sdf bake scene grid"),
                source: wgpu::ShaderSource::Wgsl(DEEP_SDF_BAKE_SCENE_GRID_WGSL.into()),
            });
            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("sdf bake layout"),
                entries: &[
                    uniform_entry(0),
                    storage_entry(1, true),
                    storage_entry(2, false),
                ],
            });
            let pipeline = create_pipeline(
                device,
                "sdf bake pipeline",
                "sdf bake pipeline layout",
                &layout,
                &module,
                SDF_BAKE_SCENE_GRID_ENTRY,
            );
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("sdf bake bindings"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: bake_params.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: triangle_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: field.as_entire_binding(),
                    },
                ],
            });
            (pipeline, bind_group)
        };
        // trace:uniform + read field/positions/directions + write vis/hit。
        let (trace_pipeline, trace_bind_group) = {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("sdf sky visibility trace"),
                source: wgpu::ShaderSource::Wgsl(DEEP_SDF_SKY_VISIBILITY_TRACE_WGSL.into()),
            });
            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("sdf sky trace layout"),
                entries: &[
                    uniform_entry(0),
                    storage_entry(1, true),
                    storage_entry(2, true),
                    storage_entry(3, true),
                    storage_entry(4, false),
                    storage_entry(5, false),
                ],
            });
            let pipeline = create_pipeline(
                device,
                "sdf sky trace pipeline",
                "sdf sky trace pipeline layout",
                &layout,
                &module,
                SDF_SKY_VISIBILITY_ENTRY,
            );
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("sdf sky trace bindings"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: trace_params_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: field.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: position_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: direction_table.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: visibilities.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: hit_distances.as_entire_binding(),
                    },
                ],
            });
            (pipeline, bind_group)
        };
        // update:uniform + read vis/sky/hits + read_write records。
        let (update_pipeline, update_bind_group) = {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("sdf gi probe update"),
                source: wgpu::ShaderSource::Wgsl(DEEP_SDF_GI_PROBE_UPDATE_WGSL.into()),
            });
            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("sdf gi probe update layout"),
                entries: &[
                    uniform_entry(0),
                    storage_entry(1, true),
                    storage_entry(2, true),
                    storage_entry(3, false),
                    storage_entry(4, true),
                ],
            });
            let pipeline = create_pipeline(
                device,
                "sdf gi probe update pipeline",
                "sdf gi probe update pipeline layout",
                &layout,
                &module,
                SDF_GI_PROBE_UPDATE_ENTRY,
            );
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("sdf gi probe update bindings"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: update_params.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: visibilities.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: sky_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: records.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: hit_distances.as_entire_binding(),
                    },
                ],
            });
            (pipeline, bind_group)
        };
        Ok(Self {
            grid_origin: plan.grid_plan.scene_min,
            cell_size: plan.cell_size,
            dimensions: plan.grid_plan.dimensions,
            cells,
            lattice: plan.lattice.clone(),
            directions: plan.directions.clone(),
            trace_config: plan.trace_config,
            content_hash: plan.content_hash,
            probe_count,
            direction_count,
            lanes,
            records_bytes,
            triangle_word_count: triangles.len(),
            bake_pipeline,
            trace_pipeline,
            update_pipeline,
            bake_bind_group,
            trace_bind_group,
            update_bind_group,
            bake_params,
            update_params,
            triangle_buffer,
            field,
            records,
            dispatched_windows: 0,
        })
    }

    /// 记录面初值(storage 物化合同的占位流;真实记录由 init dispatch 算出并
    /// 发布进 probe storage)。
    pub(crate) fn initial_records(&self) -> Vec<IrradianceProbeRecord> {
        pack_initial_sdf_gi_records(self.probe_count, self.trace_config.max_distance)
    }

    pub(crate) fn probe_count(&self) -> usize {
        self.probe_count
    }

    /// lattice 访问(诊断面;网格头构造消费)。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn lattice(&self) -> &SdfGiProbeLattice {
        &self.lattice
    }

    /// 方向集访问(诊断面;CPU 测试与真机编排腿消费)。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn directions(&self) -> &[[f64; 3]] {
        &self.directions
    }

    /// 距离场 buffer 访问(真机编排腿读回做 CPU 镜像重追;生产代码不消费)。
    #[cfg(all(test, target_os = "windows"))]
    pub(crate) fn field_buffer(&self) -> &wgpu::Buffer {
        &self.field
    }

    #[cfg(all(test, target_os = "windows"))]
    pub(crate) fn grid_geometry(&self) -> ([f64; 3], f64, [usize; 3]) {
        (self.grid_origin, self.cell_size, self.dimensions)
    }

    #[cfg(all(test, target_os = "windows"))]
    pub(crate) fn cells_for_test(&self) -> usize {
        self.cells
    }

    /// 已派发窗口数(诊断面;真机编排腿与 CPU 测试消费)。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn dispatched_windows(&self) -> usize {
        self.dispatched_windows
    }

    /// 内容哈希访问(诊断面;真机编排腿消费;rebake 内部直读字段)。
    #[cfg_attr(not(all(test, windows)), allow(dead_code))]
    pub(crate) fn content_hash(&self) -> [u8; 32] {
        self.content_hash
    }

    /// init 全域首追 dispatch:bake → trace 全域 → update 全域 → 记录面发布
    /// (首帧渲染前 submit,opaque 采样读到真实记录)。
    pub(crate) fn submit_initial_dispatch(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        storage_buffer: &wgpu::Buffer,
    ) {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("sdf-gi gpu init dispatch"),
        });
        self.encode_kernels(queue, &mut encoder, 0, self.probe_count as u32, 1.0);
        self.encode_publish(&mut encoder, storage_buffer);
        queue.submit(Some(encoder.finish()));
    }

    /// 帧推进:窗口计划(CPU)→ trace 全域 + update 窗口 → 记录面发布。
    /// 确定性:窗口计划游标单调,每探针每周期恰更新一次;无 RNG。
    pub(crate) fn advance(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        storage_buffer: &wgpu::Buffer,
    ) {
        let (offset, count) = plan_sdf_gi_probe_window(
            self.probe_count,
            SDF_GI_PROBE_WINDOW_BUDGET,
            self.dispatched_windows,
        );
        if count == 0 {
            return;
        }
        self.dispatched_windows += 1;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("sdf-gi gpu frame dispatch"),
        });
        self.encode_kernels(
            queue,
            &mut encoder,
            offset as u32,
            count as u32,
            DEEP_GI_PROBE_TEMPORAL_ALPHA,
        );
        self.encode_publish(&mut encoder, storage_buffer);
        queue.submit(Some(encoder.finish()));
    }

    /// 帧内场景变更评估(publish_render_packet_update 唯一提交点;语义见模块头)。
    pub(crate) fn evaluate_scene_change(
        &mut self,
        plan: &SdfGiGpuPlan,
        sources: &[SdfGiBakeSource],
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        storage_buffer: &wgpu::Buffer,
    ) -> SdfGiRebakeOutcome {
        if plan.content_hash == self.content_hash {
            return SdfGiRebakeOutcome::CacheHit;
        }
        // 原位前提:格几何逐位同(原点/cellSize/分辨率/cells/lattice)。
        let grid_same = plan.grid_plan.scene_min == self.grid_origin
            && plan.cell_size == self.cell_size
            && plan.grid_plan.dimensions == self.dimensions
            && plan.grid_plan.cells == self.cells
            && plan.lattice == self.lattice;
        if !grid_same {
            return SdfGiRebakeOutcome::GridGeometryChanged;
        }
        // 原位重烘焙:三角形表/烘焙参数/记录面重置重上传 → 三核全域 → 发布。
        let triangles = flatten_world_triangles(sources, plan);
        debug_assert_eq!(
            triangles.len(),
            self.triangle_word_count,
            "原位重烘焙前提:三角形字数不变(格几何逐位同)"
        );
        let params = SdfBakeParams {
            dimensions: [
                plan.grid_plan.dimensions[0] as u32,
                plan.grid_plan.dimensions[1] as u32,
                plan.grid_plan.dimensions[2] as u32,
            ],
            triangle_count: (triangles.len() / 20) as u32,
            cell_size: plan.cell_size as f32,
            pad0: [0.0; 3],
            origin: [
                plan.grid_plan.scene_min[0] as f32,
                plan.grid_plan.scene_min[1] as f32,
                plan.grid_plan.scene_min[2] as f32,
            ],
            exterior_distance: plan.grid_plan.exterior_distance,
            cell_count: self.cells as u32,
            pad1: [0.0; 3],
        };
        queue.write_buffer(&self.triangle_buffer, 0, bytemuck::cast_slice(&triangles));
        queue.write_buffer(&self.bake_params, 0, bytemuck::bytes_of(&params));
        queue.write_buffer(
            &self.records,
            0,
            bytemuck::cast_slice(&record_words(&pack_initial_sdf_gi_records(
                self.probe_count,
                self.trace_config.max_distance,
            ))),
        );
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("sdf-gi gpu rebake dispatch"),
        });
        self.encode_kernels(queue, &mut encoder, 0, self.probe_count as u32, 1.0);
        self.encode_publish(&mut encoder, storage_buffer);
        queue.submit(Some(encoder.finish()));
        // dispatched 窗口游标保留(探针数不变,节奏合同不受影响)。
        self.content_hash = plan.content_hash;
        SdfGiRebakeOutcome::Rebaked
    }

    /// 三核 dispatch(bake → trace 全域 → update 窗口;单 pass 内管线切换,
    /// GPU 执行序 = 编码序,写后读合同与 TS 同 encoder 一致)。update 窗口
    /// 参数经 write_buffer 前置于本 encoder 的 submit(队列序合同)。
    fn encode_kernels(
        &self,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        window_offset: u32,
        window_count: u32,
        alpha: f64,
    ) {
        let params = update_params_struct(
            self.probe_count,
            self.direction_count,
            window_offset,
            window_count,
            self.trace_config.max_distance,
            alpha,
        );
        queue.write_buffer(&self.update_params, 0, bytemuck::bytes_of(&params));
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("sdf-gi gpu kernels"),
            ..Default::default()
        });
        pass.set_pipeline(&self.bake_pipeline);
        pass.set_bind_group(0, &self.bake_bind_group, &[]);
        pass.dispatch_workgroups(self.cells.div_ceil(64) as u32, 1, 1);
        pass.set_pipeline(&self.trace_pipeline);
        pass.set_bind_group(0, &self.trace_bind_group, &[]);
        pass.dispatch_workgroups(self.lanes.div_ceil(64) as u32, 1, 1);
        pass.set_pipeline(&self.update_pipeline);
        pass.set_bind_group(0, &self.update_bind_group, &[]);
        pass.dispatch_workgroups(window_count.div_ceil(64), 1, 1);
    }

    /// 发布:records 面复制 → probe storage(偏移 96B 网格头;全 GPU 驻留,
    /// 零读回)。
    fn encode_publish(&self, encoder: &mut wgpu::CommandEncoder, storage_buffer: &wgpu::Buffer) {
        encoder.copy_buffer_to_buffer(
            &self.records,
            0,
            storage_buffer,
            PROBE_GI_RECORD_BYTES as u64,
            self.records_bytes as u64,
        );
    }
}

/// uniform 绑定项(binding 0 惯例)。
fn uniform_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

/// storage 绑定项(read_only 按核签名)。
fn storage_entry(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn create_pipeline<'a>(
    device: &'a wgpu::Device,
    label: &'a str,
    layout_label: &'a str,
    layout: &'a wgpu::BindGroupLayout,
    module: &'a wgpu::ShaderModule,
    entry_point: &'a str,
) -> wgpu::ComputePipeline {
    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(label),
        layout: Some(
            &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(layout_label),
                bind_group_layouts: &[Some(layout)],
                immediate_size: 0,
            }),
        ),
        module,
        entry_point: Some(entry_point),
        compilation_options: Default::default(),
        cache: None,
    })
}

#[cfg(test)]
#[path = "sdf_gi_gpu_tests.rs"]
mod sdf_gi_gpu_tests;
