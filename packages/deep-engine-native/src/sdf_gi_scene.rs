//! Brief-GI native 场景级 SDF 体积烘焙(CPU 权威镜像)。
//!
//! 唯一语义源 = Web `deep-engine/src/gi/sdfSceneBake.ts` + `sdfSceneBakeGrid.ts`
//! + `physics/sdfGrid.ts`(`buildSdfGrid` 核:点到三角形精确距离 + +X 射线奇偶定号)。
//! 本模块把静态资产的世界空间 SDF min 合成(闭体并集)成场景级距离场,产出与
//! Web `SdfGrid` 同构,直供天光圆锥追踪([`crate::sdf_gi_trace`])与 GPU 烘焙核
//! (`wgsl/sdfBakeSceneGrid.wgsl`,经 [`crate::sdf_gi_wgsl`] 消费)对拍。
//!
//! == 浮点镜像纪律(JS number = f64,Math.fround 显式落点)==
//! TS 中间量是 f64、数组是 f32;本镜像逐式同构:标量走 f64,`fround` 落在
//! TS `Math.fround` 的**同一批表达式**上(`transformPoint` 的 4 项链、距离写回、
//! exteriorDistance),数组存取 f32。JS 内建(Math.hypot/ceil/floor)按 IEEE f64
//! 同式实现;跨 libm 的 1 ulp 风险由黄金 fixture 位级对拍实证守护。
//!
//! == 与 TS 的如实差异 ==
//! - TS 的逐资产哈希缓存(`createSdfSceneBakeCache`,命中不重烘)属生产回退路径的
//!   增量优化,不改变烘焙输出语义;native 权威链无缓存,报告状态子集
//!   baked/dynamic-excluded/skipped(cached 状态恒 0)。
//! - `buildSdfGrid` 的 `MAX_CELLS`(262 144)上限定号同源。

// 场景烘焙/追踪/探针更新链的窄特性目标:GPU dispatch 与 renderer 生产接线在
// 后继切片,合同与对拍先行落库,放行 dead_code(与 probe_gi_abi 同一惯例)。
#![allow(dead_code)]

/// 场景网格每轴上限(与 TS buildSdfGrid/sdfSceneBakeGrid 逐轴 ≤128 同源)。
pub const MAX_SDF_SCENE_BAKE_AXIS: usize = 128;
/// 逐 mesh 三角形预算(超出即规模墙,跳过并记录;与 TS 同源)。
pub const MAX_SDF_SCENE_BAKE_TRIANGLES: usize = 16_384;
/// cells×triangles 采样预算(与 TS buildSdfGrid 同源)。
pub const MAX_SDF_SCENE_BAKE_TRIANGLE_SAMPLES: usize = 16_777_216;
/// buildSdfGrid 的场景网格 cells 上限(TS `MAX_CELLS`)。
pub const MAX_SDF_GRID_CELLS: usize = 262_144;
/// 单场景网格级 cells 预算(TS `MAX_SDF_PROFILE_GRID_CELLS` 同值,4096×16384/256)。
pub const MAX_SDF_SCENE_CELLS: usize = 262_144;

/// 3×4 仿射(行主 basis 先乘、后加平移;缺省恒等,与 TS `SdfSceneTransform` 同构)。
#[derive(Clone, Debug, PartialEq)]
pub struct SdfSceneTransform {
    pub basis: [f64; 9],
    pub translation: [f64; 3],
}

impl Default for SdfSceneTransform {
    fn default() -> Self {
        Self {
            basis: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            translation: [0.0; 3],
        }
    }
}

/// 静态烘焙实例(与 TS `SdfSceneBakeInstance` 同构;网格为三角形索引面片)。
pub struct SdfSceneBakeInstance<'a> {
    pub id: &'a str,
    pub positions: &'a [f32],
    pub indices: &'a [u32],
    /// true = 动态资产:排除出场,报告逐条记录。
    pub dynamic: bool,
    pub transform: Option<SdfSceneTransform>,
}

/// 逐资产烘焙域(缺省 aabb;与 TS `instanceDomain` 同义)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SdfInstanceDomain {
    /// 逐资产 AABB ±1 cell;域外 cell 不参与合成(未覆盖空域保持 exteriorDistance)。
    Aabb,
    /// 每资产域覆盖整个场景网格(逐 cell 精确 min 合成)。
    Scene,
}

