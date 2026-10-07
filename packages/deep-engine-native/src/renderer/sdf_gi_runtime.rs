//! P1 质量主线:sdf-gi 生产帧接线(烘焙 → 驻留 → 窗口采样)。
//!
//! 把已入库的 CPU 权威镜像链([`deep_engine_native::sdf_gi_scene`] 场景 SDF 烘焙 +
//! [`deep_engine_native::sdf_gi_trace`] 天光圆锥追踪 +
//! [`deep_engine_native::sdf_gi_probe_update`] 探针 SH 更新)接进渲染器:
//! init 一次静态烘焙与全域首追,帧循环按预算滑动窗口重追重混,记录经既有
//! `ProbeGiStorage`(binding 11)重上传,由现役 mesh shader 网格采样消费。
//! 帧合同与 TS `sdfGiProductionRuntime.ts` 同构(烘焙静态层一次 + SH 更新动态层
//! 滑窗分摊 + 天空辐射 = 环境均值),如实差异见模块尾"边界(如实)"。
//!
//! == 门控(fail-closed)==
//! `DEEP_ENGINE_NATIVE_SDF_GI`(缺省 off;`1/on/true/enabled` 开启)。关闭 = 零构造
//! 零帧成本(既有直光种子/空探针路径逐位不变)。开启后任何构建失败(烘焙预算/
//! 格合同/探针 lattice/GPU 资源面)整体 Reject 回退既有路径,绝不半挂载。
//!
//! == 执行腿(2026-10-06 GPU dispatch 生产化)==
//! GPU 设备面就绪(资源创建 + 尺寸护栏 + error scope 干净)→ GPU 三核链
//! ([`SdfGiLeg::Gpu`],烘焙/追踪/更新/发布全 GPU,CPU 只做窗口计划与参数写入,
//! 零 CPU 重追零读回);任何失败 fail-closed 回退 CPU 权威链([`SdfGiLeg::Cpu`],
//! 既有通路原样保留)。帧合同两腿同构:窗口计划同源([`plan_sdf_gi_probe_window`]
//! 同一预算),窗口探针消费当帧天光可见度,每探针每周期恰更新一次;如实差异
//! 见 [`super::sdf_gi_gpu`] 模块头。
//!
//! == 边界(如实)==
//! - CPU 腿静态层假设:烘焙在 renderer 生命周期内一次,场景几何变化不触发重烘焙
//!   (帧内几何更新通道的静态层失效如实维持;TS 有 revision 重烘焙与哈希缓存);
//! - GPU 腿持内容哈希缓存:帧内包更新(publish_render_packet_update 挂点)哈希
//!   命中跳过重烘焙,未命中且格几何不变原位 GPU 重烘焙,格几何变化 fail-closed
//!   维持旧静态层(诊断披露);
//! - 探针 lattice/记录数在构建期固定;实例基础几何参与烘焙(LOD 变体不参与);
//!   RenderInstance 无动态标志,一律按静态处理。

use std::collections::HashMap;

use deep_engine_native::contract::{GeometryResource, RenderPacket};
use deep_engine_native::probe_gi_abi::{IrradianceProbeRecord, PROBE_GI_RECORD_BYTES};
use deep_engine_native::probe_gi_grid::ProbeGiGridHeader;
use deep_engine_native::sdf_gi_probe_update::{
    ProbeShPreviousRecord, ProbeShUpdateInput, plan_sdf_gi_probe_window, record_to_abi,
    sdf_gi_probe_geometry_stats, update_probe_sh_with_sdf_gi,
};
use deep_engine_native::sdf_gi_scene::{
    SdfInstanceDomain, SdfSceneBakeError, SdfSceneBakeInstance, SdfSceneGrid, SdfSceneTransform,
};
use deep_engine_native::sdf_gi_scene_compose::{
    SdfSceneBakeOptions, SdfSceneGridPlan, bake_sdf_scene_grid, derive_sdf_gi_probe_lattice,
    plan_sdf_scene_grid, probe_lattice_bounds, probe_lattice_bounds_for,
    resolve_sdf_gi_bake_cell_size,
};
use deep_engine_native::sdf_gi_trace::{
    SDF_SKY_VISIBILITY_MIN_STEPS, SdfSkyVisibilityTraceConfig, SdfSkyVisibilityTraceOptions,
    default_cone_tan, probe_occlusion_direction, resolve_sdf_sky_visibility_trace_config,
    trace_sdf_sky_visibility_with_hits,
};

