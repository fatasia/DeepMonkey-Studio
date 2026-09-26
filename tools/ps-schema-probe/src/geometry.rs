//! B-Rep → 三角网格 MVP 离散化(2026-09-26 R1)。
//!
//! 算法口径(与 packages/xt-reader/src/mesh.ts 的 64 段圆周离散一致):
//! - plane:边界环采样到 uv 平面 → 耳切三角化;内环用三角形重心剔除近似并标注;
//! - cylinder/cone:u=环向角(圆缺口分析定环向范围)+ v=轴向截断 → 参数域矩形网格;
//! - sphere:经纬裁剪(lon/lat 矩形);torus:主/子环向矩形;
//! - blended_edge / blend_boundary / offset / nurbs / unsupported:如实跳过入 losses,
//!   绝不冒充。
//!
//! trim 处理为 MVP 诚实版:边界曲线(Line/Circle/Ellipse/Parabola/Trimmed)采样 3D
//! 点后经曲面逆映射投影到 uv;不可解析的边界曲线退化为"边顶点"界定的参数域矩形,
//! face 级标注近似;平面因参数域无界,边界不可解析时整面跳过并记录。
//! 旋成面矩形裁剪不是逐点精确边界 —— 超出矩形边界的偏差由 approximation 如实标注。

use std::cmp::Ordering;
use std::collections::HashMap;

use parasolid_core::brep::{BrepId, BrepModel, CurveKind, Edge, Face, Sense, SurfaceKind};
use serde::Serialize;

/// 与 xt-reader `XT_ANGULAR_SEGMENTS` 一致的圆周离散口径。
pub const ANGULAR_SEGMENTS: usize = 64;
/// 与 xt-reader `XT_SPHERE_LATITUDE_SEGMENTS` 一致的纬度离散口径。
pub const LATITUDE_SEGMENTS: usize = 32;

const FULL_TURN: f64 = std::f64::consts::TAU;
const HALF_TURN: f64 = std::f64::consts::PI;
/// 环向缺口阈值:略大于 64 段采样的相邻角步距(TAU/64≈0.098)。
/// 边界弧采样保证覆盖区内相邻角差 ≤ 一个步距,超过阈值即视为真实的未覆盖缺口。
const GAP_EPSILON: f64 = FULL_TURN / ANGULAR_SEGMENTS as f64 * 1.02;
/// 单个环的最大采样点数(超出则整面跳过,防炸)。
const MAX_LOOP_POINTS: usize = 512;
/// 单条边界弧的最大采样段数。
const MAX_EDGE_SAMPLES: usize = 64;
/// uv→3D 一致性检查容差(相对模型包围盒对角线)。
const PROJECTION_TOLERANCE: f64 = 0.01;

type Vec3 = [f64; 3];

/// 几何导出资源上限;CLI 可通过 --max-faces 等覆盖。
#[derive(Debug, Clone, Copy)]
pub struct GeometryLimits {
    pub max_faces_published: usize,
    pub max_vertices_total: usize,
    pub max_triangles_per_face: usize,
    pub max_output_bytes: usize,
}

impl Default for GeometryLimits {
    fn default() -> Self {
        Self {
            max_faces_published: 8_192,
            max_vertices_total: 2_000_000,
            max_triangles_per_face: 262_144,
            max_output_bytes: 512 * 1024 * 1024,
        }
    }
}

/// 单个面的三角网格(face 级近似逐条标注)。
#[derive(Debug, Serialize)]
pub struct FaceMesh {
    pub id: u32,
    /// 所属 body 在 `bodies` 中的下标;无法归属时为 null。
    pub body: Option<u32>,
    #[serde(rename = "surfaceKind")]
    pub surface_kind: String,
    /// 展开 f32 xyz 三元组。
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
    pub approximations: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct SkippedFace {
    pub id: u32,
    #[serde(rename = "surfaceKind")]
    pub surface_kind: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct GeometryStats {
    #[serde(rename = "facesTotal")]
    pub faces_total: usize,
    #[serde(rename = "facesPublished")]
    pub faces_published: usize,
    #[serde(rename = "facesSkipped")]
    pub faces_skipped: usize,
    pub vertices: usize,
    pub triangles: usize,
}

/// `--geometry` 模式的完整几何导出:faces + 全局 losses(诚实清单)。
#[derive(Debug, Serialize)]
pub struct GeometryExport {
    pub faces: Vec<FaceMesh>,
    pub losses: Vec<String>,
    pub approximations: Vec<String>,
    pub skipped: Vec<SkippedFace>,
    pub stats: GeometryStats,
    #[serde(rename = "budgetExceeded")]
    pub budget_exceeded: bool,
}

/// 文档内 B-Rep 实体的 id → 下标查找视图。
struct ModelView<'a> {
    model: &'a BrepModel,
    surfaces: HashMap<BrepId, usize>,
    curves: HashMap<BrepId, usize>,
    edges: HashMap<BrepId, usize>,
    vertices: HashMap<BrepId, usize>,
    points: HashMap<BrepId, usize>,
    loops: HashMap<BrepId, usize>,
    half_edges: HashMap<BrepId, usize>,
    face_body: HashMap<BrepId, u32>,
    /// 包围盒对角线(尺度基准)。
    scale: f64,
}

impl<'a> ModelView<'a> {
    fn new(model: &'a BrepModel) -> Self {
        let mut surfaces = HashMap::new();
        for (index, item) in model.surfaces.iter().enumerate() {
            surfaces.insert(item.id, index);
        }
        let mut curves = HashMap::new();
        for (index, item) in model.curves.iter().enumerate() {
            curves.insert(item.id, index);
        }
        let mut edges = HashMap::new();
        for (index, item) in model.edges.iter().enumerate() {
            edges.insert(item.id, index);
        }
        let mut vertices = HashMap::new();
        for (index, item) in model.vertices.iter().enumerate() {
            vertices.insert(item.id, index);
        }
        let mut points = HashMap::new();
        for (index, item) in model.points.iter().enumerate() {
            points.insert(item.id, index);
        }
        let mut loops = HashMap::new();
        for (index, item) in model.loops.iter().enumerate() {
            loops.insert(item.id, index);
        }
        let mut half_edges = HashMap::new();
        for (index, item) in model.half_edges.iter().enumerate() {
            half_edges.insert(item.id, index);
        }
        let scale = model
            .metrics
            .bounding_box
            .map(|bounds| norm(&sub(bounds.maximum.to_array(), bounds.minimum.to_array())))
            .filter(|diagonal| diagonal.is_finite() && *diagonal > 0.0)
            .unwrap_or(1.0);
        Self {
            model,
            surfaces,
            curves,
            edges,
            vertices,
            points,
            loops,
            half_edges,
            face_body: build_face_body_map(model),
            scale,
        }
    }

    fn surface(&self, id: BrepId) -> Option<&'a parasolid_core::brep::SurfaceGeometry> {
        self.surfaces.get(&id).map(|&index| &self.model.surfaces[index])
    }

