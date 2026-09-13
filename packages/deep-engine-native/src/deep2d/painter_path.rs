use super::{
    Deep2dMatrix, Deep2dPainterIssue, Deep2dPainterIssueCode, Deep2dPathVerb, PathResource,
    painter::issue,
    painter_math::{Point, line_distance, midpoint, near, point_epsilon},
};

/// Maximum curve flattening error in physical pixels.
pub const DEEP2D_CURVE_TOLERANCE: f64 = 0.25;
pub const DEEP2D_MAX_FLATTENED_SEGMENTS: usize = 16_384;
const MAX_CURVE_DEPTH: u8 = 24;

pub(super) struct LinearPath {
    pub points: Vec<Point>,
    pub closed: bool,
}

impl LinearPath {
    pub(super) fn from_resource(
        resource: &PathResource,
        resource_path: &str,
        command_path: &str,
        transform: Deep2dMatrix,
        scale_factor: f64,
    ) -> Result<Self, Deep2dPainterIssue> {
        let scale_bound = (transform[0] * transform[0]
            + transform[1] * transform[1]
            + transform[2] * transform[2]
            + transform[3] * transform[3])
            .sqrt();
        let physical_scale_bound = (scale_bound * scale_factor).max(1e-12);
        let tolerance = (DEEP2D_CURVE_TOLERANCE / physical_scale_bound).max(1e-12);
        let mut points = Vec::new();
        let mut closed = false;
        for (index, verb) in resource.verbs.iter().enumerate() {
            let verb_path = format!("{resource_path}.verbs[{index}]");
            match verb {
                Deep2dPathVerb::Move { x, y } if points.is_empty() => points.push([*x, *y]),
                Deep2dPathVerb::Move { .. } => {
                    return Err(issue(
                        Deep2dPainterIssueCode::UnsupportedGeometry,
                        &verb_path,
                        "The native painter accepts one subpath per path resource.",
                    ));
                }
                Deep2dPathVerb::Line { x, y } if !closed => {
                    push_segment(&mut points, [*x, *y], &verb_path)?;
                }
                Deep2dPathVerb::Quadratic { cx, cy, x, y } if !closed => {
                    let start = *points.last().expect("validated path starts with move");
                    flatten_quadratic(
                        &mut points,
                        start,
                        [*cx, *cy],
                        [*x, *y],
                        tolerance,
                        0,
                        &verb_path,
                    )?;
                }
                Deep2dPathVerb::Cubic {
                    c1x,
                    c1y,
                    c2x,
                    c2y,
                    x,
                    y,
                } if !closed => {
                    let start = *points.last().expect("validated path starts with move");
                    flatten_cubic(
                        &mut points,
                        start,
                        [*c1x, *c1y],
                        [*c2x, *c2y],
                        [*x, *y],
                        tolerance,
                        0,
                        &verb_path,
                    )?;
                }
                Deep2dPathVerb::Close if !closed => closed = true,
                _ => {
                    return Err(issue(
                        Deep2dPainterIssueCode::UnsupportedGeometry,
                        &verb_path,
                        "Path contains a second subpath or geometry after close.",
                    ));
                }
            }
        }
        if points.len() < 2 {
            return Err(issue(
                Deep2dPainterIssueCode::UnsupportedGeometry,
                command_path,
                "Path requires at least two distinct points for the native painter.",
            ));
        }
        let epsilon = point_epsilon(&points);
        if closed && points.len() > 2 && near(points[0], *points.last().expect("points"), epsilon) {
            points.pop();
        }
        if points
            .windows(2)
            .any(|pair| near(pair[0], pair[1], epsilon))
        {
            return Err(issue(
                Deep2dPainterIssueCode::UnsupportedGeometry,
                command_path,
                "Path contains a zero-length or numerically indistinguishable segment.",
            ));
        }
        Ok(Self { points, closed })
    }
}

fn push_segment(
    points: &mut Vec<Point>,
    point: Point,
    path: &str,
) -> Result<(), Deep2dPainterIssue> {
    if points.len() > DEEP2D_MAX_FLATTENED_SEGMENTS {
        return Err(issue(
            Deep2dPainterIssueCode::TessellationBudgetExceeded,
            path,
            "Path exceeds the flattened segment budget.",
        ));
    }
    points.push(point);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn flatten_quadratic(
    points: &mut Vec<Point>,
    start: Point,
    control: Point,
    end: Point,
    tolerance: f64,
    depth: u8,
    path: &str,
) -> Result<(), Deep2dPainterIssue> {
    if line_distance(control, start, end) <= tolerance {
        return push_segment(points, end, path);
    }
    check_depth(depth, path)?;
    let start_control = midpoint(start, control);
    let control_end = midpoint(control, end);
    let split = midpoint(start_control, control_end);
    flatten_quadratic(
        points,
        start,
        start_control,
        split,
        tolerance,
        depth + 1,
        path,
    )?;
    flatten_quadratic(points, split, control_end, end, tolerance, depth + 1, path)
}

#[allow(clippy::too_many_arguments)]
fn flatten_cubic(
    points: &mut Vec<Point>,
    start: Point,
    control_a: Point,
    control_b: Point,
    end: Point,
    tolerance: f64,
    depth: u8,
    path: &str,
) -> Result<(), Deep2dPainterIssue> {
    if line_distance(control_a, start, end).max(line_distance(control_b, start, end)) <= tolerance {
        return push_segment(points, end, path);
    }
    check_depth(depth, path)?;
    let a = midpoint(start, control_a);
    let b = midpoint(control_a, control_b);
    let c = midpoint(control_b, end);
    let ab = midpoint(a, b);
    let bc = midpoint(b, c);
    let split = midpoint(ab, bc);
    flatten_cubic(points, start, a, ab, split, tolerance, depth + 1, path)?;
    flatten_cubic(points, split, bc, c, end, tolerance, depth + 1, path)
}

fn check_depth(depth: u8, path: &str) -> Result<(), Deep2dPainterIssue> {
    if depth >= MAX_CURVE_DEPTH {
        return Err(issue(
            Deep2dPainterIssueCode::TessellationBudgetExceeded,
            path,
            "Curve cannot meet the transformed error tolerance within the recursion budget.",
        ));
    }
    Ok(())
}