/// 门控解析(与 hi_z 同族 env 约定;缺省/未知值 = 关,fail-closed)。
pub(crate) fn sdf_gi_enabled() -> bool {
    parse_sdf_gi_mode(std::env::var("DEEP_ENGINE_NATIVE_SDF_GI").ok().as_deref())
}

fn parse_sdf_gi_mode(value: Option<&str>) -> bool {
    matches!(
        value.map(|raw| raw.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "on" | "true" | "force" | "enabled")
    )
}

/// 每探针方向数(TS 运行时缺省 16 标准档)。
pub(crate) const SDF_GI_DIRECTION_COUNT: u32 = 16;
/// 探针预算上限(TS `maxProbes` 缺省 4096;96B ABI → 384KiB 记录存储)。
pub(crate) const SDF_GI_MAX_PROBES: usize = 4096;
/// 每帧探针更新窗口预算(TS `budgetProbes` 滑窗分摊同族;≤0 视作跳过)。
pub(crate) const SDF_GI_PROBE_WINDOW_BUDGET: f64 = 256.0;

/// 构建拒绝(fail-closed 回退既有路径;原因封闭供诊断)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SdfGiReject {
    /// 包内无可烘焙静态实例(bake NoBakeableInstances)。
    NoBakeableInstances,
    /// 烘焙输入/预算违约(分辨率/cellSize/bounds/退化三角形/采样与 cell 预算)。
    BakeContract,
    /// 探针 lattice 推导失败(预算耗尽/间距非法)。
    ProbeLattice,
    /// 探针 lattice 与 96B 网格头合同不合(单轴 <2 或 >64)。
    ProbeGridContract,
    /// 场景对角线超出探针记录 ABI 距离预算(1e6 m;病理尺度,fail-closed)。
    ProbeExtentExceeded,
    /// 环境漫反射立方体贴图缺席/无有效纹素,天空辐射不可得。
    SkyRadianceMissing,
    /// GPU 链资源超设备上限(三角形表/距离场/lane 切片/记录面任一
    /// 超 max_storage_buffer_binding_size)。fail-closed 回退 CPU 权威链。
    GpuResourceLimit,
    /// GPU 资源创建被设备拒(validation/oom error scope 非空)。
    /// fail-closed 回退 CPU 权威链。
    GpuDeviceRejected,
}

impl SdfGiReject {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::NoBakeableInstances => "native_sdf_gi_no_bakeable_instances",
            Self::BakeContract => "native_sdf_gi_bake_contract_rejected",
            Self::ProbeLattice => "native_sdf_gi_probe_lattice_rejected",
            Self::ProbeGridContract => "native_sdf_gi_probe_grid_contract_rejected",
            Self::ProbeExtentExceeded => "native_sdf_gi_probe_extent_exceeded",
            Self::SkyRadianceMissing => "native_sdf_gi_sky_radiance_missing",
            Self::GpuResourceLimit => "native_sdf_gi_gpu_resource_limit",
            Self::GpuDeviceRejected => "native_sdf_gi_gpu_device_rejected",
        }
    }
}

/// 96B 记录 ABI 的 irradiance 上界(probe_gi_abi validate 同值;目标场
/// ≤ 天空辐射,bounce/SSGDI 关闭时钳天空辐射即钳记录)。
const SDF_GI_IRRADIANCE_ABI_LIMIT: f64 = 65_504.0;
/// 96B 记录 ABI 的 meanDistance 上界(probe_gi_abi validate 同值)。
const SDF_GI_DISTANCE_ABI_LIMIT: f64 = 1_000_000.0;

/// 包内烘焙实例源(基础几何,顶点已解包为 xyz 三元组;变换行主 3×3 + 平移)。
#[derive(Clone)]
pub(crate) struct SdfGiBakeSource {
    pub id: String,
    pub positions: std::sync::Arc<Vec<f32>>,
    pub indices: Vec<u32>,
    pub transform: SdfSceneTransform,
}