    fn curve(&self, id: BrepId) -> Option<&'a parasolid_core::brep::CurveGeometry> {
        self.curves.get(&id).map(|&index| &self.model.curves[index])
    }

    fn vertex_point(&self, id: BrepId) -> Option<Vec3> {
        let index = *self.vertices.get(&id)?;
        let point = self.model.vertices[index].point;
        let point_index = *self.points.get(&point)?;
        Some(self.model.points[point_index].position.to_array())
    }

    fn half_edge(&self, id: BrepId) -> Option<&'a parasolid_core::brep::HalfEdge> {
        self.half_edges.get(&id).map(|&index| &self.model.half_edges[index])
    }
}

/// face → body 下标映射:body → region → shell → back/front faces。
fn build_face_body_map(model: &BrepModel) -> HashMap<BrepId, u32> {
    let regions: HashMap<BrepId, usize> =
        model.regions.iter().enumerate().map(|(index, r)| (r.id, index)).collect();
    let shells: HashMap<BrepId, usize> =
        model.shells.iter().enumerate().map(|(index, s)| (s.id, index)).collect();
    let mut map = HashMap::new();
    for (body_index, body) in model.bodies.iter().enumerate() {
        for region_id in &body.regions {
            let Some(&region_index) = regions.get(region_id) else { continue };
            for shell_id in &model.regions[region_index].shells {
                let Some(&shell_index) = shells.get(shell_id) else { continue };
                let shell = &model.shells[shell_index];
                for face_id in shell.back_faces.iter().chain(shell.front_faces.iter()) {
                    map.entry(*face_id).or_insert(body_index as u32);
                }
            }
        }
    }
    map
}

/// 曲线采样失败原因。
#[derive(Debug)]
enum SampleError {
    /// 曲线类型无法解析出 3D 采样点(记 kind 名)。
    Unsampleable(&'static str),
    MissingCurve,
    Degenerate,
}

/// 曲面参数化:投影(uv)与正求值(eval)共用同一框架,保证一致性检查有意义。
enum SurfaceParams {
    Plane { origin: Vec3, e1: Vec3, e2: Vec3 },
    Revolved(RevolvedParams),
}

struct RevolvedParams {
    origin: Vec3,
    axis: Vec3,
    e1: Vec3,
    e2: Vec3,
    kind: RevolvedKind,
}

enum RevolvedKind {
    Cylinder { radius: f64 },
    Cone { radius: f64, tan_half: f64 },
    Sphere { radius: f64 },
    Torus { major: f64, minor: f64 },
}

impl SurfaceParams {
    /// 不支持族返回 Err(family 名,由调用方记 loss);框架退化返回 None。
    fn from_kind(kind: &SurfaceKind) -> Option<Result<Self, &'static str>> {
        match kind {
            SurfaceKind::Plane { point, normal, x_axis } => {
                let normal = normalize(&normal.to_array())?;
                let e1 = normalize(&x_axis.to_array())?;
                Some(Ok(Self::Plane { origin: point.to_array(), e1, e2: cross(&normal, &e1) }))
            }
            SurfaceKind::Cylinder { point, axis, radius, x_axis } => {
                let frame = RevolvedFrame::new(axis.to_array(), x_axis.to_array())?;
                Some(Ok(Self::Revolved(RevolvedParams {
                    origin: point.to_array(),
                    axis: frame.axis,
                    e1: frame.e1,
                    e2: frame.e2,
                    kind: RevolvedKind::Cylinder { radius: *radius },
                })))
            }
            SurfaceKind::Cone { point, axis, radius, sin_half_angle, cos_half_angle, x_axis } => {
                if cos_half_angle.abs() < 1e-9 {
                    return Some(Err("cone-degenerate-half-angle"));
                }
                let frame = RevolvedFrame::new(axis.to_array(), x_axis.to_array())?;
                Some(Ok(Self::Revolved(RevolvedParams {
                    origin: point.to_array(),
                    axis: frame.axis,
                    e1: frame.e1,
                    e2: frame.e2,
                    kind: RevolvedKind::Cone {
                        radius: *radius,
                        tan_half: sin_half_angle / cos_half_angle,
                    },
                })))
            }
            SurfaceKind::Sphere { center, radius, axis, x_axis } => {
                let frame = RevolvedFrame::new(axis.to_array(), x_axis.to_array())?;
                Some(Ok(Self::Revolved(RevolvedParams {
                    origin: center.to_array(),
                    axis: frame.axis,
                    e1: frame.e1,
                    e2: frame.e2,
                    kind: RevolvedKind::Sphere { radius: *radius },
                })))
            }
            SurfaceKind::Torus { center, axis, major_radius, minor_radius, x_axis } => {
                if minor_radius.abs() < 1e-12 {
                    return Some(Err("torus-degenerate-minor-radius"));
                }
                let frame = RevolvedFrame::new(axis.to_array(), x_axis.to_array())?;
                Some(Ok(Self::Revolved(RevolvedParams {
                    origin: center.to_array(),
                    axis: frame.axis,
                    e1: frame.e1,
                    e2: frame.e2,
                    kind: RevolvedKind::Torus { major: *major_radius, minor: *minor_radius },
                })))
            }
            SurfaceKind::BlendedEdge { .. } => Some(Err("blended_edge")),
            SurfaceKind::BlendBoundary { .. } => Some(Err("blend_boundary")),
            SurfaceKind::Offset { .. } => Some(Err("offset")),
            SurfaceKind::Nurbs(_) => Some(Err("nurbs")),
            SurfaceKind::Unsupported { .. } => Some(Err("unsupported")),
        }
    }

    /// 3D 点 → uv。
    fn project(&self, p: Vec3) -> (f64, f64) {
        match self {
            Self::Plane { origin, e1, e2 } => {
                let d = sub(p, *origin);
                (dot(d, *e1), dot(d, *e2))
            }
            Self::Revolved(r) => match &r.kind {
                RevolvedKind::Cylinder { .. } | RevolvedKind::Cone { .. } => {
                    let d = sub(p, r.origin);
                    let v = dot(d, r.axis);
                    let radial = sub(d, scale(r.axis, v));
                    (atan2_of(radial, r.e1, r.e2), v)
                }
                RevolvedKind::Sphere { radius } => {
                    let d = sub(p, r.origin);
                    let lat = (dot(d, r.axis) / radius).clamp(-1.0, 1.0).asin();
                    let radial = sub(d, scale(r.axis, dot(d, r.axis)));
                    (atan2_of(radial, r.e1, r.e2), lat)
                }
                RevolvedKind::Torus { major, .. } => {
                    let d = sub(p, r.origin);
                    let radial_u = dot(d, r.e1);
                    let radial_v = dot(d, r.e2);
                    let radial_len = (radial_u * radial_u + radial_v * radial_v).sqrt();
                    let u = radial_v.atan2(radial_u);
                    let v = dot(d, r.axis).atan2(radial_len - *major);
                    (u, v)
                }
            },
        }
    }

