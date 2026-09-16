use super::{
    Deep2dPainterIssue, Deep2dPainterIssueCode, LineCap, LineJoin, PathCommand,
    painter::issue,
    painter_math::{Point, cross},
    painter_path::LinearSubPath,
    painter_polygon::MAX_SIMPLE_POLYGON_POINTS,
    stroke_caps::{round_cap, round_join},
};

/// Stroke geometry of one sub-path: the main offset ring plus optional convex
/// fan polygons (round caps / round joins) that append as extra filled rings.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct StrokeOutline {
    pub outline: Vec<Point>,
    pub fans: Vec<Vec<Point>>,
}

pub(super) fn stroke_outline(
    subpath: &LinearSubPath,
    command: &PathCommand,
    tolerance: f64,
    command_path: &str,
) -> Result<StrokeOutline, Deep2dPainterIssue> {
    if subpath.points.len() * 3 > MAX_SIMPLE_POLYGON_POINTS {
        return Err(issue(
            Deep2dPainterIssueCode::TessellationBudgetExceeded,
            command_path,
            "Stroke outline exceeds the simple-polygon tessellation point budget.",
        ));
    }
    let half_width = command.stroke_width.expect("validated stroke width") * 0.5;
    let directions = subpath
        .points
        .windows(2)
        .map(|pair| unit_direction(pair[0], pair[1]))
        .collect::<Vec<_>>();
    if directions.iter().any(|direction| direction.is_none()) {
        return Err(geometry_issue(
            command_path,
            "Stroke contains a near-zero segment.",
        ));
    }
    let directions = directions.into_iter().flatten().collect::<Vec<_>>();
    let cap = command.line_cap.unwrap_or(LineCap::Butt);
    let join = command.line_join.unwrap_or(LineJoin::Miter);
    let square = cap == LineCap::Square;
    let start = if square {
        subtract(subpath.points[0], scale(directions[0], half_width))
    } else {
        subpath.points[0]
    };
    let last = subpath.points.len() - 1;
    let end = if square {
        add(
            subpath.points[last],
            scale(directions[last - 1], half_width),
        )
    } else {
        subpath.points[last]
    };
    let mut left = vec![add(start, scale(normal(directions[0]), half_width))];
    let mut right = vec![subtract(start, scale(normal(directions[0]), half_width))];
    let mut fans = Vec::new();
    for index in 1..last {
        let (previous, next) = (directions[index - 1], directions[index]);
        if join == LineJoin::Round {
            let turn = cross([0.0, 0.0], previous, next);
            if turn.abs() > 1e-10 {
                fans.push(
                    round_join(subpath.points[index], previous, next, half_width, tolerance)?
                        .points,
                );
            }
        }
        append_join(
            &mut left,
            &mut right,
            subpath.points[index],
            previous,
            next,
            half_width,
            join,
            command.miter_limit.unwrap_or(10.0),
            1e-10,
            command_path,
        )?;
    }
    if cap == LineCap::Round {
        fans.push(
            round_cap(
                subpath.points[0],
                negate(directions[0]),
                half_width,
                tolerance,
                command_path,
            )?
            .points,
        );
        fans.push(
            round_cap(
                subpath.points[last],
                directions[last - 1],
                half_width,
                tolerance,
                command_path,
            )?
            .points,
        );
    }
    let end_normal = normal(directions[last - 1]);
    left.push(add(end, scale(end_normal, half_width)));
    right.push(subtract(end, scale(end_normal, half_width)));
    left.extend(right.into_iter().rev());
    Ok(StrokeOutline {
        outline: left,
        fans,
    })
}

