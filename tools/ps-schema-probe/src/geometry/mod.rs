//! B-Rep → 三角网格 MVP 离散化(2026-09-26 R1)。
//!
//! 算法口径(与 packages/xt-reader/src/mesh.ts 的 64 段圆周离散一致):
//! - plane:边界环采样到 uv 平面 → 耳切三角化;内环未精确处理时拒绝发布;
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

mod faces;

use faces::{
    add, build_plane_face, build_revolved_face, cross, dot, norm, normalize, push_unique, scale,
    sub,
};

pub(crate) type Vec3 = [f64; 3];

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
    #[serde(rename = "sourceNodeIndex")]
    pub source_node_index: u32,
    #[serde(rename = "sourceNodeId", skip_serializing_if = "Option::is_none")]
    pub source_node_id: Option<i32>,
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


#[cfg(test)]
mod tests {
    use super::faces::{
    angular_bounds, cross2, is_convex, point_in_triangle, signed_area, tessellate_revolved_grid,
    triangulate_polygon,
};
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
    fn closed_ring_duplicate_endpoint_cannot_emit_zero_area_triangles() {
        let closed = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (0.0, 0.0)];
        assert!(triangulate_polygon(&closed).is_none());
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