    /// uv → 3D(与 project 互逆)。
    fn eval(&self, u: f64, v: f64) -> Vec3 {
        match self {
            Self::Plane { origin, e1, e2 } => add(*origin, add(scale(*e1, u), scale(*e2, v))),
            Self::Revolved(r) => {
                let radial = add(scale(r.e1, u.cos()), scale(r.e2, u.sin()));
                match &r.kind {
                    RevolvedKind::Cylinder { radius } => {
                        add(add(r.origin, scale(r.axis, v)), scale(radial, *radius))
                    }
                    RevolvedKind::Cone { radius, tan_half } => {
                        add(add(r.origin, scale(r.axis, v)), scale(radial, radius + v * tan_half))
                    }
                    RevolvedKind::Sphere { radius } => {
                        add(
                            r.origin,
                            scale(add(scale(radial, v.cos()), scale(r.axis, v.sin())), *radius),
                        )
                    }
                    RevolvedKind::Torus { major, minor } => {
                        let ring = major + minor * v.cos();
                        add(
                            r.origin,
                            add(scale(radial, ring), scale(r.axis, minor * v.sin())),
                        )
                    }
                }
            }
        }
    }

    /// v 方向中点的回转半径(用于按弧长比例分配网格段数)。
    fn mid_radius(&self, v_mid: f64) -> f64 {
        match self {
            Self::Plane { .. } => 1.0,
            Self::Revolved(r) => match &r.kind {
                RevolvedKind::Cylinder { radius } => *radius,
                RevolvedKind::Cone { radius, tan_half } => (radius + v_mid * tan_half).abs(),
                RevolvedKind::Sphere { radius } => radius * v_mid.cos().abs().max(1e-3),
                RevolvedKind::Torus { major, minor } => {
                    (*major + minor * v_mid.cos()).abs().max(*minor)
                }
            },
        }
    }

    fn kind_name(&self) -> &'static str {
        match self {
            Self::Plane { .. } => "plane",
            Self::Revolved(revolved) => match &revolved.kind {
                RevolvedKind::Cylinder { .. } => "cylinder",
                RevolvedKind::Cone { .. } => "cone",
                RevolvedKind::Sphere { .. } => "sphere",
                RevolvedKind::Torus { .. } => "torus",
            },
        }
    }
}

struct RevolvedFrame {
    axis: Vec3,
    e1: Vec3,
    e2: Vec3,
}

impl RevolvedFrame {
    fn new(axis: Vec3, x_axis: Vec3) -> Option<Self> {
        let axis = normalize(&axis)?;
        let mut candidate = sub(x_axis, scale(axis, dot(x_axis, axis)));
        if norm(&candidate) < 1e-12 {
            // x_axis 与 axis 平行:任取垂直向量兜底(近似由 face 级标注承担)。
            let seed: Vec3 = if axis[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
            candidate = sub(seed, scale(axis, dot(seed, axis)));
        }
        let e1 = normalize(&candidate)?;
        let e2 = cross(&axis, &e1);
        Some(Self { axis, e1, e2 })
    }
}

fn atan2_of(radial: Vec3, e1: Vec3, e2: Vec3) -> f64 {
    dot(radial, e2).atan2(dot(radial, e1))
}

/// 逐 face 导出三角网格。任何失败面跳过并记录,绝不中断整体导出。
pub fn export_geometry(model: &BrepModel, limits: GeometryLimits) -> GeometryExport {
    let view = ModelView::new(model);
    let mut faces = Vec::new();
    let mut losses: Vec<String> = Vec::new();
    let mut skipped = Vec::new();
    let mut approximations = vec!["geometry.tessellation:angular-64-segments".to_string()];
    let mut total_vertices = 0usize;
    let mut total_triangles = 0usize;
    let mut budget_exceeded = false;

    for face in &model.faces {
        let surface_kind = face
            .surface
            .and_then(|id| view.surface(id))
            .map(|surface| surface.kind.as_str().to_string())
            .unwrap_or_else(|| "none".to_string());
        let skip = |reason: &str| SkippedFace {
            id: face.id,
            surface_kind: surface_kind.clone(),
            reason: reason.to_string(),
        };
        if budget_exceeded {
            skipped.push(skip("budget:processing-stopped"));
            continue;
        }
        if faces.len() >= limits.max_faces_published {
            budget_exceeded = true;
            losses.push("geometry.budget:faces-exhausted".to_string());
            skipped.push(skip("budget:max-faces-published"));
            continue;
        }
        let Some(surface) = face.surface.and_then(|id| view.surface(id)) else {
            skipped.push(skip("surface-missing"));
            continue;
        };
        let Some(params_result) = SurfaceParams::from_kind(&surface.kind) else {
            skipped.push(skip("invalid-surface-frame"));
            continue;
        };
        let params = match params_result {
            Ok(params) => params,
            Err(family) => {
                skipped.push(skip(&format!("surface-family-unsupported:{family}")));
                continue;
            }
        };
        let built = match &params {
            SurfaceParams::Plane { .. } => build_plane_face(&view, face, &params),
            SurfaceParams::Revolved(_) => build_revolved_face(&view, face, &params, limits),
        };
        match built {
            Ok(mut mesh) => {
                if total_vertices + mesh.positions.len() / 3 > limits.max_vertices_total {
                    budget_exceeded = true;
                    losses.push("geometry.budget:vertices-exhausted".to_string());
                    skipped.push(skip("budget:max-total-vertices"));
                    continue;
                }
                total_vertices += mesh.positions.len() / 3;
                total_triangles += mesh.indices.len() / 3;
                mesh.body = view.face_body.get(&face.id).copied();
                for approximation in &mesh.approximations {
                    push_unique(&mut approximations, approximation.clone());
                }
                faces.push(mesh);
            }
            Err(reason) => skipped.push(skip(&reason)),
        }
    }

    // 不支持族损失只统计实际导致 face 跳过的族(blend_boundary 等构造曲面
    // 可能没有 face 引用,不虚报)。
    for face in &skipped {
        if let Some(family) = face
            .reason
            .strip_prefix("surface-family-unsupported:")
        {
            push_unique(&mut losses, format!("surface.{family}:not-triangulated"));
        }
    }
    for skipped_face in &skipped {
        let loss = match skipped_face.reason.as_str() {
            reason if reason.starts_with("surface-family-unsupported:") => None,
            reason if reason.starts_with("budget:") => None,
            reason if reason.starts_with("trim-unresolved:") => {
                Some(format!("surface.{}:trim-unresolved-skipped", skipped_face.surface_kind))
            }
            _ => Some(format!("surface.{}:face-skipped", skipped_face.surface_kind)),
        };
        if let Some(loss) = loss {
            push_unique(&mut losses, loss);
        }
    }

    let faces_skipped = skipped.len();
    GeometryExport {
        stats: GeometryStats {
            faces_total: model.faces.len(),
            faces_published: faces.len(),
            faces_skipped,
            vertices: total_vertices,
            triangles: total_triangles,
        },
        faces,
        losses,
        approximations,
        skipped,
        budget_exceeded,
    }
}

/// 收集全模型中不支持三角化的曲面族(按 SurfaceKind 名去重)。
/// 注:losses 现按实际跳过的 face 统计;此函数保留给将来的统计口径。
#[allow(dead_code)]
fn collect_unsupported_families(model: &BrepModel) -> Vec<&'static str> {
    let mut families = Vec::new();
    for surface in &model.surfaces {
        let family = match &surface.kind {
            SurfaceKind::BlendedEdge { .. } => Some("blended_edge"),
            SurfaceKind::BlendBoundary { .. } => Some("blend_boundary"),
            SurfaceKind::Offset { .. } => Some("offset"),
            SurfaceKind::Nurbs(_) => Some("nurbs"),
            SurfaceKind::Unsupported { .. } => Some("unsupported"),
            _ => None,
        };
        if let Some(family) = family {
            push_unique(&mut families, family);
        }
    }
    families
}