/// 包 → 烘焙实例源(几何按 id 去重解包;顶点步长 6 = position.xyz + normal.xyz;
/// 实例变换为列主 4×4,转行主 basis + 平移)。几何缺席的实例跳过并计数。
pub(crate) fn bake_sources_from_packet(packet: &RenderPacket) -> (Vec<SdfGiBakeSource>, usize) {
    let mut cache: HashMap<&str, std::sync::Arc<Vec<f32>>> = HashMap::new();
    let deinterleave = |geometry: &GeometryResource| {
        let vertices = &geometry.vertices;
        let count = geometry.indices.iter().copied().max().unwrap_or(0) as usize + 1;
        let mut positions = Vec::with_capacity(count * 3);
        for vertex in 0..count {
            let offset = vertex * 6;
            positions.extend_from_slice(&vertices[offset..offset + 3]);
        }
        positions
    };
    let mut sources = Vec::new();
    let mut skipped = 0usize;
    for instance in &packet.instances {
        let Some(geometry) = packet.geometries.iter().find(|g| g.id == instance.geometry) else {
            skipped += 1;
            continue;
        };
        // 同几何多实例共享同一份解包顶点(Arc;百实例引用一几何不复制百份)。
        let positions = cache
            .entry(instance.geometry.as_str())
            .or_insert_with(|| std::sync::Arc::new(deinterleave(geometry)))
            .clone();
        let m = &instance.transform;
        sources.push(SdfGiBakeSource {
            id: instance.id.clone(),
            positions,
            indices: geometry.indices.clone(),
            transform: SdfSceneTransform {
                basis: [
                    f64::from(m[0]),
                    f64::from(m[4]),
                    f64::from(m[8]),
                    f64::from(m[1]),
                    f64::from(m[5]),
                    f64::from(m[9]),
                    f64::from(m[2]),
                    f64::from(m[6]),
                    f64::from(m[10]),
                ],
                translation: [f64::from(m[12]), f64::from(m[13]), f64::from(m[14])],
            },
        });
    }
    (sources, skipped)
}

/// 天空辐射 = 漫反射立方体贴图 mip0 全纹素均值(TS 生产合同
/// "环境均值" 同口径;非有限纹素跳过,全无效 = None)。
pub(crate) fn sky_radiance_from_environment(diffuse_mip0: &[[f32; 4]]) -> Option<[f64; 3]> {
    let mut sum = [0.0f64; 3];
    let mut count = 0usize;
    for texel in diffuse_mip0 {
        if texel.iter().all(|value| value.is_finite()) {
            for axis in 0..3 {
                sum[axis] += f64::from(texel[axis]);
            }
            count += 1;
        }
    }
    (count > 0).then(|| {
        [
            sum[0] / count as f64,
            sum[1] / count as f64,
            sum[2] / count as f64,
        ]
    })
}

/// Fibonacci 方向集(TS `directionCount` 缺省 16;CPU 权威生成)。
fn fibonacci_directions(count: u32) -> Vec<[f64; 3]> {
    (0..count)
        .map(|ordinal| probe_occlusion_direction(ordinal, count))
        .collect()
}

/// sdf-gi 帧运行时(门开 + 构建成功才存在;Renderer 独占,不跨设备复用)。
/// 双腿:GPU 设备面就绪走 GPU 三核 dispatch 链,任何构建失败 fail-closed
/// 回退 CPU 权威链(不删;记录流合同两腿同构)。字段 crate 内可见。
pub(crate) struct SdfGiFrameRuntime {
    pub(crate) leg: SdfGiLeg,
    /// 构建期跳过的实例数(几何缺席;诊断证据链)。
    skipped_instances: usize,
}

/// 执行腿(GPU 不可用/构建失败时整体回退 CPU;绝不半挂载)。
pub(crate) enum SdfGiLeg {
    /// CPU 权威链(既有通路:构建期烘焙驻留 + 滑窗重追重混 + write_buffer
    /// 窗口上传)。
    Cpu(SdfGiCpuLeg),
    /// GPU 三核 dispatch 链(烘焙/追踪/更新/发布全 GPU;CPU 只做窗口计划、
    /// uniform 参数写入与内容哈希对比)。
    Gpu(super::sdf_gi_gpu::SdfGiGpuChain),
}

