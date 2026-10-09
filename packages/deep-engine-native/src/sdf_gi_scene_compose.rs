//! Brief-GI native 场景级 SDF 合成与探针 lattice(TS `sdfSceneBakeGrid.ts` 场景级半的
//! Rust 镜像)。几何基元(距离场/三角形基元/逐实例网格)在 [`crate::sdf_gi_scene`],
//! 本模块消费它们完成场景级合成(min 闭体并集)、显式 bounds 解析、cellSize 预解析
//! 与探针 lattice 推导。语义源与对拍纪律见彼处模块头。
use crate::sdf_gi_scene::{
    MAX_SDF_SCENE_BAKE_AXIS, MAX_SDF_SCENE_BAKE_TRIANGLE_SAMPLES, MAX_SDF_SCENE_BAKE_TRIANGLES,
    MAX_SDF_SCENE_CELLS, SdfInstanceDomain, SdfSceneBakeError, SdfSceneBakeInstance,
    SdfSceneBakeInstanceReport, SdfSceneBakeInstanceStatus, SdfSceneBakeReport, SdfSceneGrid,
    bake_instance_grid, compose_instance, derive_dimensions, fround, hypot3,
    transformed_triangle_bounds,
};

/// 场景网格规划半(实例过滤 + bounds 并集 + dimensions + cells 预算 + exterior;
/// CPU 烘焙与 GPU 烘焙链共用的单一实现点,TS `flattenWorldTriangles` 规划段同式)。
/// 不做任何距离计算 —— 距离场由 [`bake_sdf_scene_grid`](CPU)或
/// `sdfBakeSceneGrid.wgsl`(GPU)各自消费本规划产出。
pub struct SdfSceneGridPlan {
    /// 场景格原点(静态实例 bounds 并集 min;显式 bounds 优先)。
    pub scene_min: [f64; 3],
    /// 场景格分辨率(每轴 2..=128)。
    pub dimensions: [usize; 3],
    /// 总 cell 数(≤ [`MAX_SDF_SCENE_CELLS`])。
    pub cells: usize,
    /// 有界外推圈外的场值(米)。
    pub exterior_distance: f32,
    /// 静态实例在输入序中的索引(动态/非法/超三角形预算实例不在此列)。
    pub static_indices: Vec<usize>,
    /// 逐静态实例变换后 AABB(与 static_indices 同序;逐实例烘焙域来源)。
    pub static_bounds: Vec<([f64; 3], [f64; 3])>,
    /// 前置报告行(动态排除/跳过,输入序;烘焙报告的前半)。
    pub pre_reports: Vec<SdfSceneBakeInstanceReport>,
}