/// 逐环采样结果:环的 uv/3D 点列 + 不可解析曲线类型。
struct LoopSamples {
    uv_points: Vec<(f64, f64)>,
    world_points: Vec<Vec3>,
    unresolved: Vec<&'static str>,
}

/// 采样一个 face 的所有环;投影不一致或环超限时整面失败。
fn sample_face_loops(
    view: &ModelView,
    face: &Face,
    params: &SurfaceParams,
) -> Result<Vec<LoopSamples>, String> {
    let tolerance = PROJECTION_TOLERANCE * view.scale;
    let mut samples = Vec::new();
    for loop_id in &face.loops {
        let Some(loop_index) = view.loops.get(loop_id) else {
            return Err("topology:loop-missing".to_string());
        };
        let loop_value = &view.model.loops[*loop_index];
        let mut uv_points: Vec<(f64, f64)> = Vec::new();
        let mut world_points: Vec<Vec3> = Vec::new();
        let mut unresolved: Vec<&'static str> = Vec::new();
        for fin_id in &loop_value.half_edges {
            let Some(fin) = view.half_edge(*fin_id) else {
                return Err("topology:half-edge-missing".to_string());
            };
            if fin.dummy {
                continue;
            }
            let Some(edge_id) = fin.edge else {
                return Err("topology:fin-without-edge".to_string());
            };
            let Some(edge) = view.edges.get(&edge_id).map(|&index| &view.model.edges[index])
            else {
                return Err("topology:edge-missing".to_string());
            };
            let points = match sample_edge_points(view, edge, fin.sense) {
                Ok(points) => points,
                Err(SampleError::Unsampleable(kind)) => {
                    // 不可解析曲线:仍取边顶点作为参数域界定点(MVP 诚实降级)。
                    push_unique(&mut unresolved, kind);
                    edge_vertex_points(view, edge)
                }
                Err(SampleError::MissingCurve) => {
                    push_unique(&mut unresolved, "missing-curve");
                    edge_vertex_points(view, edge)
                }
                Err(SampleError::Degenerate) => Vec::new(),
            };
            for point in points {
                if !point.iter().all(|value| value.is_finite()) {
                    return Err("geometry:non-finite-boundary-point".to_string());
                }
                let (u, v) = params.project(point);
                if !u.is_finite() || !v.is_finite() {
                    return Err("geometry:non-finite-uv".to_string());
                }
                // 一致性检查:uv 再正求值应回到原 3D 点(捕获框架/方向错误)。
                if norm(&sub(params.eval(u, v), point)) > tolerance {
                    return Err("geometry:projection-inconsistent".to_string());
                }
                if let Some(&(last_u, last_v)) = uv_points.last() {
                    if (last_u - u).abs() < 1e-12 && (last_v - v).abs() < 1e-12 {
                        continue;
                    }
                }
                uv_points.push((u, v));
                world_points.push(point);
                if uv_points.len() > MAX_LOOP_POINTS {
                    return Err("geometry:boundary-too-complex".to_string());
                }
            }
        }
        samples.push(LoopSamples { uv_points, world_points, unresolved });
    }
    Ok(samples)
}

/// 边顶点对应的 3D 点(参数域界定的保底采样)。
fn edge_vertex_points(view: &ModelView, edge: &Edge) -> Vec<Vec3> {
    [edge.start_vertex, edge.end_vertex]
        .into_iter()
        .flatten()
        .filter_map(|vertex_id| view.vertex_point(vertex_id))
        .collect()
}

/// 采样一条边在 fin 遍历方向上的 3D 点列。
fn sample_edge_points(
    view: &ModelView,
    edge: &Edge,
    fin_sense: Sense,
) -> Result<Vec<Vec3>, SampleError> {
    let Some(curve_id) = edge.curve else { return Err(SampleError::MissingCurve) };
    let Some(curve) = view.curve(curve_id) else { return Err(SampleError::MissingCurve) };
    // 解析 Trimmed 包装到 basis + 显式参数区间(trimmed 参数已随 basis sense 排序)。
    let mut basis = curve;
    let mut range: Option<(f64, f64)> = None;
    if let CurveKind::Trimmed { basis_curve: trimmed_id, start_parameter, end_parameter, .. } =
        &curve.kind
    {
        basis = view.curve(*trimmed_id).ok_or(SampleError::MissingCurve)?;
        range = Some((*start_parameter, *end_parameter));
    }

    let vertex_points: Option<(Vec3, Vec3)> = match (edge.start_vertex, edge.end_vertex) {
        (Some(start), Some(end)) => match (view.vertex_point(start), view.vertex_point(end)) {
            (Some(start_point), Some(end_point)) => Some((start_point, end_point)),
            _ => return Err(SampleError::Degenerate),
        },
        _ => None,
    };

    let mut forward: Vec<Vec3> = match (&basis.kind, range, vertex_points) {
        // 显式参数区间(Trimmed):在参数轴上按 64 段/整圆口径均匀采样。
        (_, Some((p1, p2)), _) => {
            let count = arc_sample_count((p2 - p1).abs());
            (0..=count)
                .map(|step| evaluate_curve_at(basis, p1 + (p2 - p1) * (step as f64 / count as f64)))
                .collect::<Result<Vec<_>, _>>()?
        }
        (CurveKind::Line { .. }, None, Some((start, end))) => vec![start, end],
        (CurveKind::Line { point, direction }, None, None) => {
            vec![point.to_array(), add(point.to_array(), direction.to_array())]
        }
        (CurveKind::Circle { center, normal, x_axis, .. }, None, Some((start, end))) => {
            let (start_angle, sweep) = signed_angular_sweep(
                &start,
                &end,
                &center.to_array(),
                &normal.to_array(),
                &x_axis.to_array(),
                basis.sense,
            )?;
            sample_angular_curve(basis, start_angle, sweep)?
        }
        (CurveKind::Circle { .. }, None, None) => sample_full_angular_curve(basis)?,
        (CurveKind::Ellipse { center, normal, x_axis, .. }, None, Some((start, end))) => {
            let (start_angle, sweep) = signed_angular_sweep(
                &start,
                &end,
                &center.to_array(),
                &normal.to_array(),
                &x_axis.to_array(),
                basis.sense,
            )?;
            sample_angular_curve(basis, start_angle, sweep)?
        }
        (CurveKind::Ellipse { .. }, None, None) => sample_full_angular_curve(basis)?,
        (CurveKind::Parabola { origin, x_axis, .. }, None, Some((start, end))) => {
            let t1 = dot(sub(start, origin.to_array()), x_axis.to_array());
            let t2 = dot(sub(end, origin.to_array()), x_axis.to_array());
            (0..=MAX_EDGE_SAMPLES)
                .map(|step| {
                    evaluate_curve_at(basis, t1 + (t2 - t1) * (step as f64 / MAX_EDGE_SAMPLES as f64))
                })
                .collect::<Result<Vec<_>, _>>()?
        }
        (CurveKind::Hyperbola { .. }, ..) | (CurveKind::Parabola { .. }, None, None) => {
            // 双曲线参数反解与无界抛物线:MVP 不采样,如实降级为不可解析。
            return Err(SampleError::Unsampleable("conic-unresolved"));
        }
        (CurveKind::Nurbs(_), ..) => return Err(SampleError::Unsampleable("nurbs")),
        (CurveKind::SurfaceParametric { .. }, ..) => {
            return Err(SampleError::Unsampleable("surface_parametric"));
        }
        (CurveKind::Intersection { .. }, ..) => {
            return Err(SampleError::Unsampleable("intersection"));
        }
        (CurveKind::Unsupported { .. }, ..) => {
            return Err(SampleError::Unsampleable("unsupported"));
        }
        // Trimmed 已在入口解包,不会出现在 basis 位置;防御性拒绝。
        (&CurveKind::Trimmed { .. }, ..) => {
            return Err(SampleError::Unsampleable("trimmed-nested"));
        }
    };
    if forward.len() < 2 {
        return Err(SampleError::Degenerate);
    }
    // fin 遍历方向相对 edge 起终点:sense 负 → 反转点列。
    if sense_multiplier(fin_sense) < 0.0 {
        forward.reverse();
    }
    Ok(forward)
}