/// CPU 权威腿状态(既有字段面原样保留)。
pub(crate) struct SdfGiCpuLeg {
    /// 场景 SDF 距离场(烘焙静态层,驻留 CPU)。
    pub(crate) grid: SdfSceneGrid,
    trace_config: SdfSkyVisibilityTraceConfig,
    /// Fibonacci 天光方向集(构建期固定)。
    pub(crate) directions: Vec<[f64; 3]>,
    /// 每方向天空辐射(环境均值,renderer 生命周期内恒定)。
    pub(crate) sky_radiance: Vec<[f64; 3]>,
    /// SSGDI 输入占位(当前恒 None;动态直接层后继切片)。
    ssgdi: Vec<Option<[f64; 3]>>,
    /// 探针 lattice(构建期固定)。
    pub(crate) lattice: deep_engine_native::sdf_gi_scene_compose::SdfGiProbeLattice,
    /// f64 链式记录面(TS CPU 链跨帧时域级联同面;窗口读写)。
    pub(crate) face: Vec<ProbeShPreviousRecord>,
    /// 已派发更新窗口数(窗口计划游标)。
    pub(crate) dispatched_windows: usize,
}

/// GPU 腿规划面(构建序与 CPU 腿同源:天空辐射 → 场景规划 → lattice →
/// 格合同 → 方向集 → 追踪配置 → ABI 护栏;不落 CPU 距离场)。
pub(crate) struct SdfGiGpuPlan {
    /// 烘焙 cellSize(与 lattice 间距派生共用)。
    pub(crate) cell_size: f64,
    /// 场景网格规划(plan_sdf_scene_grid 产物;GPU 三角形展平的域来源)。
    pub(crate) grid_plan: SdfSceneGridPlan,
    /// 探针 lattice(构建期固定)。
    pub(crate) lattice: deep_engine_native::sdf_gi_scene_compose::SdfGiProbeLattice,
    /// Fibonacci 方向集。
    pub(crate) directions: Vec<[f64; 3]>,
    /// 每方向天空辐射(钳制后)。
    pub(crate) sky_radiance: Vec<[f64; 3]>,
    /// 追踪配置(射程受 ABI 护栏)。
    pub(crate) trace_config: SdfSkyVisibilityTraceConfig,
    /// 烘焙内容哈希(sdfGiBakeContentHash 语义 native 对齐;重烘焙缓存键)。
    pub(crate) content_hash: [u8; 32],
}

/// GPU 腿共享规划(不触设备;资源创建失败回退时规划结果直接弃置)。
pub(crate) fn plan_sdf_gi_gpu(
    sources: &[SdfGiBakeSource],
    diffuse_mip0: &[[f32; 4]],
) -> Result<SdfGiGpuPlan, SdfGiReject> {
    let sky_rgb =
        sky_radiance_from_environment(diffuse_mip0).ok_or(SdfGiReject::SkyRadianceMissing)?;
    let bake_instances: Vec<SdfSceneBakeInstance<'_>> = sources
        .iter()
        .map(|source| SdfSceneBakeInstance {
            id: &source.id,
            positions: source.positions.as_slice(),
            indices: &source.indices,
            dynamic: false,
            transform: Some(source.transform.clone()),
        })
        .collect();
    let cell_size = resolve_sdf_gi_bake_cell_size(&bake_instances, None);
    let grid_plan = plan_sdf_scene_grid(
        &bake_instances,
        SdfSceneBakeOptions {
            cell_size,
            instance_domain: SdfInstanceDomain::Aabb,
            ..SdfSceneBakeOptions::default()
        },
    )
    .map_err(|error| reject_bake(&error))?;
    // 探针 lattice:与 CPU 腿同式(间距 = max(cellSize×4, 0.25),域 = 网格内缩
    // 半格);GPU 腿只持格几何,走显式字段形(bounds 推导单一实现点)。
    let (bounds_min, bounds_max) = probe_lattice_bounds_for(
        grid_plan.scene_min,
        cell_size,
        grid_plan.dimensions,
    );
    let spacing = (cell_size * 4.0).max(0.25);
    let lattice = derive_sdf_gi_probe_lattice(bounds_min, bounds_max, spacing, SDF_GI_MAX_PROBES)
        .map_err(|_| SdfGiReject::ProbeLattice)?;
    if lattice
        .dimensions
        .iter()
        .any(|size| !(2..=64usize).contains(size))
    {
        return Err(SdfGiReject::ProbeGridContract);
    }
    let directions = fibonacci_directions(SDF_GI_DIRECTION_COUNT);
    // 追踪配置:与 CPU 腿同一 resolve(全缺省档:steps=8、coneTan 缺省、
    // maxDistance=格对角线);GPU 腿只持格几何,距离场视图零长不被读取。
    let trace_config = resolve_sdf_sky_visibility_trace_config(
        &SdfSceneGrid {
            origin: grid_plan.scene_min,
            cell_size,
            dimensions: grid_plan.dimensions,
            distances: Vec::new(),
        },
        SdfSkyVisibilityTraceOptions::default(),
    );
    if trace_config.max_distance > SDF_GI_DISTANCE_ABI_LIMIT {
        return Err(SdfGiReject::ProbeExtentExceeded);
    }
    let sky_rgb = [
        sky_rgb[0].clamp(0.0, SDF_GI_IRRADIANCE_ABI_LIMIT),
        sky_rgb[1].clamp(0.0, SDF_GI_IRRADIANCE_ABI_LIMIT),
        sky_rgb[2].clamp(0.0, SDF_GI_IRRADIANCE_ABI_LIMIT),
    ];
    let sky_radiance = vec![sky_rgb; directions.len()];
    let content_hash = super::sdf_gi_gpu::sdf_gi_bake_content_hash(sources, cell_size);
    Ok(SdfGiGpuPlan {
        cell_size,
        grid_plan,
        lattice,
        directions,
        sky_radiance,
        trace_config,
        content_hash,
    })
}

