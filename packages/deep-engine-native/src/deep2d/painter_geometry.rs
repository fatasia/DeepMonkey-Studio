use super::{
    Deep2dColor, Deep2dMatrix, Deep2dPainterIssue, Deep2dPainterIssueCode, FillRule, PathCommand,
    painter::issue,
    painter_math::{Point, transform_point},
    painter_path::{LinearPath, LinearSubPath},
    painter_polygon::{MAX_SIMPLE_POLYGON_POINTS, simplify_collinear, triangulate_simple_polygon},
    painter_polygon_bridge::bridge_hole,
    painter_stroke::{closed_stroke_outline, stroke_outline},
};

pub(super) fn append_fill(
    vertices: &mut Vec<[f32; 6]>,
    path: &LinearPath,
    fill_rule: Option<FillRule>,
    transform: Deep2dMatrix,
    color: Deep2dColor,
    opacity: f32,
    command_path: &str,
) -> Result<usize, Deep2dPainterIssue> {
    if fill_rule.is_none() {
        let mut triangles = 0usize;
        for (index, subpath) in path.subpaths.iter().enumerate() {
            let subpath_path = format!("{command_path}.subpaths[{index}]");
            triangles +=
                append_closed_subpath(vertices, subpath, transform, color, opacity, &subpath_path)?;
        }
        return Ok(triangles);
    }
    // Fill-rule path: first closed subpath is the outer ring, later closed
    // subpaths are holes bridged into it. Winding normalization makes nonzero
    // and evenodd agree for single-level holes.
    let mut closed = path.subpaths.iter().filter(|subpath| subpath.closed);
    let Some(outer) = closed.next() else {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedGeometry,
            command_path,
            "Fill rule requires at least one closed outer subpath.",
        ));
    };
    let outer_ring = subpath_ring(outer, transform, &format!("{command_path}.subpaths[0]"))?;
    let mut ring = outer_ring;
    for (index, hole) in path.subpaths.iter().enumerate().skip(1) {
        let hole_path = format!("{command_path}.subpaths[{index}]");
        if hole.closed {
            let hole_ring = subpath_ring(hole, transform, &hole_path)?;
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
    append_polygon(vertices, &ring, color, opacity, command_path)
}

fn subpath_ring(
    subpath: &LinearSubPath,
    transform: Deep2dMatrix,
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
    Ok(subpath
        .points
        .iter()
        .map(|point| transform_point(*point, transform))
        .collect())
}

fn append_closed_subpath(
    vertices: &mut Vec<[f32; 6]>,
    subpath: &LinearSubPath,
    transform: Deep2dMatrix,
    color: Deep2dColor,
    opacity: f32,
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
    let points = subpath
        .points
        .iter()
        .map(|point| transform_point(*point, transform))
        .collect::<Vec<_>>();
    append_polygon(vertices, &points, color, opacity, subpath_path)
}

pub(super) fn append_stroke(
    vertices: &mut Vec<[f32; 6]>,
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
        let mut outline = geometry
            .outline
            .into_iter()
            .map(|point| transform_point(point, command.transform))
            .collect::<Vec<_>>();
        simplify_collinear(&mut outline);
        if outline.len() >= 3 {
            triangles += append_polygon(vertices, &outline, color, opacity, &subpath_path)?;
        }
        // Round caps/joins append as extra convex fan rings in draw order.
        for (fan_index, fan) in geometry.fans.into_iter().enumerate() {
            if fan.len() < 3 {
                continue;
            }
            let fan_path = format!("{subpath_path}.fans[{fan_index}]");
            let mut fan = fan
                .into_iter()
                .map(|point| transform_point(point, command.transform))
                .collect::<Vec<_>>();
            simplify_collinear(&mut fan);
            if fan.len() >= 3 {
                triangles += append_polygon(vertices, &fan, color, opacity, &fan_path)?;
            }
        }
    }
    Ok(triangles)
}

fn append_polygon(
    vertices: &mut Vec<[f32; 6]>,
    points: &[Point],
    color: Deep2dColor,
    opacity: f32,
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
            let point = points[index];
            vertices.push([
                point[0] as f32,
                point[1] as f32,
                rgba[0],
                rgba[1],
                rgba[2],
                rgba[3],
            ]);
        }
    }
    Ok(triangles.len())
}