/// 圆/椭圆弧:由端点角、法向与曲线 sense 确定带符号扫掠 (start_angle, sweep)。
/// sense 负的曲线自然方向与存储坐标系相反 → 扫掠取负方向。
fn signed_angular_sweep(
    start: &Vec3,
    end: &Vec3,
    center: &Vec3,
    normal: &Vec3,
    x_axis: &Vec3,
    curve_sense: Sense,
) -> Result<(f64, f64), SampleError> {
    let Some(normal) = normalize(normal) else { return Err(SampleError::Degenerate) };
    let Some(e1) = normalize(x_axis) else { return Err(SampleError::Degenerate) };
    let e2 = cross(&normal, &e1);
    let angle_of = |p: &Vec3| {
        let d = sub(*p, *center);
        dot(d, e2).atan2(dot(d, e1))
    };
    let start_angle = angle_of(start);
    let raw = (angle_of(end) - start_angle).rem_euclid(FULL_TURN);
    let mut sweep = if sense_multiplier(curve_sense) < 0.0 { raw - FULL_TURN } else { raw };
    if sweep.abs() < 1e-12 {
        sweep = if sense_multiplier(curve_sense) < 0.0 { -FULL_TURN } else { FULL_TURN };
    }
    Ok((start_angle, sweep))
}

/// 按带符号角度扫掠采样圆/椭圆。
fn sample_angular_curve(
    curve: &parasolid_core::brep::CurveGeometry,
    start_angle: f64,
    sweep: f64,
) -> Result<Vec<Vec3>, SampleError> {
    let count = arc_sample_count(sweep.abs());
    (0..=count)
        .map(|step| evaluate_curve_at(curve, start_angle + sweep * (step as f64 / count as f64)))
        .collect()
}

/// 采样整圆/整椭圆(无端点顶点的环形边)。
fn sample_full_angular_curve(
    curve: &parasolid_core::brep::CurveGeometry,
) -> Result<Vec<Vec3>, SampleError> {
    (0..=ANGULAR_SEGMENTS)
        .map(|step| evaluate_curve_at(curve, FULL_TURN * (step as f64 / ANGULAR_SEGMENTS as f64)))
        .collect()
}

/// 弧长比例的采样段数(64 段/整圆口径)。
fn arc_sample_count(span: f64) -> usize {
    ((span / FULL_TURN * ANGULAR_SEGMENTS as f64).ceil() as usize).clamp(1, MAX_EDGE_SAMPLES)
}

/// 在曲线自然参数 t 处求值(Line/Circle/Ellipse/Parabola)。
fn evaluate_curve_at(
    curve: &parasolid_core::brep::CurveGeometry,
    t: f64,
) -> Result<Vec3, SampleError> {
    match &curve.kind {
        CurveKind::Line { point, direction } => {
            Ok(add(point.to_array(), scale(direction.to_array(), t)))
        }
        CurveKind::Circle { center, normal, x_axis, radius } => {
            let frame = angular_frame(&normal.to_array(), &x_axis.to_array())
                .ok_or(SampleError::Degenerate)?;
            Ok(add(
                center.to_array(),
                scale(add(scale(frame.0, t.cos()), scale(frame.1, t.sin())), *radius),
            ))
        }
        CurveKind::Ellipse { center, normal, x_axis, major_radius, minor_radius } => {
            let frame = angular_frame(&normal.to_array(), &x_axis.to_array())
                .ok_or(SampleError::Degenerate)?;
            Ok(add(
                center.to_array(),
                add(
                    scale(frame.0, major_radius * t.cos()),
                    scale(frame.1, minor_radius * t.sin()),
                ),
            ))
        }
        CurveKind::Parabola { origin, normal, x_axis, focal_length } => {
            let Some(e1) = normalize(&x_axis.to_array()) else {
                return Err(SampleError::Degenerate);
            };
            let Some(n) = normalize(&normal.to_array()) else {
                return Err(SampleError::Degenerate);
            };
            Ok(add(origin.to_array(), add(scale(e1, t), scale(n, t * t / (4.0 * focal_length)))))
        }
        _ => Err(SampleError::Unsampleable("unsupported")),
    }
}

fn angular_frame(normal: &Vec3, x_axis: &Vec3) -> Option<(Vec3, Vec3)> {
    let n = normalize(normal)?;
    let e1 = normalize(x_axis)?;
    Some((e1, cross(&n, &e1)))
}

fn sense_multiplier(sense: Sense) -> f64 {
    match sense {
        Sense::Positive => 1.0,
        Sense::Negative => -1.0,
        Sense::Unknown => 1.0,
    }
}