/// 构建拒绝原因与 [`SdfSceneBakeError`] 的封闭映射。
fn reject_bake(error: &SdfSceneBakeError) -> SdfGiReject {
    match error {
        SdfSceneBakeError::NoBakeableInstances => SdfGiReject::NoBakeableInstances,
        _ => SdfGiReject::BakeContract,
    }
}

/// 帧内重烘焙评估输入(stage 阶段随 Replace 载荷携带;publish 唯一提交点消费)。
pub(crate) enum SdfGiRebakeInput {
    /// 新内容规划成功(哈希/格几何/lattice 就绪;GPU 腿评估用)。
    Ready {
        plan: SdfGiGpuPlan,
        sources: Vec<SdfGiBakeSource>,
        skipped: usize,
    },
    /// 新内容不可烘(同款封闭拒因;GPU 腿维持旧静态层,诊断披露)。
    Rejected(SdfGiReject),
}

impl SdfGiFrameRuntime {
    /// 帧内场景变更评估(GPU 腿:哈希命中跳过 / 原位重烘焙 / 格几何变化
    /// fail-closed 维持旧层;CPU 腿维持静态层假设,如实不动)。
    pub(crate) fn evaluate_scene_change(
        &mut self,
        input: SdfGiRebakeInput,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        storage_buffer: &wgpu::Buffer,
        diagnostics: &mut crate::player_diagnostics::PlayerDiagnostics,
    ) {
        let Some(chain) = self.gpu_chain_mut() else {
            return; // CPU 权威腿:静态层假设照旧(模块头边界,如实)。
        };
        let outcome = match input {
            SdfGiRebakeInput::Ready { plan, sources, .. } => chain.evaluate_scene_change(
                &plan, &sources, device, queue, storage_buffer,
            ),
            SdfGiRebakeInput::Rejected(reject) => {
                diagnostics.note_sdf_gi_rebake(reject.reason());
                return;
            }
        };
        let reason = match outcome {
            super::sdf_gi_gpu::SdfGiRebakeOutcome::CacheHit => "native_sdf_gi_bake_cache_hit",
            super::sdf_gi_gpu::SdfGiRebakeOutcome::Rebaked => "native_sdf_gi_gpu_rebaked",
            super::sdf_gi_gpu::SdfGiRebakeOutcome::GridGeometryChanged => {
                "native_sdf_gi_rebake_grid_changed"
            }
        };
        diagnostics.note_sdf_gi_rebake(reason);
    }
}

