//! 面片构建管线:边界环采样 → 参数域裁剪 → 网格化/三角化(R1 口径,函数体逐字迁自 geometry.rs)。
use std::cmp::Ordering;
use super::{
    FaceMesh, GeometryLimits, ModelView, RevolvedFrame, RevolvedKind, SampleError, SurfaceParams,
    ANGULAR_SEGMENTS, FULL_TURN, GAP_EPSILON, HALF_TURN, LATITUDE_SEGMENTS, MAX_EDGE_SAMPLES,
    MAX_LOOP_POINTS, PROJECTION_TOLERANCE, Vec3,
};
use parasolid_core::brep::{CurveKind, Edge, Face, Sense, SurfaceKind};

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
    let vertex_tolerance = (view.scale * 1e-9).max(1e-12);
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
            let mut points = match sample_edge_points(view, edge, fin.sense) {
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
            // A fin stores its end vertex; the opposite fin stores its start.
            // Curve sense alone does not encode the fin's traversal on an EDGE.
            // Align the sampled endpoints with the actual topological end before
            // concatenating loops (otherwise alternating shared edges fold back).
            if let Some(end) = fin.vertex.and_then(|id| view.vertex_point(id)) {
                if points.len() >= 2 {
                    let first_distance = norm(&sub(points[0], end));
                    let last_distance = norm(&sub(*points.last().expect("length checked"), end));
                    if first_distance + vertex_tolerance < last_distance {
                        points.reverse();
                    } else if first_distance.min(last_distance) > vertex_tolerance {
                        return Err("geometry:fin-endpoint-mismatch".to_string());
                    }
                }
            }
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
                    if norm(&sub(*world_points.last().expect("paired world point"), point)) <= vertex_tolerance
                        || ((last_u - u).abs() < 1e-12 && (last_v - v).abs() < 1e-12)
                    {
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
        // Adjacent fins both contribute their shared corner. Remove the closing
        // vertex before ear clipping; otherwise repeated points yield zero-area
        // triangles and a wrong closed-solid volume while B-Rep topology is valid.
        if uv_points.len() > 1 {
            let first = world_points[0];
            let last = *world_points.last().expect("non-empty after length guard");
            if norm(&sub(first, last)) <= vertex_tolerance {
                world_points.pop();
                uv_points.pop();
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

/// 平面面片:单外环 uv 耳切;多个环需孔洞三角化,此处拒绝而非填孔。
pub(super) fn build_plane_face(view: &ModelView, face: &Face, params: &SurfaceParams) -> Result<FaceMesh, String> {
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

    // Centroid culling is not a hole triangulator: a triangle can cross an
    // inner loop while its centroid stays outside. Refuse the entire face
    // instead of emitting a visually filled hole under a ready quality tier.
    if usable.len() > 1 {
        return Err("trim-unresolved:inner-loop-needs-exact-triangulation".to_string());
    }
    let outer = &usable[0].uv_points;
    let Some((triangles, _ccw)) = triangulate_polygon(outer) else {
        return Err("degenerate:outer-loop-triangulation-failed".to_string());
    };

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
        source_node_index: face.source.node_index,
        source_node_id: face.source.node_id,
        body: None, // export_geometry 统一回填。
        surface_kind: "plane".to_string(),
        positions,
        indices,
        approximations: Vec::new(),
    })
}

/// 旋成面(柱/锥/球/环):u 环向裁剪 + v 截断(球为经纬裁剪)。
pub(super) fn build_revolved_face(
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
pub(super) fn angular_bounds(angles: &[f64]) -> (f64, f64, bool) {
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
pub(super) fn tessellate_revolved_grid(
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
        source_node_index: face.source.node_index,
        source_node_id: face.source.node_id,
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
pub(super) fn triangulate_polygon(points: &[(f64, f64)]) -> Option<(Vec<[u32; 3]>, bool)> {
    let count = points.len();
    if count < 3 {
        return None;
    }
    // The wire can carry a repeated closing vertex and adjacent fins repeat
    // corners. Never feed duplicate or zero-length edges into ear clipping.
    if (0..count).any(|index| {
        let a = points[index];
        let b = points[(index + 1) % count];
        (a.0 - b.0).abs() < 1e-12 && (a.1 - b.1).abs() < 1e-12
    }) {
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
    } else {
        // A partial ear list is not a polygon. Fan fallback may bridge concavity
        // or holes and was not tagged by callers; fail closed instead.
        return None;
    }
    Some((triangles, ccw))
}

pub(super) fn is_convex(points: &[(f64, f64)], a: usize, b: usize, c: usize) -> bool {
    let (pa, pb, pc) = (points[a], points[b], points[c]);
    cross2((pb.0 - pa.0, pb.1 - pa.1), (pc.0 - pb.0, pc.1 - pb.1)) > 0.0
}

pub(super) fn point_in_triangle(p: (f64, f64), a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> bool {
    let d1 = cross2((p.0 - a.0, p.1 - a.1), (b.0 - a.0, b.1 - a.1));
    let d2 = cross2((p.0 - b.0, p.1 - b.1), (c.0 - b.0, c.1 - b.1));
    let d3 = cross2((p.0 - c.0, p.1 - c.1), (a.0 - c.0, a.1 - c.1));
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

pub(super) fn signed_area(points: &[(f64, f64)]) -> f64 {
    let mut area = 0.0;
    let count = points.len();
    for index in 0..count {
        let current = points[index];
        let next = points[(index + 1) % count];
        area += current.0 * next.1 - next.0 * current.1;
    }
    area * 0.5
}

pub(super) fn cross2(a: (f64, f64), b: (f64, f64)) -> f64 {
    a.0 * b.1 - a.1 * b.0
}

pub(super) fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(super) fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub(super) fn scale(a: Vec3, factor: f64) -> Vec3 {
    [a[0] * factor, a[1] * factor, a[2] * factor]
}

pub(super) fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(super) fn cross(a: &Vec3, b: &Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(super) fn norm(a: &Vec3) -> f64 {
    dot(*a, *a).sqrt()
}

pub(super) fn normalize(a: &Vec3) -> Option<Vec3> {
    let length = norm(a);
    if !length.is_finite() || length < 1e-15 {
        return None;
    }
    Some(scale(*a, 1.0 / length))
}

pub(super) fn push_unique<T: PartialEq>(items: &mut Vec<T>, value: T) {
    if !items.contains(&value) {
        items.push(value);
    }
}
