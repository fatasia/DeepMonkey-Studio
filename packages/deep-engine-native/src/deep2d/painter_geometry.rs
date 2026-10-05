use super::{
    Deep2dColor, Deep2dMatrix, Deep2dPainterIssue, Deep2dPainterIssueCode, PathCommand,
    painter::{PathVertex, issue},
    painter_math::{Point, transform_point},
    painter_path::{DEEP2D_CURVE_TOLERANCE, LinearPath, LinearSubPath},
    painter_polygon::{MAX_SIMPLE_POLYGON_POINTS, simplify_collinear, triangulate_simple_polygon},
    painter_polygon_bridge::bridge_hole,
    painter_stroke::{closed_stroke_outline, stroke_outline},
};

/// Fill-rule geometry: the first closed subpath is the outer ring, later
/// closed subpaths are holes bridged into it. Winding normalization makes
/// nonzero and evenodd agree for single-level holes.
pub(super) fn bridged_ring(
    path: &LinearPath,
    command_path: &str,
) -> Result<Vec<Point>, Deep2dPainterIssue> {
    let mut closed = path.subpaths.iter().filter(|subpath| subpath.closed);
    let Some(outer) = closed.next() else {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedGeometry,
            command_path,
            "Fill rule requires at least one closed outer subpath.",
        ));
    };
    let outer_ring = subpath_ring(outer, &format!("{command_path}.subpaths[0]"))?;
    let mut ring = outer_ring;
    for (index, hole) in path.subpaths.iter().enumerate().skip(1) {
        let hole_path = format!("{command_path}.subpaths[{index}]");
        if hole.closed {
            let hole_ring = subpath_ring(hole, &hole_path)?;
            ring = bridge_hole(&ring, &hole_ring, command_path)?;
        } else {
            return Err(issue(
                Deep2dPainterIssueCode::UnsupportedGeometry,
                &hole_path,
                "Fill-rule rendering accepts closed subpaths only (open cannot coexist with holes).",
            ));
        }
    }
    if ring.len() > MAX_SIMPLE_POLYGON_POINTS {
        return Err(issue(
            Deep2dPainterIssueCode::TessellationBudgetExceeded,
            command_path,
            "Filled ring with holes exceeds the simple-polygon point budget.",
        ));
    }
    Ok(ring)
}

fn subpath_ring(
    subpath: &LinearSubPath,
    subpath_path: &str,
) -> Result<Vec<Point>, Deep2dPainterIssue> {
    if !subpath.closed || subpath.points.len() < 3 {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedGeometry,
            subpath_path,
            "Fill requires every subpath to be an explicitly closed polygon with at least three points.",
        ));
    }
    if subpath.points.len() > MAX_SIMPLE_POLYGON_POINTS {
        return Err(issue(
            Deep2dPainterIssueCode::TessellationBudgetExceeded,
            subpath_path,
            "Fill exceeds the simple-polygon tessellation point budget.",
        ));
    }
    Ok(subpath.points.clone())
}

/// Default-agnostic fill of one closed subpath in local space.
pub(super) fn append_closed_subpath(
    vertices: &mut Vec<PathVertex>,
    subpath: &LinearSubPath,
    transform: Deep2dMatrix,
    color: Deep2dColor,
    opacity: f32,
    paint_slot: u32,
    subpath_path: &str,
) -> Result<usize, Deep2dPainterIssue> {
    if !subpath.closed || subpath.points.len() < 3 {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedGeometry,
            subpath_path,
            "Fill requires every subpath to be an explicitly closed polygon with at least three points.",
        ));
    }
    if subpath.points.len() > MAX_SIMPLE_POLYGON_POINTS {
        return Err(issue(
            Deep2dPainterIssueCode::TessellationBudgetExceeded,
            subpath_path,
            "Fill exceeds the simple-polygon tessellation point budget.",
        ));
    }
    append_polygon(
        vertices,
        &subpath.points,
        transform,
        color,
        opacity,
        paint_slot,
        subpath_path,
    )
}

pub(super) fn append_stroke(
    vertices: &mut Vec<PathVertex>,
    path: &LinearPath,
    command: &PathCommand,
    color: Deep2dColor,
    opacity: f32,
    tolerance: f64,
    command_path: &str,
) -> Result<usize, Deep2dPainterIssue> {
    let mut triangles = 0usize;
    for (index, subpath) in path.subpaths.iter().enumerate() {
        let subpath_path = format!("{command_path}.subpaths[{index}]");
        let geometry = if subpath.closed {
            closed_stroke_outline(subpath, command, tolerance, &subpath_path)?
        } else {
            stroke_outline(subpath, command, tolerance, &subpath_path)?
        };
        let mut outline = geometry.outline;
        simplify_collinear(&mut outline);
        if outline.len() >= 3 {
            triangles += append_polygon(
                vertices,
                &outline,
                command.transform,
                color,
                opacity,
                0,
                &subpath_path,
            )?;
        }
        // Round caps/joins append as extra convex fan rings in draw order.
        for (fan_index, fan) in geometry.fans.into_iter().enumerate() {
            if fan.len() < 3 {
                continue;
            }
            let fan_path = format!("{subpath_path}.fans[{fan_index}]");
            let mut fan = fan;
            simplify_collinear(&mut fan);
            if fan.len() >= 3 {
                triangles += append_polygon(
                    vertices,
                    &fan,
                    command.transform,
                    color,
                    opacity,
                    0,
                    &fan_path,
                )?;
            }
        }
    }
    Ok(triangles)
}

/// Emits triangulated polygons as path vertices. Points arrive in the
/// command's LOCAL space (pre-transform); each vertex carries both the
/// transformed canvas position (draw geometry) and the local position
/// (gradient evaluation space), plus its paint storage slot.
pub(super) fn append_polygon(
    vertices: &mut Vec<PathVertex>,
    points: &[Point],
    transform: Deep2dMatrix,
    color: Deep2dColor,
    opacity: f32,
    paint_slot: u32,
    command_path: &str,
) -> Result<usize, Deep2dPainterIssue> {
    let triangles = triangulate_simple_polygon(points, command_path)?;
    let rgba = [
        color[0] as f32,
        color[1] as f32,
        color[2] as f32,
        color[3] as f32 * opacity,
    ];
    for [a, b, c] in &triangles {
        for index in [*a, *b, *c] {
            let local = points[index];
            let canvas = transform_point(local, transform);
            vertices.push([
                canvas[0] as f32,
                canvas[1] as f32,
                rgba[0],
                rgba[1],
                rgba[2],
                rgba[3],
                local[0] as f32,
                local[1] as f32,
                paint_slot as f32,
            ]);
        }
    }
    Ok(triangles.len())
}

/// Physical-pixel flattening tolerance mapped back to logical units for the
/// command's transform; matches the curve flattening tolerance contract.
pub(super) fn stroke_tolerance(command: &PathCommand, scale_factor: f64) -> f64 {
    let physical = (transform_scale_bound(command.transform) * scale_factor).max(1e-12);
    (DEEP2D_CURVE_TOLERANCE / physical).max(1e-12)
}

/// Physical pixels per local unit for analytic AA feathers (same camera
/// witness scale the tessellation tolerance uses).
pub(super) fn fill_aa_scale(command: &PathCommand, scale_factor: f64) -> f64 {
    (transform_scale_bound(command.transform) * scale_factor).max(1e-6)
}

fn transform_scale_bound(transform: Deep2dMatrix) -> f64 {
    (transform[0] * transform[0]
        + transform[1] * transform[1]
        + transform[2] * transform[2]
        + transform[3] * transform[3])
        .sqrt()
}