impl SdfGiFrameRuntime {
    /// CPU 权威腿构建:静态烘焙 + 探针 lattice + 全域首追 + 记录初值
    /// (帧循环前一次;GPU 腿构建失败 fail-closed 回退到本路径)。
    pub(crate) fn build(
        sources: &[SdfGiBakeSource],
        skipped_instances: usize,
        diffuse_mip0: &[[f32; 4]],
    ) -> Result<Self, SdfGiReject> {
        let sky_rgb =
            sky_radiance_from_environment(diffuse_mip0).ok_or(SdfGiReject::SkyRadianceMissing)?;
        let bake_instances: Vec<SdfSceneBakeInstance<'_>> = sources
            .iter()
            .map(|source| SdfSceneBakeInstance {
                id: &source.id,
                positions: source.positions.as_slice(),
                indices: &source.indices,
                dynamic: false,
                // SdfSceneBakeInstance 持有值语义的变换(镜像 TS 结构),克隆对齐。
                transform: Some(source.transform.clone()),
            })
            .collect();
        let cell_size = resolve_sdf_gi_bake_cell_size(&bake_instances, None);
        let (grid, _report) = bake_sdf_scene_grid(
            &bake_instances,
            SdfSceneBakeOptions {
                cell_size,
                instance_domain: SdfInstanceDomain::Aabb,
                ..SdfSceneBakeOptions::default()
            },
        )
        .map_err(|error| reject_bake(&error))?;
        // 探针 lattice:间距 = max(cellSize×4, 0.25)(TS 缺省同式),域 = 网格
        // 内缩半格(贴面探针假遮蔽,TS probeLatticeBounds 同口径)。
        let (bounds_min, bounds_max) = probe_lattice_bounds(&grid);
        let spacing = (cell_size * 4.0).max(0.25);
        let lattice =
            derive_sdf_gi_probe_lattice(bounds_min, bounds_max, spacing, SDF_GI_MAX_PROBES)
                .map_err(|_| SdfGiReject::ProbeLattice)?;
        // 96B 网格头合同:单轴 2..=64(lattice 越界 = 场景过扁/过长,fail-closed)。
        if lattice
            .dimensions
            .iter()
            .any(|size| !(2..=64usize).contains(size))
        {
            return Err(SdfGiReject::ProbeGridContract);
        }
        let directions = fibonacci_directions(SDF_GI_DIRECTION_COUNT);
        let trace_config =
            resolve_sdf_sky_visibility_trace_config(&grid, SdfSkyVisibilityTraceOptions::default());
        // 记录合同护栏:追踪射程受 ABI 距离预算约束(病理尺度 fail-closed,
        // 不静默缩短射程改语义);天空辐射钳到 irradiance 上界(目标场
        // = mean(vis·sky) ≤ sky,bounce/SSGDI 关闭时即记录上界)。
        if trace_config.max_distance > SDF_GI_DISTANCE_ABI_LIMIT {
            return Err(SdfGiReject::ProbeExtentExceeded);
        }
        let sky_rgb = [
            sky_rgb[0].clamp(0.0, SDF_GI_IRRADIANCE_ABI_LIMIT),
            sky_rgb[1].clamp(0.0, SDF_GI_IRRADIANCE_ABI_LIMIT),
            sky_rgb[2].clamp(0.0, SDF_GI_IRRADIANCE_ABI_LIMIT),
        ];
        let sky_radiance = vec![sky_rgb; directions.len()];
        let ssgdi = vec![None; lattice.positions.len()];
        // 全域首追:探针场首帧即正确(窗口更新自第二帧起滑窗分摊)。
        let (visibilities, hit_distances) = trace_sdf_sky_visibility_with_hits(
            &grid,
            &lattice.positions,
            &directions,
            &trace_config,
        );
        let geometry_stats = sdf_gi_probe_geometry_stats(
            &hit_distances,
            directions.len(),
            trace_config.max_distance,
        );
        let previous = vec![None; lattice.positions.len()];
        let result = update_probe_sh_with_sdf_gi(&ProbeShUpdateInput {
            previous: &previous,
            directions: &directions,
            visibilities: &visibilities,
            direction_sky_radiance: &sky_radiance,
            ssgdi: &ssgdi,
            bounce_albedo: None,
            alpha: None,
            geometry_stats: Some(&geometry_stats),
        });
        Ok(Self {
            leg: SdfGiLeg::Cpu(SdfGiCpuLeg {
                grid,
                trace_config,
                directions,
                sky_radiance,
                ssgdi,
                lattice,
                face: result.records_f64,
                dispatched_windows: 0,
            }),
            skipped_instances,
        })
    }

