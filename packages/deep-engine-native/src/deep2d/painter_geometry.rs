use super::{
    Deep2dColor, Deep2dMatrix, Deep2dPainterIssue, Deep2dPainterIssueCode, PathCommand,
    painter::issue,
    painter_math::{Point, transform_point},
    painter_path::LinearPath,
    painter_polygon::{MAX_SIMPLE_POLYGON_POINTS, simplify_collinear, triangulate_simple_polygon},
    painter_stroke::stroke_outline,
};

pub(super) fn append_fill(
    vertices: &mut Vec<[f32; 6]>,
    path: &LinearPath,
    transform: Deep2dMatrix,
    color: Deep2dColor,
    opacity: f32,
    command_path: &str,
) -> Result<usize, Deep2dPainterIssue> {
    if !path.closed || path.points.len() < 3 {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedGeometry,
            command_path,
            "Fill requires one explicitly closed polygon with at least three points.",
        ));
    }
    if path.points.len() > MAX_SIMPLE_POLYGON_POINTS {
        return Err(issue(
            Deep2dPainterIssueCode::TessellationBudgetExceeded,
            command_path,
            "Fill exceeds the simple-polygon tessellation point budget.",
        ));
    }
    let points = path
        .points
        .iter()
        .map(|point| transform_point(*point, transform))
        .collect::<Vec<_>>();
    append_polygon(vertices, &points, color, opacity, command_path)
}

pub(super) fn append_stroke(
    vertices: &mut Vec<[f32; 6]>,
    path: &LinearPath,
    command: &PathCommand,
    color: Deep2dColor,
    opacity: f32,
    command_path: &str,
) -> Result<usize, Deep2dPainterIssue> {
    if path.closed {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedGeometry,
            command_path,
            "Stroke currently accepts open paths only.",
        ));
    }
    let mut outline = stroke_outline(path, command, command_path)?
        .into_iter()
        .map(|point| transform_point(point, command.transform))
        .collect::<Vec<_>>();
    simplify_collinear(&mut outline);
    append_polygon(vertices, &outline, color, opacity, command_path)
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