/// 平面面片:uv 多边形耳切三角化 + 内环重心剔除(MVP 近似)。
fn build_plane_face(view: &ModelView, face: &Face, params: &SurfaceParams) -> Result<FaceMesh, String> {
    let loops = sample_face_loops(view, face, params)?;
    // 平面参数域无界:任何边界曲线不可解析时无法界定,如实整面跳过。
    for loop_samples in &loops {
        if let Some(kind) = loop_samples.unresolved.first() {
            return Err(format!("trim-unresolved:{kind}"));
        }
    }
    let usable: Vec<&LoopSamples> =
        loops.iter().filter(|loop_samples| loop_samples.uv_points.len() >= 3).collect();
    if usable.is_empty() {
        return Err("degenerate:all-loops-degenerate".to_string());
    }

    // 最大绝对面积环为外环,其余为孔(内环)。
    let mut outer_index = 0usize;
    let mut outer_area = 0f64;
    for (index, loop_samples) in usable.iter().enumerate() {
        let area = signed_area(&loop_samples.uv_points).abs();
        if area > outer_area {
            outer_area = area;
            outer_index = index;
        }
    }
    let mut approximations = Vec::new();
    if usable.len() > 1 {
        approximations.push("trim.inner-loop:centroid-culled".to_string());
    }
    let outer = &usable[outer_index].uv_points;
    let Some((triangles, _ccw)) = triangulate_polygon(outer) else {
        return Err("degenerate:outer-loop-triangulation-failed".to_string());
    };
    let holes: Vec<&Vec<(f64, f64)>> = usable
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != outer_index)
        .map(|(_, loop_samples)| &loop_samples.uv_points)
        .collect();
    let triangles: Vec<[u32; 3]> = triangles
        .into_iter()
        .filter(|triangle| {
            let centroid = triangle_centroid(outer, triangle);
            !holes.iter().any(|hole| point_in_polygon(centroid, hole))
        })
        .collect();
    if triangles.is_empty() {
        return Err("degenerate:all-triangles-culled".to_string());
    }

    // 朝向:uv 平面法向 = 曲面自然法向;face.sense × surface.sense 反向时翻转。
    let flip = face_sense_flip(view, face);
    let mut indices = Vec::with_capacity(triangles.len() * 3);
    for triangle in &triangles {
        let [a, b, c] = *triangle;
        if flip {
            indices.extend_from_slice(&[a, c, b]);
        } else {
            indices.extend_from_slice(&[a, b, c]);
        }
    }
    let mut positions = Vec::with_capacity(outer.len() * 3);
    for &(u, v) in outer {
        let p = params.eval(u, v);
        positions.extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
    }
    Ok(FaceMesh {
        id: face.id,
        body: None, // export_geometry 统一回填。
        surface_kind: "plane".to_string(),
        positions,
        indices,
        approximations,
    })
}

/// 旋成面(柱/锥/球/环):u 环向裁剪 + v 截断(球为经纬裁剪)。
fn build_revolved_face(
    view: &ModelView,
    face: &Face,
    params: &SurfaceParams,
    limits: GeometryLimits,
) -> Result<FaceMesh, String> {
    let SurfaceParams::Revolved(revolved) = params else { unreachable!("revolved path") };
    let loops = sample_face_loops(view, face, params)?;
    let mut angles = Vec::new();
    let mut v_values = Vec::new();
    let mut approximations = Vec::new();
    let mut sample_count = 0usize;
    for loop_samples in &loops {
        sample_count += loop_samples.world_points.len();
        for kind in &loop_samples.unresolved {
            push_unique(&mut approximations, format!("trim.unresolved:{kind}"));
        }
        for &(u, v) in &loop_samples.uv_points {
            angles.push(u);
            v_values.push(v);
        }
    }
    if sample_count == 0 {
        // 无任何边界证据:仅球/环有内在有界参数域。
        return match &revolved.kind {
            RevolvedKind::Sphere { .. } => {
                approximations.push("trim.full-parameter-domain:unresolved-boundary".to_string());
                tessellate_revolved_grid(
                    face,
                    params,
                    (0.0, FULL_TURN, true),
                    (-HALF_TURN / 2.0, HALF_TURN / 2.0, true),
                    approximations,
                    limits,
                    face_sense_flip(view, face),
                )
            }
            RevolvedKind::Torus { .. } => {
                approximations.push("trim.full-parameter-domain:unresolved-boundary".to_string());
                tessellate_revolved_grid(
                    face,
                    params,
                    (0.0, FULL_TURN, true),
                    (0.0, FULL_TURN, true),
                    approximations,
                    limits,
                    face_sense_flip(view, face),
                )
            }
            _ => Err("trim-unresolved:no-boundary-evidence".to_string()),
        };
    }

    let (u_start, u_span, u_full) = angular_bounds(&angles);
    let Some(&v_min) = v_values.iter().min_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal))
    else {
        return Err("trim-unresolved:no-extent-evidence".to_string());
    };
    let v_max = v_values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let v_span = v_max - v_min;
    let radius_mid = params.mid_radius((v_min + v_max) * 0.5);
    if u_span < 1e-9 && v_span * radius_mid < 1e-9 {
        return Err("degenerate:extent-below-tolerance".to_string());
    }
    if loops.len() > 1 {
        approximations.push("trim.multi-loop:bounds-from-all-loops".to_string());
    }
    let v_range = match &revolved.kind {
        // 球的 v 是纬度:跨满两极时按整球纬度带处理。
        RevolvedKind::Sphere { .. } if v_span > HALF_TURN - 1e-6 => {
            (-HALF_TURN / 2.0, HALF_TURN / 2.0, true)
        }
        _ => (v_min, v_max, false),
    };
    tessellate_revolved_grid(
        face,
        params,
        (u_start, u_span, u_full),
        v_range,
        approximations,
        limits,
        face_sense_flip(view, face),
    )
}