    /// 记录流初值(两腿分发;init.rs 物化路径的唯一入口)。GPU 腿 = 网格头 +
    /// 烘焙期有界初值(真实记录由 init dispatch 在首帧渲染前算出并发布进
    /// probe storage;本初值只为通过既有 storage 物化合同)。
    pub(crate) fn initial_records(&self) -> Result<Vec<IrradianceProbeRecord>, SdfGiReject> {
        match &self.leg {
            SdfGiLeg::Cpu(leg) => {
                let mut records = Vec::with_capacity(1 + leg.face.len());
                records.push(grid_header_record(&leg.lattice)?);
                records.extend(leg.face.iter().map(record_to_abi));
                Ok(records)
            }
            SdfGiLeg::Gpu(chain) => {
                let mut records = Vec::with_capacity(1 + chain.probe_count());
                records.push(grid_header_record(chain.lattice())?);
                records.extend(chain.initial_records());
                Ok(records)
            }
        }
    }

    /// 探针 lattice 访问(诊断/测试面;两腿同合同)。
    pub(crate) fn lattice(&self) -> &deep_engine_native::sdf_gi_scene_compose::SdfGiProbeLattice {
        match &self.leg {
            SdfGiLeg::Cpu(leg) => &leg.lattice,
            SdfGiLeg::Gpu(chain) => chain.lattice(),
        }
    }

    /// 天光方向集访问(诊断/测试面)。
    pub(crate) fn directions(&self) -> &[[f64; 3]] {
        match &self.leg {
            SdfGiLeg::Cpu(leg) => &leg.directions,
            SdfGiLeg::Gpu(chain) => chain.directions(),
        }
    }

    /// 探针数(lattice 总格数;两腿同合同)。
    pub(crate) fn probe_count(&self) -> usize {
        match &self.leg {
            SdfGiLeg::Cpu(leg) => leg.lattice.positions.len(),
            SdfGiLeg::Gpu(chain) => chain.probe_count(),
        }
    }

    /// 帧推进:GPU 腿 = 窗口计划 + 三核 dispatch + 记录面 copy 发布(零 CPU
    /// 重追零读回);CPU 腿 = 滑窗重追 + SH 更新 + write_buffer 窗口重上传。
    /// 确定性:无 RNG,同输入逐位同输出;窗口计划游标单调,每探针每周期恰
    /// 更新一次。write/copy 前置于其后 submit 的命令缓冲,本帧 opaque 采样
    /// 读到新记录。
    pub(crate) fn advance(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        storage_buffer: &wgpu::Buffer,
    ) {
        match &mut self.leg {
            SdfGiLeg::Cpu(leg) => {
                if let Some((offset, records)) = compute_cpu_window(leg) {
                    let mut bytes = Vec::with_capacity(records.len() * PROBE_GI_RECORD_BYTES);
                    for record in &records {
                        bytes.extend_from_slice(bytemuck::bytes_of(record));
                    }
                    queue.write_buffer(
                        storage_buffer,
                        (1 + offset) as u64 * PROBE_GI_RECORD_BYTES as u64,
                        &bytes,
                    );
                }
            }
            SdfGiLeg::Gpu(chain) => chain.advance(device, queue, storage_buffer),
        }
    }

    /// 窗口计算(CPU 权威腿;GPU 腿恒 None —— 窗口在 GPU advance 内编码)。
    /// 返回 `Some((窗口探针偏移, 更新后 ABI 记录))`,预算/计数为零时 None。
    pub(crate) fn compute_window(&mut self) -> Option<(usize, Vec<IrradianceProbeRecord>)> {
        match &mut self.leg {
            SdfGiLeg::Cpu(leg) => compute_cpu_window(leg),
            SdfGiLeg::Gpu(_) => None,
        }
    }

    /// 诊断面:探针数/已派发窗口/跳过实例(遥测与验收证据链)。
    pub(crate) fn telemetry(&self) -> (usize, usize, usize) {
        (
            self.probe_count(),
            match &self.leg {
                SdfGiLeg::Cpu(leg) => leg.dispatched_windows,
                SdfGiLeg::Gpu(chain) => chain.dispatched_windows(),
            },
            self.skipped_instances,
        )
    }