/// 场景级 SDF 网格(与 TS `SdfGrid` 同构;origin 为 f32 精确值的 f64 承载)。
#[derive(Clone, Debug, PartialEq)]
pub struct SdfSceneGrid {
    pub origin: [f64; 3],
    pub cell_size: f64,
    pub dimensions: [usize; 3],
    /// 米;闭体内部为负、外部为正(TS 同义)。
    pub distances: Vec<f32>,
}

/// 逐实例状态(与 TS `SdfSceneBakeInstanceStatus` 同构)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SdfSceneBakeInstanceStatus {
    Baked,
    Cached,
    DynamicExcluded,
    Skipped,
}

/// 逐实例报告行(与 TS `SdfSceneBakeInstanceReport` 同构)。
#[derive(Clone, Debug, PartialEq)]
pub struct SdfSceneBakeInstanceReport {
    pub id: String,
    pub status: SdfSceneBakeInstanceStatus,
    pub triangles: usize,
    /// skipped 时的机器可读原因(TS 同词汇:invalid-geometry/triangle-budget:N/
    /// grid-extent/sample-budget:N)。
    pub reason: Option<String>,
    pub grid_cells: Option<usize>,
}

/// 烘焙报告(与 TS `SdfSceneBakeReport` 同构)。
#[derive(Clone, Debug, PartialEq)]
pub struct SdfSceneBakeReport {
    /// TS 按实例 id 升序排序。
    pub instances: Vec<SdfSceneBakeInstanceReport>,
    pub baked_count: usize,
    pub cached_count: usize,
    pub excluded_dynamic_count: usize,
    pub skipped_count: usize,
    pub dimensions: [usize; 3],
    pub cell_size: f64,
    /// 有界外推圈外的场值(米;有限正数,场永不含非有限值)。
    pub exterior_distance: f32,
}

/// 烘焙失败(fail-visible;与 TS RangeError 同义的封闭错误)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SdfSceneBakeError {
    /// 分辨率每轴越界 2..=128。
    InvalidDimensions,
    /// cellSize 非有限正数。
    InvalidCellSize,
    /// 显式 bounds 非法(min < max 且全有限)。
    InvalidBounds,
    /// 无可烘焙静态实例(动态/跳过不计)。
    NoBakeableInstances,
    /// 场景网格 cells 超预算。
    CellBudgetExceeded { cells: usize, budget: usize },
    /// 源网格包含退化三角形(buildSdfGrid TypeError)。
    DegenerateTriangle { instance: String },
    /// cells×triangles 超采样预算(重试入口按 TS 语义升 cellSize 重烘)。
    SampleBudgetExceeded,
}

/// JS `Math.fround` 的镜像:f64 → 最近 f32 → 回 f64。
#[inline]
pub(crate) fn fround(value: f64) -> f64 {
    f64::from(value as f32)
}

/// JS `Math.round` 的镜像:半向 +∞(floor+分数比较,避开 x+0.5 的经典边界)。
#[inline]
pub(crate) fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    }
}

/// TS `Math.hypot(x, y, z)` 的镜像(平方和的 f64 sqrt;黄金 fixture 位级对拍
/// 实证守护跨 libm 差异)。
#[inline]
pub(crate) fn hypot3(a: f64, b: f64, c: f64) -> f64 {
    (a * a + b * b + c * c).sqrt()
}

/// TS `transformPoint`:行主 basis 先乘、后加平移,单次 fround 落点。
pub fn transform_point(transform: Option<&SdfSceneTransform>, x: f64, y: f64, z: f64) -> [f64; 3] {
    let Some(transform) = transform else {
        return [x, y, z];
    };
    let b = &transform.basis;
    let t = &transform.translation;
    [
        fround(b[0] * x + b[1] * y + b[2] * z + t[0]),
        fround(b[3] * x + b[4] * y + b[5] * z + t[1]),
        fround(b[6] * x + b[7] * y + b[8] * z + t[2]),
    ]
}

/// 变换后的逐顶点 AABB(TS `transformedTriangleBounds`;min/max 在 f32 精确值上)。
pub fn transformed_triangle_bounds(
    positions: &[f32],
    indices: &[u32],
    transform: Option<&SdfSceneTransform>,
) -> ([f64; 3], [f64; 3]) {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for index in indices {
        let offset = *index as usize * 3;
        let point = transform_point(
            transform,
            f64::from(positions[offset]),
            f64::from(positions[offset + 1]),
            f64::from(positions[offset + 2]),
        );
        for axis in 0..3 {
            min[axis] = min[axis].min(point[axis]);
            max[axis] = max[axis].max(point[axis]);
        }
    }
    (min, max)
}