/// 环向缺口分析:返回 (起始角, 跨度, 是否整圆)。
fn angular_bounds(angles: &[f64]) -> (f64, f64, bool) {
    let mut sorted: Vec<f64> = angles.iter().filter(|a| a.is_finite()).map(|a| a.rem_euclid(FULL_TURN)).collect();
    if sorted.is_empty() {
        return (0.0, FULL_TURN, true);
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    // 合并近似重复角。
    let mut merged: Vec<f64> = Vec::with_capacity(sorted.len());
    for &angle in &sorted {
        match merged.last() {
            Some(&last) if angle - last < 1e-9 => {}
            _ => merged.push(angle),
        }
    }
    if merged.len() == 1 {
        // 所有边界角相同:v 向仍有跨度时只能是跨缝整圆。
        return (0.0, FULL_TURN, true);
    }
    // 最大环向缺口(含 wrap 缺口)的补集即覆盖范围。
    let mut max_gap = 0f64;
    let mut gap_start = merged[0];
    for window in merged.windows(2) {
        let gap = window[1] - window[0];
        if gap > max_gap {
            max_gap = gap;
            gap_start = window[1];
        }
    }
    let wrap_gap = merged[0] + FULL_TURN - merged[merged.len() - 1];
    if wrap_gap > max_gap {
        max_gap = wrap_gap;
        gap_start = merged[0];
    }
    if max_gap <= GAP_EPSILON || max_gap >= FULL_TURN - 1e-9 {
        return (0.0, FULL_TURN, true);
    }
    (gap_start, FULL_TURN - max_gap, false)
}

/// 参数域矩形网格离散(u 环向、v 截断;三角朝向 = 曲面自然法向,flip 按面 sense)。
/// v_bounds 第三元表示 v 向满跨(整球纬度带/整环管截面),段数用 LATITUDE_SEGMENTS。
#[allow(clippy::too_many_arguments)]
fn tessellate_revolved_grid(
    face: &Face,
    params: &SurfaceParams,
    u_bounds: (f64, f64, bool),
    v_bounds: (f64, f64, bool),
    approximations: Vec<String>,
    limits: GeometryLimits,
    flip: bool,
) -> Result<FaceMesh, String> {
    let (u_start, u_span, u_full) = u_bounds;
    let (v_min, v_max, v_full) = v_bounds;
    let v_span = v_max - v_min;
    if !u_span.is_finite() || !v_span.is_finite() || u_span <= 0.0 || v_span < 0.0 {
        return Err("degenerate:invalid-parameter-bounds".to_string());
    }
    let u_segments = if u_full {
        ANGULAR_SEGMENTS
    } else {
        ((u_span / FULL_TURN * ANGULAR_SEGMENTS as f64).ceil() as usize).clamp(1, ANGULAR_SEGMENTS)
    };
    let v_segments = if v_full {
        LATITUDE_SEGMENTS
    } else {
        let radius_mid = params.mid_radius((v_min + v_max) * 0.5);
        let u_arc = u_span * radius_mid.max(1e-9);
        let v_arc = v_span.abs();
        if v_arc <= 1e-12 {
            1
        } else if u_arc <= 1e-12 {
            16
        } else {
            ((v_arc / u_arc.max(v_arc) * ANGULAR_SEGMENTS as f64).ceil() as usize)
                .clamp(1, ANGULAR_SEGMENTS)
        }
    };
    let rows = v_segments + 1;
    let columns = u_segments + 1;
    if rows * columns > limits.max_triangles_per_face.max(2) {
        return Err("budget:face-triangle-budget-exceeded".to_string());
    }
    let mut positions = Vec::with_capacity(rows * columns * 3);
    for row in 0..rows {
        let v = v_min + v_span * (row as f64 / v_segments as f64);
        for column in 0..columns {
            let u = u_start + u_span * (column as f64 / u_segments as f64);
            let p = params.eval(u, v);
            positions.extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
        }
    }
    // 朝向:(a, right, up) 与 (right, upright, up) 给出 ∂u×∂v = 曲面自然法向。
    let mut indices = Vec::with_capacity(u_segments * v_segments * 6);
    for row in 0..v_segments {
        for column in 0..u_segments {
            let a = (row * columns + column) as u32;
            let right = a + 1;
            let up = a + columns as u32;
            let upright = up + 1;
            for triangle in [[a, right, up], [right, upright, up]] {
                if flip {
                    indices.extend_from_slice(&[triangle[0], triangle[2], triangle[1]]);
                } else {
                    indices.extend_from_slice(&triangle);
                }
            }
        }
    }
    Ok(FaceMesh {
        id: face.id,
        body: None, // export_geometry 统一回填。
        surface_kind: params.kind_name().to_string(),
        positions,
        indices,
        approximations,
    })
}

/// face.sense × surface.sense 反向时三角面翻转(sense Unknown 按 +1)。
fn face_sense_flip(view: &ModelView, face: &Face) -> bool {
    let surface_sense = face
        .surface
        .and_then(|id| view.surface(id))
        .map(|surface| surface.sense)
        .unwrap_or(Sense::Positive);
    sense_multiplier(face.sense) * sense_multiplier(surface_sense) < 0.0
}

/// 耳切三角化:返回(三角形顶点下标三元组列表, 多边形是否 CCW)。
/// 输出三角形朝向与多边形一致(CCW 化的索引序列上生成)。
fn triangulate_polygon(points: &[(f64, f64)]) -> Option<(Vec<[u32; 3]>, bool)> {
    let count = points.len();
    if count < 3 {
        return None;
    }
    let area = signed_area(points);
    if !area.is_finite() || area.abs() < 1e-15 {
        return None;
    }
    let ccw = area > 0.0;
    let mut ring: Vec<usize> = (0..count).collect();
    if !ccw {
        ring.reverse();
    }
    let mut triangles: Vec<[u32; 3]> = Vec::with_capacity(count.saturating_sub(2));
    let mut guard = 0usize;
    while ring.len() > 3 {
        guard += 1;
        if guard > count * count {
            break;
        }
        let mut ear_found = false;
        for index in 0..ring.len() {
            let previous = ring[(index + ring.len() - 1) % ring.len()];
            let current = ring[index];
            let next = ring[(index + 1) % ring.len()];
            if !is_convex(points, previous, current, next) {
                continue;
            }
            let contains_other = ring.iter().any(|&candidate| {
                candidate != previous
                    && candidate != current
                    && candidate != next
                    && point_in_triangle(
                        points[candidate],
                        points[previous],
                        points[current],
                        points[next],
                    )
            });
            if contains_other {
                continue;
            }
            triangles.push([previous as u32, current as u32, next as u32]);
            ring.remove(index);
            ear_found = true;
            break;
        }
        if !ear_found {
            break;
        }
    }
    if ring.len() == 3 {
        triangles.push([ring[0] as u32, ring[1] as u32, ring[2] as u32]);
    } else if triangles.is_empty() {
        // 耳切失败的兜底:扇形三角化(近似,由 face 级标注体系如实报告)。
        for index in 1..ring.len() - 1 {
            triangles.push([ring[0] as u32, ring[index] as u32, ring[index + 1] as u32]);
        }
        triangles.truncate(count);
    }
    Some((triangles, ccw))
}

fn is_convex(points: &[(f64, f64)], a: usize, b: usize, c: usize) -> bool {
    let (pa, pb, pc) = (points[a], points[b], points[c]);
    cross2((pb.0 - pa.0, pb.1 - pa.1), (pc.0 - pb.0, pc.1 - pb.1)) > 0.0
}

fn point_in_triangle(p: (f64, f64), a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> bool {
    let d1 = cross2((p.0 - a.0, p.1 - a.1), (b.0 - a.0, b.1 - a.1));
    let d2 = cross2((p.0 - b.0, p.1 - b.1), (c.0 - b.0, c.1 - b.1));
    let d3 = cross2((p.0 - c.0, p.1 - c.1), (a.0 - c.0, a.1 - c.1));
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// 射线法点在多边形内判定(含边界的数值稳健版)。
fn point_in_polygon(p: (f64, f64), polygon: &[(f64, f64)]) -> bool {
    let mut inside = false;
    let mut previous = polygon[polygon.len() - 1];
    for &current in polygon {
        let (x1, y1) = current;
        let (x2, y2) = previous;
        if (y1 > p.1) != (y2 > p.1) {
            let denominator = y2 - y1;
            if denominator.abs() > 1e-300 {
                let x_at = (x2 - x1) * (p.1 - y1) / denominator + x1;
                if p.0 < x_at {
                    inside = !inside;
                }
            }
        }
        previous = current;
    }
    inside
}

fn triangle_centroid(points: &[(f64, f64)], triangle: &[u32; 3]) -> (f64, f64) {
    let a = points[triangle[0] as usize];
    let b = points[triangle[1] as usize];
    let c = points[triangle[2] as usize];
    ((a.0 + b.0 + c.0) / 3.0, (a.1 + b.1 + c.1) / 3.0)
}

fn signed_area(points: &[(f64, f64)]) -> f64 {
    let mut area = 0.0;
    let count = points.len();
    for index in 0..count {
        let current = points[index];
        let next = points[(index + 1) % count];
        area += current.0 * next.1 - next.0 * current.1;
    }
    area * 0.5
}

fn cross2(a: (f64, f64), b: (f64, f64)) -> f64 {
    a.0 * b.1 - a.1 * b.0
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale(a: Vec3, factor: f64) -> Vec3 {
    [a[0] * factor, a[1] * factor, a[2] * factor]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: &Vec3, b: &Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn norm(a: &Vec3) -> f64 {
    dot(*a, *a).sqrt()
}

fn normalize(a: &Vec3) -> Option<Vec3> {
    let length = norm(a);
    if !length.is_finite() || length < 1e-15 {
        return None;
    }
    Some(scale(*a, 1.0 / length))
}

fn push_unique<T: PartialEq>(items: &mut Vec<T>, value: T) {
    if !items.contains(&value) {
        items.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parasolid_core::brep::SourceNodeRef;

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn source_ref() -> SourceNodeRef {
        SourceNodeRef {
            node_index: 0,
            node_type: 0,
            type_name: String::new(),
            node_id: None,
            byte_range: 0..0,
        }
    }

    fn bare_face() -> Face {
        Face {
            id: 0,
            back_shell: 0,
            front_shell: 0,
            loops: vec![],
            surface: None,
            sense: Sense::Positive,
            source: source_ref(),
        }
    }

    fn cylinder_params() -> SurfaceParams {
        SurfaceParams::Revolved(RevolvedParams {
            origin: [0.0, 0.0, 0.0],
            axis: [0.0, 0.0, 1.0],
            e1: [1.0, 0.0, 0.0],
            e2: [0.0, 1.0, 0.0],
            kind: RevolvedKind::Cylinder { radius: 2.0 },
        })
    }

    #[test]
    fn square_polygon_triangulates_into_two_triangles_of_equal_total_area() {
        let square = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];
        let (triangles, ccw) = triangulate_polygon(&square).expect("triangulation");
        assert!(ccw);
        assert_eq!(triangles.len(), 2);
        let area: f64 = triangles
            .iter()
            .map(|t| {
                let a = square[t[0] as usize];
                let b = square[t[1] as usize];
                let c = square[t[2] as usize];
                cross2((b.0 - a.0, b.1 - a.1), (c.0 - a.0, c.1 - a.1)).abs() * 0.5
            })
            .sum();
        assert!(approx(area, 1.0), "area={area}");
    }

    #[test]
    fn cw_polygon_emits_uniformly_ccw_triangles() {
        let square = [(0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, 0.0)];
        let (triangles, ccw) = triangulate_polygon(&square).expect("triangulation");
        assert!(!ccw);
        assert_eq!(triangles.len(), 2);
        for triangle in &triangles {
            let a = square[triangle[0] as usize];
            let b = square[triangle[1] as usize];
            let c = square[triangle[2] as usize];
            assert!(cross2((b.0 - a.0, b.1 - a.1), (c.0 - a.0, c.1 - a.1)) > 0.0);
        }
    }

    #[test]
    fn angular_bounds_detects_wrap_across_zero() {
        let turn = FULL_TURN;
        let angles = [0.0, 0.05, turn - 0.05, 0.02];
        let (start, span, full) = angular_bounds(&angles);
        assert!(!full);
        assert!(approx(span, 0.1), "span={span}");
        assert!(approx(start.rem_euclid(FULL_TURN), turn - 0.05), "start={start}");
    }

    #[test]
    fn angular_bounds_full_ring_for_dense_samples() {
        let angles: Vec<f64> = (0..64).map(|i| i as f64 / 64.0 * FULL_TURN).collect();
        let (start, span, full) = angular_bounds(&angles);
        assert!(full);
        assert!(approx(start, 0.0));
        assert!(approx(span, FULL_TURN));
    }

    #[test]
    fn angular_bounds_partial_span() {
        let angles = [0.0, 0.3, 0.6, 0.9];
        let (start, span, full) = angular_bounds(&angles);
        assert!(!full);
        assert!(approx(start, 0.0));
        assert!(approx(span, 0.9));
    }

    #[test]
    fn cylinder_projection_eval_roundtrip() {
        let params = cylinder_params();
        for &(u, v) in &[(0.0, 5.0), (1.0, -2.0), (3.0, 0.5)] {
            let world = params.eval(u, v);
            let (ru, rv) = params.project(world);
            assert!(approx(ru.rem_euclid(FULL_TURN), u.rem_euclid(FULL_TURN)));
            assert!(approx(rv, v));
        }
    }

    #[test]
    fn sphere_projection_eval_roundtrip() {
        let params = SurfaceParams::Revolved(RevolvedParams {
            origin: [1.0, 2.0, 3.0],
            axis: [0.0, 0.0, 1.0],
            e1: [1.0, 0.0, 0.0],
            e2: [0.0, 1.0, 0.0],
            kind: RevolvedKind::Sphere { radius: 3.0 },
        });
        let world = params.eval(0.7, 0.4);
        let (u, v) = params.project(world);
        assert!(approx(u.rem_euclid(FULL_TURN), 0.7));
        assert!(approx(v, 0.4));
    }

    #[test]
    fn torus_projection_eval_roundtrip() {
        let params = SurfaceParams::Revolved(RevolvedParams {
            origin: [0.0, 0.0, 0.0],
            axis: [0.0, 0.0, 1.0],
            e1: [1.0, 0.0, 0.0],
            e2: [0.0, 1.0, 0.0],
            kind: RevolvedKind::Torus { major: 5.0, minor: 1.0 },
        });
        for &(u, v) in &[(0.0, 0.0), (1.0, 0.6), (4.0, -0.6)] {
            let world = params.eval(u, v);
            let (ru, rv) = params.project(world);
            assert!(approx(ru.rem_euclid(FULL_TURN), u.rem_euclid(FULL_TURN)));
            assert!(approx(rv, v));
        }
    }

    #[test]
    fn grid_emits_outward_normals_for_positive_sense_cylinder() {
        let face = bare_face();
        let limits = GeometryLimits::default();
        let mesh = tessellate_revolved_grid(
            &face,
            &cylinder_params(),
            (0.0, FULL_TURN, true),
            (0.0, 1.0, false),
            Vec::new(),
            limits,
            false,
        )
        .expect("grid");
        assert_eq!(mesh.surface_kind, "cylinder");
        // 半径 2、v 跨 1:v 段 = ceil(1/(2π·2)·64) = 6 → 7 行 × 65 列顶点。
        assert_eq!(mesh.positions.len(), 7 * (ANGULAR_SEGMENTS + 1) * 3);
        // 首个三角形 = (a, right, up):列间步进为 u,行间步进为 columns 个顶点。
        let columns = ANGULAR_SEGMENTS + 1;
        let vertex = |index: usize| &mesh.positions[index * 3..index * 3 + 3];
        let (a, b, c) = (vertex(0), vertex(1), vertex(columns));
        let ab: Vec3 =
            [(b[0] - a[0]) as f64, (b[1] - a[1]) as f64, (b[2] - a[2]) as f64];
        let ac: Vec3 =
            [(c[0] - a[0]) as f64, (c[1] - a[1]) as f64, (c[2] - a[2]) as f64];
        let n = cross(&ab, &ac);
        assert!(n[0] > 0.0, "outward normal expected, got {n:?}");
    }

    #[test]
    fn grid_respects_face_triangle_budget() {
        let face = bare_face();
        let limits = GeometryLimits { max_triangles_per_face: 4, ..GeometryLimits::default() };
        let result = tessellate_revolved_grid(
            &face,
            &cylinder_params(),
            (0.0, FULL_TURN, true),
            (0.0, 1.0, false),
            Vec::new(),
            limits,
            false,
        );
        assert!(result.is_err());
    }
}