    /// GPU 腿访问(rebake 评估挂点;CPU 腿 None)。
    pub(crate) fn gpu_chain_mut(&mut self) -> Option<&mut super::sdf_gi_gpu::SdfGiGpuChain> {
        match &mut self.leg {
            SdfGiLeg::Cpu(_) => None,
            SdfGiLeg::Gpu(chain) => Some(chain),
        }
    }

    /// 执行腿是否 GPU(stagerebake 输入构造的门;CPU 腿不评估)。
    pub(crate) fn is_gpu(&self) -> bool {
        matches!(self.leg, SdfGiLeg::Gpu(_))
    }

    /// GPU 腿构建(资源创建由调用方包 error scope 后调
    /// [`super::sdf_gi_gpu::SdfGiGpuChain::create`])。此处只产出规划面 +
    /// storage 初值记录(共享规划单点,失败拒因与 CPU 腿同款封闭映射)。
    pub(crate) fn plan_gpu(
        sources: &[SdfGiBakeSource],
        diffuse_mip0: &[[f32; 4]],
    ) -> Result<SdfGiGpuPlan, SdfGiReject> {
        plan_sdf_gi_gpu(sources, diffuse_mip0)
    }

    /// 组装 GPU 腿运行时(chain 已就绪;skipped 计数与 CPU 腿同口径)。
    pub(crate) fn from_gpu_chain(chain: super::sdf_gi_gpu::SdfGiGpuChain, skipped_instances: usize) -> Self {
        Self {
            leg: SdfGiLeg::Gpu(chain),
            skipped_instances,
        }
    }
}

/// 96B 网格头记录(legacy 单层格;origin = lattice 首探针,间距/尺寸同 lattice)。
fn grid_header_record(
    lattice: &deep_engine_native::sdf_gi_scene_compose::SdfGiProbeLattice,
) -> Result<IrradianceProbeRecord, SdfGiReject> {
    let header = ProbeGiGridHeader {
        origin: [
            lattice.positions[0][0] as f32,
            lattice.positions[0][1] as f32,
            lattice.positions[0][2] as f32,
        ],
        spacing: lattice.spacing as f32,
        grid_size: [
            lattice.dimensions[0] as u32,
            lattice.dimensions[1] as u32,
            lattice.dimensions[2] as u32,
        ],
        probe_count: lattice.positions.len() as u32,
    };
    header.encode().map_err(|_| SdfGiReject::ProbeGridContract)
}

/// CPU 权威腿的窗口计算(原 SdfGiFrameRuntime::compute_window 体;滑动窗口
/// 重追 + SH 更新,f64 链式面跨帧级联)。
fn compute_cpu_window(leg: &mut SdfGiCpuLeg) -> Option<(usize, Vec<IrradianceProbeRecord>)> {
    let probe_count = leg.face.len();
    let (offset, count) = plan_sdf_gi_probe_window(
        probe_count,
        SDF_GI_PROBE_WINDOW_BUDGET,
        leg.dispatched_windows,
    );
    if count == 0 {
        return None;
    }
    leg.dispatched_windows += 1;
    let positions = &leg.lattice.positions[offset..offset + count];
    let (visibilities, hit_distances) = trace_sdf_sky_visibility_with_hits(
        &leg.grid,
        positions,
        &leg.directions,
        &leg.trace_config,
    );
    let geometry_stats = sdf_gi_probe_geometry_stats(
        &hit_distances,
        leg.directions.len(),
        leg.trace_config.max_distance,
    );
    let previous: Vec<Option<ProbeShPreviousRecord>> = leg.face[offset..offset + count]
        .iter()
        .map(|record| Some(*record))
        .collect();
    let result = update_probe_sh_with_sdf_gi(&ProbeShUpdateInput {
        previous: &previous,
        directions: &leg.directions,
        visibilities: &visibilities,
        direction_sky_radiance: &leg.sky_radiance,
        ssgdi: &leg.ssgdi[offset..offset + count],
        bounce_albedo: None,
        alpha: None,
        geometry_stats: Some(&geometry_stats),
    });
    for (local, record) in result.records_f64.into_iter().enumerate() {
        leg.face[offset + local] = record;
    }
    Some((offset, result.records))
}

#[cfg(test)]
#[path = "sdf_gi_runtime_tests.rs"]
mod sdf_gi_runtime_tests;
