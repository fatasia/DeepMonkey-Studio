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
//! 格合同/探针 lattice)整体 Reject 回退既有路径,绝不半挂载。
//!
//! == 边界(如实)==
//! - 静态层假设:烘焙在 renderer 生命周期内一次,场景几何变化不触发重烘焙
//!   (TS 有 revision 重烘焙与哈希缓存;native 后继切片);
//! - 探针 lattice/记录数在构建期固定;GPU dispatch(`sdf_gi_wgsl` 三核)与
//!   真机复验为后继切片,本切片全部为 CPU 权威链;
//! - 实例基础几何参与烘焙(LOD 变体不参与);RenderInstance 无动态标志,
//!   一律按静态处理。

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
    SdfSceneBakeOptions, bake_sdf_scene_grid, derive_sdf_gi_probe_lattice, probe_lattice_bounds,
    resolve_sdf_gi_bake_cell_size,
};
use deep_engine_native::sdf_gi_trace::{
    SdfSkyVisibilityTraceConfig, SdfSkyVisibilityTraceOptions, probe_occlusion_direction,
    resolve_sdf_sky_visibility_trace_config, trace_sdf_sky_visibility_with_hits,
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
        }
    }
}

/// 96B 记录 ABI 的 irradiance 上界(probe_gi_abi validate 同值;目标场
/// ≤ 天空辐射,bounce/SSGDI 关闭时钳天空辐射即钳记录)。
const SDF_GI_IRRADIANCE_ABI_LIMIT: f64 = 65_504.0;
/// 96B 记录 ABI 的 meanDistance 上界(probe_gi_abi validate 同值)。
const SDF_GI_DISTANCE_ABI_LIMIT: f64 = 1_000_000.0;

/// 包内烘焙实例源(基础几何,顶点已解包为 xyz 三元组;变换行主 3×3 + 平移)。
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
/// 字段 crate 内可见(renderer 测试域消费)。
pub(crate) struct SdfGiFrameRuntime {
    /// 场景 SDF 距离场(烘焙静态层,驻留 CPU;GPU dispatch 后继切片)。
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
    /// 构建期跳过的实例数(几何缺席;诊断证据链)。
    pub(crate) skipped_instances: usize,
}

/// 构建拒绝原因与 [`SdfSceneBakeError`] 的封闭映射。
fn reject_bake(error: &SdfSceneBakeError) -> SdfGiReject {
    match error {
        SdfSceneBakeError::NoBakeableInstances => SdfGiReject::NoBakeableInstances,
        _ => SdfGiReject::BakeContract,
    }
}

impl SdfGiFrameRuntime {
    /// 静态烘焙 + 探针 lattice + 全域首追 + 记录初值(帧循环前一次)。
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
            grid,
            trace_config,
            directions,
            sky_radiance,
            ssgdi,
            lattice,
            face: result.records_f64,
            dispatched_windows: 0,
            skipped_instances,
        })
    }

    /// 探针记录流初值(record 0 = 网格头,legacy 单层格;探针 = f64 面 ABI 落盘)。
    /// init 经既有级联解码/pack 路径物化为 storage,采样开关由既有 legacy 格
    /// 判定置 2.0。
    pub(crate) fn initial_records(&self) -> Result<Vec<IrradianceProbeRecord>, SdfGiReject> {
        let header = ProbeGiGridHeader {
            origin: [
                self.lattice.positions[0][0] as f32,
                self.lattice.positions[0][1] as f32,
                self.lattice.positions[0][2] as f32,
            ],
            spacing: self.lattice.spacing as f32,
            grid_size: [
                self.lattice.dimensions[0] as u32,
                self.lattice.dimensions[1] as u32,
                self.lattice.dimensions[2] as u32,
            ],
            probe_count: self.lattice.positions.len() as u32,
        };
        let mut records = Vec::with_capacity(1 + self.face.len());
        records.push(
            header
                .encode()
                .map_err(|_| SdfGiReject::ProbeGridContract)?,
        );
        records.extend(self.face.iter().map(record_to_abi));
        Ok(records)
    }

    /// 帧推进:滑动窗口重追 + SH 更新 + storage 窗口重上传。确定性:无 RNG,
    /// 同输入逐位同输出;窗口计划游标单调,每探针每周期恰更新一次。
    pub(crate) fn advance(&mut self, queue: &wgpu::Queue, storage_buffer: &wgpu::Buffer) {
        if let Some((offset, records)) = self.compute_window() {
            // 窗口字节段重上传:存储布局 = [网格头, 探针…],字节偏移 =
            // (1+offset)×96B。write_buffer 前置于其后 submit 的命令缓冲,本帧
            // opaque 采样读到新记录。
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

    /// 窗口计算(纯 CPU;advance 的上传半与此分离供 CPU 测试):返回
    /// `Some((窗口探针偏移, 更新后 ABI 记录))`,预算/计数为零时 None。
    pub(crate) fn compute_window(&mut self) -> Option<(usize, Vec<IrradianceProbeRecord>)> {
        let probe_count = self.face.len();
        let (offset, count) = plan_sdf_gi_probe_window(
            probe_count,
            SDF_GI_PROBE_WINDOW_BUDGET,
            self.dispatched_windows,
        );
        if count == 0 {
            return None;
        }
        self.dispatched_windows += 1;
        let positions = &self.lattice.positions[offset..offset + count];
        let (visibilities, hit_distances) = trace_sdf_sky_visibility_with_hits(
            &self.grid,
            positions,
            &self.directions,
            &self.trace_config,
        );
        let geometry_stats = sdf_gi_probe_geometry_stats(
            &hit_distances,
            self.directions.len(),
            self.trace_config.max_distance,
        );
        let previous: Vec<Option<ProbeShPreviousRecord>> = self.face[offset..offset + count]
            .iter()
            .map(|record| Some(*record))
            .collect();
        let result = update_probe_sh_with_sdf_gi(&ProbeShUpdateInput {
            previous: &previous,
            directions: &self.directions,
            visibilities: &visibilities,
            direction_sky_radiance: &self.sky_radiance,
            ssgdi: &self.ssgdi[offset..offset + count],
            bounce_albedo: None,
            alpha: None,
            geometry_stats: Some(&geometry_stats),
        });
        for (local, record) in result.records_f64.into_iter().enumerate() {
            self.face[offset + local] = record;
        }
        Some((offset, result.records))
    }

    /// 诊断面:探针数/已派发窗口/跳过实例(遥测与验收证据链)。
    pub(crate) fn telemetry(&self) -> (usize, usize, usize) {
        (
            self.face.len(),
            self.dispatched_windows,
            self.skipped_instances,
        )
    }
}

#[cfg(test)]
#[path = "sdf_gi_runtime_tests.rs"]
mod sdf_gi_runtime_tests;