/// 场景网格规划(与 [`bake_sdf_scene_grid`] 的前置合同逐式同源;规划失败
/// 封闭映射同款错误)。GPU 烘焙链在 renderer 域消费,不落 CPU 距离场。
pub fn plan_sdf_scene_grid(
    instances: &[SdfSceneBakeInstance<'_>],
    options: SdfSceneBakeOptions,
) -> Result<SdfSceneGridPlan, SdfSceneBakeError> {
    if !options.cell_size.is_finite() || options.cell_size <= 0.0 {
        return Err(SdfSceneBakeError::InvalidCellSize);
    }
    if let Some(dimensions) = options.dimensions
        && dimensions
            .iter()
            .any(|value| !(2..=MAX_SDF_SCENE_BAKE_AXIS).contains(value))
    {
        return Err(SdfSceneBakeError::InvalidDimensions);
    }
    let cell_size = options.cell_size;
    let mut statics: Vec<(usize, [f64; 3], [f64; 3])> = Vec::new();
    let mut pre_reports = Vec::new();
    for (ordinal, instance) in instances.iter().enumerate() {
        let triangles = instance.indices.len() / 3;
        if instance.dynamic {
            pre_reports.push(SdfSceneBakeInstanceReport {
                id: instance.id.to_string(),
                status: SdfSceneBakeInstanceStatus::DynamicExcluded,
                triangles,
                reason: None,
                grid_cells: None,
            });
            continue;
        }
        let invalid = !instance.positions.len().is_multiple_of(3)
            || instance.positions.iter().any(|value| !value.is_finite())
            || instance
                .indices
                .iter()
                .any(|index| *index as usize >= instance.positions.len() / 3)
            || triangles == 0;
        if invalid {
            pre_reports.push(SdfSceneBakeInstanceReport {
                id: instance.id.to_string(),
                status: SdfSceneBakeInstanceStatus::Skipped,
                triangles,
                reason: Some("invalid-geometry".to_string()),
                grid_cells: None,
            });
            continue;
        }
        if triangles > MAX_SDF_SCENE_BAKE_TRIANGLES {
            pre_reports.push(SdfSceneBakeInstanceReport {
                id: instance.id.to_string(),
                status: SdfSceneBakeInstanceStatus::Skipped,
                triangles,
                reason: Some(format!("triangle-budget:{MAX_SDF_SCENE_BAKE_TRIANGLES}")),
                grid_cells: None,
            });
            continue;
        }
        let (bounds_min, bounds_max) = transformed_triangle_bounds(
            instance.positions,
            instance.indices,
            instance.transform.as_ref(),
        );
        statics.push((ordinal, bounds_min, bounds_max));
    }
    if statics.is_empty() {
        return Err(SdfSceneBakeError::NoBakeableInstances);
    }
    let (scene_min, scene_max) = resolve_static_bounds(&statics, options.bounds);
    let dimensions = options
        .dimensions
        .unwrap_or_else(|| derive_dimensions(scene_min, scene_max, cell_size));
    let cells = dimensions[0] * dimensions[1] * dimensions[2];
    if cells > MAX_SDF_SCENE_CELLS {
        return Err(SdfSceneBakeError::CellBudgetExceeded {
            cells,
            budget: MAX_SDF_SCENE_CELLS,
        });
    }
    let exterior_distance = fround(hypot3(
        scene_max[0] - scene_min[0],
        scene_max[1] - scene_min[1],
        scene_max[2] - scene_min[2],
    )) as f32;
    Ok(SdfSceneGridPlan {
        scene_min,
        dimensions,
        cells,
        exterior_distance,
        static_indices: statics.iter().map(|(ordinal, _, _)| *ordinal).collect(),
        static_bounds: statics.iter().map(|(_, min, max)| (*min, *max)).collect(),
        pre_reports,
    })
}

/// 场景级 SDF 烘焙(TS `bakeSdfSceneGrid` 镜像;无缓存子集,见模块头如实声明)。
/// 规划半(实例过滤/bounds/dimensions/cells 预算/exterior)与 GPU 烘焙链共用
/// [`plan_sdf_scene_grid`] 单一实现点;本函数只做距离场计算与合成。
pub fn bake_sdf_scene_grid(
    instances: &[SdfSceneBakeInstance<'_>],
    options: SdfSceneBakeOptions,
) -> Result<(SdfSceneGrid, SdfSceneBakeReport), SdfSceneBakeError> {
    let cell_size = options.cell_size;
    let plan = plan_sdf_scene_grid(instances, options)?;
    let mut reports = plan.pre_reports;
    let excluded = reports
        .iter()
        .filter(|report| report.status == SdfSceneBakeInstanceStatus::DynamicExcluded)
        .count();
    let scene_min = plan.scene_min;
    let dimensions = plan.dimensions;
    let cells = plan.cells;
    let exterior_distance = plan.exterior_distance;
    let mut field = vec![exterior_distance; cells];
    let mut baked = 0usize;
    let mut skipped = reports
        .iter()
        .filter(|report| report.status == SdfSceneBakeInstanceStatus::Skipped)
        .count();
    for (ordinal, (bounds_min, bounds_max)) in plan.static_indices.iter().zip(&plan.static_bounds) {
        let instance = &instances[*ordinal];
        let baked_grid = bake_instance_grid(
            instance.positions,
            instance.indices,
            instance.transform.as_ref(),
            *bounds_min,
            *bounds_max,
            cell_size,
            dimensions,
            scene_min,
            options.instance_domain,
        );
        match baked_grid {
            Ok((local, local_cells)) => {
                baked += 1;
                compose_instance(&mut field, &local, scene_min, dimensions, exterior_distance);
                reports.push(SdfSceneBakeInstanceReport {
                    id: instance.id.to_string(),
                    status: SdfSceneBakeInstanceStatus::Baked,
                    triangles: instance.indices.len() / 3,
                    reason: None,
                    grid_cells: Some(local_cells),
                });
            }
            Err(reason) => {
                skipped += 1;
                reports.push(SdfSceneBakeInstanceReport {
                    id: instance.id.to_string(),
                    status: SdfSceneBakeInstanceStatus::Skipped,
                    triangles: instance.indices.len() / 3,
                    reason: Some(reason),
                    grid_cells: Some(0),
                });
            }
        }
    }
    // TS 收尾 fround 遍历:field 已是 f32 存储,值恒 f32 精确,无操作(合同保留)。
    reports.sort_by(|left, right| left.id.cmp(&right.id));
    Ok((
        SdfSceneGrid {
            origin: scene_min,
            cell_size,
            dimensions,
            distances: field,
        },
        SdfSceneBakeReport {
            instances: reports,
            baked_count: baked,
            // TS 的逐资产哈希缓存状态(native 权威链无缓存,恒 0;见模块头如实差异)。
            cached_count: 0,
            excluded_dynamic_count: excluded,
            skipped_count: skipped,
            dimensions,
            cell_size,
            exterior_distance,
        },
    ))
}

/// 显式场景包围盒(有限、min < max;与 TS `options.bounds` 同义)。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SceneBounds {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

/// 显式 bounds 或静态实例 AABB 并集(TS `resolveSceneBounds` 镜像;条目仅消费
/// bounds 对,实例身份由调用方语义承载)。
fn resolve_static_bounds(
    statics: &[(usize, [f64; 3], [f64; 3])],
    explicit: Option<SceneBounds>,
) -> ([f64; 3], [f64; 3]) {
    if let Some(explicit) = explicit {
        for axis in 0..3 {
            assert!(
                explicit.min[axis].is_finite()
                    && explicit.max[axis].is_finite()
                    && explicit.min[axis] < explicit.max[axis],
                "SDF 场景烘焙显式 bounds 非法(min < max 且全有限)"
            );
        }
        return (explicit.min, explicit.max);
    }
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for (_, entry_min, entry_max) in statics {
        for axis in 0..3 {
            min[axis] = min[axis].min(entry_min[axis]);
            max[axis] = max[axis].max(entry_max[axis]);
        }
    }
    (min, max)
}

/// 烘焙选项(与 TS `SdfSceneBakeOptions` 同构;cellSize 必填 —— TS 由
/// `resolveSdfGiBakeCellSize` 预先解析后传入,native 同约定)。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SdfSceneBakeOptions {
    pub cell_size: f64,
    pub bounds: Option<SceneBounds>,
    pub dimensions: Option<[usize; 3]>,
    pub instance_domain: SdfInstanceDomain,
}

impl Default for SdfSceneBakeOptions {
    fn default() -> Self {
        Self {
            cell_size: 0.0,
            bounds: None,
            dimensions: None,
            instance_domain: SdfInstanceDomain::Aabb,
        }
    }
}

// ===== 探针 lattice(与 TS sdfGiBakePlan.probeLatticeBounds / sdfGiSceneAdapter
// deriveSdfGiProbeLattice / resolveSdfGiBakeCellSize 同构)=====

/// 探针 lattice 采样域:SDF 网格边界内缩半格(贴面探针 SDF=0 → 全向假遮蔽)。
pub fn probe_lattice_bounds(grid: &SdfSceneGrid) -> ([f64; 3], [f64; 3]) {
    probe_lattice_bounds_for(grid.origin, grid.cell_size, grid.dimensions)
}

/// [`probe_lattice_bounds`] 的显式字段形(GPU 烘焙链只持格几何不持 CPU 距离场;
/// 与网格形共用同一 inset 公式,单一实现点)。
pub fn probe_lattice_bounds_for(
    origin: [f64; 3],
    cell_size: f64,
    dimensions: [usize; 3],
) -> ([f64; 3], [f64; 3]) {
    let inset = (cell_size * 0.5).max(1e-3);
    let max = [
        origin[0] + (dimensions[0] as f64 - 1.0) * cell_size,
        origin[1] + (dimensions[1] as f64 - 1.0) * cell_size,
        origin[2] + (dimensions[2] as f64 - 1.0) * cell_size,
    ];
    (
        [origin[0] + inset, origin[1] + inset, origin[2] + inset],
        [max[0] - inset, max[1] - inset, max[2] - inset],
    )
}

/// 实例 AABB 最大边长(TS `instanceMaxExtent` 镜像;烘焙 cellSize 缺省基准)。
pub fn instance_max_extent(instances: &[SdfSceneBakeInstance<'_>]) -> f64 {
    let mut max = 0.0f64;
    for instance in instances {
        for axis in 0..3usize {
            let mut min = f64::INFINITY;
            let mut bound = f64::NEG_INFINITY;
            let mut index = axis;
            while index < instance.positions.len() {
                let value = f64::from(instance.positions[index]);
                min = min.min(value);
                bound = bound.max(value);
                index += 3;
            }
            if min.is_finite() {
                max = max.max(bound - min);
            }
        }
    }
    max
}

/// 烘焙 cellSize 解析(TS `resolveSdfGiBakeCellSize`:场景最长边/64,钳 [0.05,1],
/// 缺省 0.25)。
pub fn resolve_sdf_gi_bake_cell_size(
    instances: &[SdfSceneBakeInstance<'_>],
    cell_size: Option<f64>,
) -> f64 {
    let max_extent = instance_max_extent(instances);
    clamp_finite(
        cell_size,
        0.05,
        1.0,
        clamp_finite(Some(max_extent / 64.0), 0.05, 1.0, 0.25),
    )
}

#[inline]
fn clamp_finite(value: Option<f64>, min: f64, max: f64, fallback: f64) -> f64 {
    match value {
        Some(value) if value.is_finite() => value.clamp(min, max),
        _ => fallback,
    }
}

/// 场景包围盒 → 探针 lattice(均匀格;确定性:分辨率从细到粗首个满足预算的组合,
/// 预算不足按几何均值 ×2 放大 spacing,与 TS 同式)。
pub fn derive_sdf_gi_probe_lattice(
    bounds_min: [f64; 3],
    bounds_max: [f64; 3],
    spacing: f64,
    max_probes: usize,
) -> Result<SdfGiProbeLattice, SdfSceneBakeError> {
    if !spacing.is_finite() || spacing <= 0.0 {
        return Err(SdfSceneBakeError::InvalidCellSize);
    }
    if max_probes < 1 {
        return Err(SdfSceneBakeError::InvalidDimensions);
    }
    let extent = [
        (bounds_max[0] - bounds_min[0]).max(0.0),
        (bounds_max[1] - bounds_min[1]).max(0.0),
        (bounds_max[2] - bounds_min[2]).max(0.0),
    ];
    let mut resolved = spacing;
    for _attempt in 0..64 {
        let dims: Vec<usize> = (0..3)
            .map(|axis| ((extent[axis] / resolved).floor() as usize).max(1) + 1)
            .collect();
        if dims[0] * dims[1] * dims[2] <= max_probes {
            let mut positions = Vec::with_capacity(dims[0] * dims[1] * dims[2]);
            for z in 0..dims[2] {
                for y in 0..dims[1] {
                    for x in 0..dims[0] {
                        positions.push([
                            bounds_min[0] + (x as f64 * resolved).min(extent[0]),
                            bounds_min[1] + (y as f64 * resolved).min(extent[1]),
                            bounds_min[2] + (z as f64 * resolved).min(extent[2]),
                        ]);
                    }
                }
            }
            return Ok(SdfGiProbeLattice {
                positions,
                dimensions: [dims[0], dims[1], dims[2]],
                spacing: resolved,
            });
        }
        resolved *= 2.0;
    }
    Err(SdfSceneBakeError::SampleBudgetExceeded)
}

/// 探针 lattice 结果(与 TS `deriveSdfGiProbeLattice` 返回同构)。
#[derive(Clone, Debug, PartialEq)]
pub struct SdfGiProbeLattice {
    pub positions: Vec<[f64; 3]>,
    pub dimensions: [usize; 3],
    pub spacing: f64,
}

/// cells×triangles 采样预算哨兵(单元测试断言常量绑定不被静默改动)。
pub fn sample_budget_guard(cells: usize, triangles: usize) -> bool {
    cells.saturating_mul(triangles) <= MAX_SDF_SCENE_BAKE_TRIANGLE_SAMPLES
}

#[cfg(test)]
#[path = "sdf_gi_scene_tests.rs"]
mod sdf_gi_scene_tests;