/// Closed-subpath outline: joins at every vertex including the seam where the
/// closing edge wraps to the first edge. A butt seam would leave a notch on
/// non-convex shapes, so the seam joins like any other vertex; round joins
/// also fan the seam.
pub(super) fn closed_stroke_outline(
    subpath: &LinearSubPath,
    command: &PathCommand,
    tolerance: f64,
    command_path: &str,
) -> Result<StrokeOutline, Deep2dPainterIssue> {
    let count = subpath.points.len();
    if count < 3 {
        return Err(geometry_issue(
            command_path,
            "Closed stroke requires at least three points.",
        ));
    }
    if count * 3 > MAX_SIMPLE_POLYGON_POINTS {
        return Err(issue(
            Deep2dPainterIssueCode::TessellationBudgetExceeded,
            command_path,
            "Stroke outline exceeds the simple-polygon tessellation point budget.",
        ));
    }
    let half_width = command.stroke_width.expect("validated stroke width") * 0.5;
    let join = command.line_join.unwrap_or(LineJoin::Miter);
    let mut left = Vec::with_capacity(count * 2);
    let mut right = Vec::with_capacity(count * 2);
    let mut fans = Vec::new();
    for index in 0..count {
        let previous_point = subpath.points[(index + count - 1) % count];
        let point = subpath.points[index];
        let next_point = subpath.points[(index + 1) % count];
        let incoming = unit_direction(previous_point, point);
        let outgoing = unit_direction(point, next_point);
        let (Some(incoming), Some(outgoing)) = (incoming, outgoing) else {
            return Err(geometry_issue(
                command_path,
                "Closed stroke contains a near-zero segment.",
            ));
        };
        if join == LineJoin::Round {
            let turn = cross([0.0, 0.0], incoming, outgoing);
            if turn.abs() > 1e-10 {
                fans.push(round_join(point, incoming, outgoing, half_width, tolerance)?.points);
            }
        }
        append_join(
            &mut left,
            &mut right,
            point,
            incoming,
            outgoing,
            half_width,
            join,
            command.miter_limit.unwrap_or(10.0),
            1e-10,
            command_path,
        )?;
    }
    left.extend(right.into_iter().rev());
    Ok(StrokeOutline {
        outline: left,
        fans,
    })
}

#[allow(clippy::too_many_arguments)]
fn append_join(
    left: &mut Vec<Point>,
    right: &mut Vec<Point>,
    point: Point,
    previous: Point,
    next: Point,
    half_width: f64,
    join: LineJoin,
    miter_limit: f64,
    epsilon: f64,
    path: &str,
) -> Result<(), Deep2dPainterIssue> {
    let turn = cross([0.0, 0.0], previous, next);
    let dot = previous[0] * next[0] + previous[1] * next[1];
    if turn.abs() <= epsilon {
        if dot <= 0.0 {
            return Err(geometry_issue(
                path,
                "Stroke contains a 180-degree reversal.",
            ));
        }
        let offset = scale(normal(next), half_width);
        left.push(add(point, offset));
        right.push(subtract(point, offset));
        return Ok(());
    }
    let tangent_sum = add(previous, next);
    let tangent_length = tangent_sum[0].hypot(tangent_sum[1]);
    if tangent_length <= epsilon {
        return Err(geometry_issue(path, "Stroke join has an unstable tangent."));
    }
    let tangent = scale(tangent_sum, 1.0 / tangent_length);
    let miter = normal(tangent);
    let next_normal = normal(next);
    let denominator = miter[0] * next_normal[0] + miter[1] * next_normal[1];
    if denominator.abs() <= epsilon {
        return Err(geometry_issue(path, "Stroke join has an unbounded miter."));
    }
    let miter_offset = scale(miter, half_width / denominator);
    let previous_offset = scale(normal(previous), half_width);
    let next_offset = scale(next_normal, half_width);
    let miter_length = miter_offset[0].hypot(miter_offset[1]);
    let use_bevel = join == LineJoin::Bevel || miter_length > half_width * miter_limit;
    if use_bevel && turn > 0.0 {
        left.push(add(point, miter_offset));
        right.push(subtract(point, previous_offset));
        right.push(subtract(point, next_offset));
    } else if use_bevel {
        left.push(add(point, previous_offset));
        left.push(add(point, next_offset));
        right.push(subtract(point, miter_offset));
    } else {
        left.push(add(point, miter_offset));
        right.push(subtract(point, miter_offset));
    }
    Ok(())
}

fn unit_direction(start: Point, end: Point) -> Option<Point> {
    let delta = [end[0] - start[0], end[1] - start[1]];
    let length = delta[0].hypot(delta[1]);
    (length > f64::EPSILON).then(|| [delta[0] / length, delta[1] / length])
}

fn normal(direction: Point) -> Point {
    [-direction[1], direction[0]]
}

fn negate(direction: Point) -> Point {
    [-direction[0], -direction[1]]
}

fn add(a: Point, b: Point) -> Point {
    [a[0] + b[0], a[1] + b[1]]
}

fn subtract(a: Point, b: Point) -> Point {
    [a[0] - b[0], a[1] - b[1]]
}

fn scale(value: Point, factor: f64) -> Point {
    [value[0] * factor, value[1] * factor]
}

fn geometry_issue(path: &str, message: &str) -> Deep2dPainterIssue {
    issue(Deep2dPainterIssueCode::UnsupportedGeometry, path, message)
}