/// 场景分辨率推导(TS `deriveDimensions`:每轴 ceil(extent/cellSize)+1,钳 2..=128)。
pub fn derive_dimensions(min: [f64; 3], max: [f64; 3], cell_size: f64) -> [usize; 3] {
    let mut dimensions = [0usize; 3];
    for axis in 0..3 {
        let cells = ((max[axis] - min[axis]) / cell_size).ceil() + 1.0;
        dimensions[axis] = cells.clamp(2.0, MAX_SDF_SCENE_BAKE_AXIS as f64) as usize;
    }
    dimensions
}

/// 点到三角形精确距离(TS `physics/sdfGrid.triangleDistance` 逐式镜像;f64)。
/// 顶点/边/面三分支 + 退化三角形报错(与 TS TypeError 同义)。
pub fn triangle_distance(
    p: [f64; 3],
    a: [f64; 3],
    b: [f64; 3],
    c: [f64; 3],
) -> Result<f64, SdfSceneBakeError> {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return Ok(hypot3(ap[0], ap[1], ap[2]));
    }
    let bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return Ok(hypot3(bp[0], bp[1], bp[2]));
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let t = d1 / (d1 - d3);
        return Ok(hypot3(
            ap[0] - ab[0] * t,
            ap[1] - ab[1] * t,
            ap[2] - ab[2] * t,
        ));
    }
    let cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return Ok(hypot3(cp[0], cp[1], cp[2]));
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let t = d2 / (d2 - d6);
        return Ok(hypot3(
            ap[0] - ac[0] * t,
            ap[1] - ac[1] * t,
            ap[2] - ac[2] * t,
        ));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        let bc = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
        let t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return Ok(hypot3(
            bp[0] - bc[0] * t,
            bp[1] - bc[1] * t,
            bp[2] - bc[2] * t,
        ));
    }
    let normal = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    let magnitude = hypot3(normal[0], normal[1], normal[2]);
    if magnitude <= 1e-12 {
        return Err(SdfSceneBakeError::DegenerateTriangle {
            instance: String::new(),
        });
    }
    Ok((dot(ap, normal)).abs() / magnitude)
}

