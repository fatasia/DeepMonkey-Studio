use super::{
    Deep2dMatrix, Deep2dPainterIssue, Deep2dPainterIssueCode, Deep2dPathVerb, PathResource,
    painter::issue,
    painter_math::{Point, line_distance, midpoint, near, point_epsilon},
    painter_path_intersections::{reject_cross_subpath_intersections, reject_self_intersections},
};

/// Maximum curve flattening error in physical pixels.
pub const DEEP2D_CURVE_TOLERANCE: f64 = 0.25;
pub const DEEP2D_MAX_FLATTENED_SEGMENTS: usize = 16_384;
const MAX_CURVE_DEPTH: u8 = 24;

pub(super) struct LinearSubPath {
    pub points: Vec<Point>,
    pub closed: bool,
}

pub(super) struct LinearPath {
    pub subpaths: Vec<LinearSubPath>,
}

impl LinearSubPath {
    /// Implicit closing segment (last -> first) for closed subpaths.
    pub(super) fn segments(&self) -> Vec<[Point; 2]> {
        let mut segments = self
            .points
            .windows(2)
            .map(|pair| [pair[0], pair[1]])
            .collect::<Vec<_>>();
        if self.closed && self.points.len() > 2 {
            segments.push([
                *self.points.last().expect("closed subpath has points"),
                self.points[0],
            ]);
        }
        segments
    }
}

impl LinearPath {
    /// Total flattened segments including implicit closing edges.
    pub(super) fn segment_count(&self) -> usize {
        self.subpaths
            .iter()
            .map(|subpath| subpath.segments().len())
            .sum()
    }

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
        let mut subpaths: Vec<LinearSubPath> = Vec::new();
        let mut points: Vec<Point> = Vec::new();
        let mut closed = false;
        for (index, verb) in resource.verbs.iter().enumerate() {
            let verb_path = format!("{resource_path}.verbs[{index}]");
            match verb {
                Deep2dPathVerb::Move { x, y } => {
                    if !points.is_empty() {
                        finalize_subpath(&mut subpaths, points, closed, command_path)?;
                        points = Vec::new();
                        closed = false;
                    }
                    points.push([*x, *y]);
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
                Deep2dPathVerb::Close if !closed => {
                    if points.len() < 2 {
                        return Err(issue(
                            Deep2dPainterIssueCode::UnsupportedGeometry,
                            &verb_path,
                            "Close requires at least two distinct points in the subpath.",
                        ));
                    }
                    closed = true;
                }
                _ => {
                    return Err(issue(
                        Deep2dPainterIssueCode::UnsupportedGeometry,
                        &verb_path,
                        "Path contains duplicate close or geometry after close.",
                    ));
                }
            }
        }
        if points.is_empty() {
            if subpaths.is_empty() {
                return Err(issue(
                    Deep2dPainterIssueCode::UnsupportedGeometry,
                    command_path,
                    "Path requires at least two distinct points for the native painter.",
                ));
            }
            return Err(issue(
                Deep2dPainterIssueCode::UnsupportedGeometry,
                command_path,
                "Path ends with an empty subpath.",
            ));
        }
        finalize_subpath(&mut subpaths, points, closed, command_path)?;
        for subpath in &subpaths {
            reject_self_intersections(subpath, command_path)?;
        }
        reject_cross_subpath_intersections(&subpaths, command_path)?;
        Ok(Self { subpaths })
    }
}

fn finalize_subpath(
    subpaths: &mut Vec<LinearSubPath>,
    mut points: Vec<Point>,
    closed: bool,
    command_path: &str,
) -> Result<(), Deep2dPainterIssue> {
    if points.len() < 2 {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedGeometry,
            command_path,
            "Each subpath requires at least two distinct points.",
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
            "Subpath contains a zero-length or numerically indistinguishable segment.",
        ));
    }
    subpaths.push(LinearSubPath { points, closed });
    Ok(())
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