/// +X 射线奇偶定号的交点查询(TS `rayX` 逐式镜像;返回射线参数化交点的 p.x 偏移)。
pub fn ray_x(p: [f64; 3], a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> Option<f64> {
    let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let h = [0.0, -e2[2], e2[1]];
    let det = dot(e1, h);
    if det.abs() < 1e-10 {
        return None;
    }
    let f = 1.0 / det;
    let s = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    let u = f * dot(s, h);
    if !(-1e-8..=1.0 + 1e-8).contains(&u) {
        return None;
    }
    let q = [
        s[1] * e1[2] - s[2] * e1[1],
        s[2] * e1[0] - s[0] * e1[2],
        s[0] * e1[1] - s[1] * e1[0],
    ];
    let v = f * q[0];
    if v < -1e-8 || u + v > 1.0 + 1e-8 {
        return None;
    }
    let t = f * dot(e2, q);
    (t > 1e-8).then(|| p[0] + t)
}

#[inline]
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// `buildSdfGrid` 核(TS `physics/sdfGrid.ts` 逐式镜像):逐 cell 精确最近距离 +
/// 交点排序去重后的奇偶定号,fround 一次写回 f32。
pub fn build_sdf_grid(
    positions: &[f32],
    indices: &[u32],
    origin: [f64; 3],
    cell_size: f64,
    dimensions: [usize; 3],
) -> Result<Vec<f32>, SdfSceneBakeError> {
    let cells = dimensions[0] * dimensions[1] * dimensions[2];
    let triangles = indices.len() / 3;
    if !cell_size.is_finite()
        || cell_size <= 0.0
        || dimensions
            .iter()
            .any(|value| !(2..=MAX_SDF_SCENE_BAKE_AXIS).contains(value))
        || cells > MAX_SDF_GRID_CELLS
    {
        return Err(SdfSceneBakeError::InvalidDimensions);
    }
    if indices.is_empty()
        || !indices.len().is_multiple_of(3)
        || triangles > MAX_SDF_SCENE_BAKE_TRIANGLES
        || cells * triangles > MAX_SDF_SCENE_BAKE_TRIANGLE_SAMPLES
        || !positions.len().is_multiple_of(3)
        || positions.iter().any(|value| !value.is_finite())
        || indices
            .iter()
            .any(|index| *index as usize >= positions.len() / 3)
    {
        return Err(SdfSceneBakeError::InvalidDimensions);
    }
    let triangle = |index: usize| -> [[f64; 3]; 3] {
        let mut corners = [[0.0f64; 3]; 3];
        for (corner, target) in corners.iter_mut().enumerate() {
            let offset = indices[index * 3 + corner] as usize * 3;
            *target = [
                f64::from(positions[offset]),
                f64::from(positions[offset + 1]),
                f64::from(positions[offset + 2]),
            ];
        }
        corners
    };
    // 预展开三角形表(逐 cell 循环内不再重复解码);退化三角形按 TS 语义在
    // triangle_distance 的面分支命中处报错(不前置拒绝 —— TS 接受未触达面分支
    // 的退化三角形)。
    let mut table = Vec::with_capacity(triangles);
    for index in 0..triangles {
        table.push(triangle(index));
    }
    let mut distances = vec![0.0f32; cells];
    for z in 0..dimensions[2] {
        for y in 0..dimensions[1] {
            for x in 0..dimensions[0] {
                let p = [
                    origin[0] + x as f64 * cell_size,
                    origin[1] + y as f64 * cell_size,
                    origin[2] + z as f64 * cell_size,
                ];
                let mut nearest = f64::INFINITY;
                let mut intersections: Vec<f64> = Vec::new();
                for corners in &table {
                    nearest =
                        nearest.min(triangle_distance(p, corners[0], corners[1], corners[2])?);
                    if let Some(hit) = ray_x(p, corners[0], corners[1], corners[2]) {
                        intersections.push(hit);
                    }
                }
                intersections.sort_by(|left, right| left.partial_cmp(right).expect("no NaN"));
                let mut crossings = 0usize;
                let mut previous = f64::NEG_INFINITY;
                for hit in intersections {
                    if hit - previous > 1e-6 * cell_size {
                        crossings += 1;
                    }
                    previous = hit;
                }
                let sign = if crossings % 2 == 1 { -1.0 } else { 1.0 };
                distances[(z * dimensions[1] + y) * dimensions[0] + x] =
                    fround(sign * nearest) as f32;
            }
        }
    }
    Ok(distances)
}

/// 逐资产有界 SDF(世界系,与场景同 cellSize;TS `bakeInstanceGrid` 镜像)。
/// 失败返回 TS 同词汇跳过原因。
#[allow(clippy::too_many_arguments)]
pub fn bake_instance_grid(
    positions: &[f32],
    indices: &[u32],
    transform: Option<&SdfSceneTransform>,
    bounds_min: [f64; 3],
    bounds_max: [f64; 3],
    cell_size: f64,
    scene_dimensions: [usize; 3],
    scene_min: [f64; 3],
    instance_domain: SdfInstanceDomain,
) -> Result<(SdfSceneGrid, usize), String> {
    let scene = instance_domain == SdfInstanceDomain::Scene;
    let pad = if scene { 0.0 } else { cell_size };
    let origin = if scene {
        scene_min
    } else {
        [
            fround(bounds_min[0] - pad),
            fround(bounds_min[1] - pad),
            fround(bounds_min[2] - pad),
        ]
    };
    let dimensions = if scene {
        scene_dimensions
    } else {
        let mut dims = [0usize; 3];
        for axis in 0..3 {
            let cells = ((bounds_max[axis] + pad - origin[axis]) / cell_size).ceil() + 1.0;
            dims[axis] = cells as usize;
        }
        dims
    };
    if dimensions
        .iter()
        .any(|value| *value > MAX_SDF_SCENE_BAKE_AXIS)
    {
        return Err("grid-extent".to_string());
    }
    let cells = dimensions[0] * dimensions[1] * dimensions[2];
    if cells * (indices.len() / 3) > MAX_SDF_SCENE_BAKE_TRIANGLE_SAMPLES {
        return Err(format!(
            "sample-budget:{MAX_SDF_SCENE_BAKE_TRIANGLE_SAMPLES}"
        ));
    }
    // 世界系顶点(transformPoint 逐顶点 fround 落点)。
    let mut world = vec![0.0f32; positions.len()];
    for vertex in 0..positions.len() / 3 {
        let point = transform_point(
            transform,
            f64::from(positions[vertex * 3]),
            f64::from(positions[vertex * 3 + 1]),
            f64::from(positions[vertex * 3 + 2]),
        );
        world[vertex * 3] = point[0] as f32;
        world[vertex * 3 + 1] = point[1] as f32;
        world[vertex * 3 + 2] = point[2] as f32;
    }
    // 逐资产网格经预算前置拦截后仍失败 = 域/规模病态,按 TS 语义上抛。
    let distances = build_sdf_grid(&world, indices, origin, cell_size, dimensions)
        .map_err(|error| format!("bake-error:{error:?}"))?;
    Ok((
        SdfSceneGrid {
            origin,
            cell_size,
            dimensions,
            distances,
        },
        cells,
    ))
}

/// min 合成(闭体并集;TS `composeInstance` 镜像):最近格点查找(round 舍入界),
/// 域外 cell 不贡献,负值钳 −exteriorDistance。
pub fn compose_instance(
    field: &mut [f32],
    local: &SdfSceneGrid,
    scene_min: [f64; 3],
    scene_dimensions: [usize; 3],
    exterior_distance: f32,
) {
    let [nx, ny, nz] = scene_dimensions;
    let [lx, ly, lz] = local.dimensions;
    let cell_size = local.cell_size;
    let floor = f64::from(-exterior_distance);
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let wx = scene_min[0] + x as f64 * cell_size;
                let wy = scene_min[1] + y as f64 * cell_size;
                let wz = scene_min[2] + z as f64 * cell_size;
                let gx = js_round((wx - local.origin[0]) / cell_size);
                let gy = js_round((wy - local.origin[1]) / cell_size);
                let gz = js_round((wz - local.origin[2]) / cell_size);
                if gx < 0.0
                    || gy < 0.0
                    || gz < 0.0
                    || gx > (lx - 1) as f64
                    || gy > (ly - 1) as f64
                    || gz > (lz - 1) as f64
                {
                    continue;
                }
                let value =
                    f64::from(local.distances[(gz as usize * ly + gy as usize) * lx + gx as usize]);
                let index = (z * ny + y) * nx + x;
                let current = f64::from(field[index]);
                field[index] = current.min(value.max(floor)) as f32;
            }
        }
    }
}

/// 场景级 SDF 烘焙(TS `bakeSdfSceneGrid` 镜像;无缓存子集,见模块头如实声明)。
pub fn bake_sdf_scene_grid(
    instances: &[SdfSceneBakeInstance<'_>],
    options: SdfSceneBakeOptions,
) -> Result<(SdfSceneGrid, SdfSceneBakeReport), SdfSceneBakeError> {
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
    let mut reports = Vec::new();
    let mut statics: Vec<(&SdfSceneBakeInstance<'_>, [f64; 3], [f64; 3])> = Vec::new();
    let (mut excluded, mut skipped) = (0usize, 0usize);
    for instance in instances {
        let triangles = instance.indices.len() / 3;
        if instance.dynamic {
            excluded += 1;
            reports.push(SdfSceneBakeInstanceReport {
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
            skipped += 1;
            reports.push(SdfSceneBakeInstanceReport {
                id: instance.id.to_string(),
                status: SdfSceneBakeInstanceStatus::Skipped,
                triangles,
                reason: Some("invalid-geometry".to_string()),
                grid_cells: None,
            });
            continue;
        }
        if triangles > MAX_SDF_SCENE_BAKE_TRIANGLES {
            skipped += 1;
            reports.push(SdfSceneBakeInstanceReport {
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
        statics.push((instance, bounds_min, bounds_max));
    }
    if statics.is_empty() {
        return Err(SdfSceneBakeError::NoBakeableInstances);
    }
    let (scene_min, scene_max) = resolve_scene_bounds(&statics, options.bounds);
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
    let mut field = vec![exterior_distance; cells];
    let (mut baked, mut _cached) = (0usize, 0usize);
    for entry in &statics {
        let (instance, bounds_min, bounds_max) = *entry;
        let baked_grid = bake_instance_grid(
            instance.positions,
            instance.indices,
            instance.transform.as_ref(),
            bounds_min,
            bounds_max,
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
            cached_count: _cached,
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

/// 显式 bounds 或静态实例 AABB 并集(TS `resolveSceneBounds` 镜像)。
fn resolve_scene_bounds(
    statics: &[(&SdfSceneBakeInstance<'_>, [f64; 3], [f64; 3])],
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
    let inset = (grid.cell_size * 0.5).max(1e-3);
    let max = [
        grid.origin[0] + (grid.dimensions[0] as f64 - 1.0) * grid.cell_size,
        grid.origin[1] + (grid.dimensions[1] as f64 - 1.0) * grid.cell_size,
        grid.origin[2] + (grid.dimensions[2] as f64 - 1.0) * grid.cell_size,
    ];
    (
        [
            grid.origin[0] + inset,
            grid.origin[1] + inset,
            grid.origin[2] + inset,
        ],
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
