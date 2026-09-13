use super::{
    Deep2dPainterIssue, Deep2dPainterIssueCode,
    painter::issue,
    painter_math::{Point, cross, extent, near, point_epsilon},
};

pub(super) const MAX_SIMPLE_POLYGON_POINTS: usize = 512;

pub(super) fn simplify_collinear(points: &mut Vec<Point>) {
    loop {
        if points.len() <= 3 {
            return;
        }
        let epsilon = point_epsilon(points);
        let size = extent(points);
        let cross_epsilon = (size * size * 1e-12).max(1e-16);
        let removable = (0..points.len()).find(|&index| {
            let previous = points[(index + points.len() - 1) % points.len()];
            let current = points[index];
            let next = points[(index + 1) % points.len()];
            near(previous, current, epsilon)
                || near(current, next, epsilon)
                || cross(previous, current, next).abs() <= cross_epsilon
        });
        let Some(index) = removable else {
            return;
        };
        points.remove(index);
    }
}

pub(super) fn triangulate_simple_polygon(
    points: &[Point],
    path: &str,
) -> Result<Vec<[usize; 3]>, Deep2dPainterIssue> {
    if points.len() < 3 || points.len() > MAX_SIMPLE_POLYGON_POINTS {
        return Err(geometry_issue(
            path,
            "Polygon point count is outside the supported budget.",
        ));
    }
    let epsilon = point_epsilon(points);
    let size = extent(points);
    let cross_epsilon = (size * size * 1e-12).max(1e-16);
    reject_degenerate_edges(points, epsilon, cross_epsilon, path)?;
    reject_self_intersections(points, epsilon, cross_epsilon, path)?;
    let area = signed_area_twice(points);
    if area.abs() <= cross_epsilon {
        return Err(geometry_issue(path, "Polygon has near-zero signed area."));
    }
    let winding = area.signum();
    let mut remaining = (0..points.len()).collect::<Vec<_>>();
    let mut triangles = Vec::with_capacity(points.len() - 2);
    while remaining.len() > 3 {
        let mut ear = None;
        for slot in 0..remaining.len() {
            let previous = remaining[(slot + remaining.len() - 1) % remaining.len()];
            let current = remaining[slot];
            let next = remaining[(slot + 1) % remaining.len()];
            if cross(points[previous], points[current], points[next]) * winding <= cross_epsilon {
                continue;
            }
            let contains_vertex = remaining.iter().copied().any(|candidate| {
                candidate != previous
                    && candidate != current
                    && candidate != next
                    && point_in_triangle(
                        points[candidate],
                        points[previous],
                        points[current],
                        points[next],
                        winding,
                        cross_epsilon,
                    )
            });
            if !contains_vertex {
                ear = Some((slot, orient_triangle([previous, current, next], winding)));
                break;
            }
        }
        let Some((slot, triangle)) = ear else {
            return Err(geometry_issue(
                path,
                "Polygon cannot be deterministically ear-clipped without a degenerate triangle.",
            ));
        };
        triangles.push(triangle);
        remaining.remove(slot);
    }
    triangles.push(orient_triangle(
        [remaining[0], remaining[1], remaining[2]],
        winding,
    ));
    Ok(triangles)
}

fn reject_degenerate_edges(
    points: &[Point],
    epsilon: f64,
    cross_epsilon: f64,
    path: &str,
) -> Result<(), Deep2dPainterIssue> {
    for index in 0..points.len() {
        let previous = points[(index + points.len() - 1) % points.len()];
        let current = points[index];
        let next = points[(index + 1) % points.len()];
        if near(current, next, epsilon) {
            return Err(geometry_issue(path, "Polygon contains a near-zero edge."));
        }
        if cross(previous, current, next).abs() <= cross_epsilon {
            return Err(geometry_issue(
                path,
                "Polygon contains a near-collinear vertex.",
            ));
        }
    }
    Ok(())
}

fn reject_self_intersections(
    points: &[Point],
    point_epsilon: f64,
    cross_epsilon: f64,
    path: &str,
) -> Result<(), Deep2dPainterIssue> {
    let count = points.len();
    for first in 0..count {
        let first_next = (first + 1) % count;
        for second in first + 1..count {
            let second_next = (second + 1) % count;
            if first_next == second || second_next == first {
                continue;
            }
            if segments_intersect(
                points[first],
                points[first_next],
                points[second],
                points[second_next],
                point_epsilon,
                cross_epsilon,
            ) {
                return Err(geometry_issue(
                    path,
                    "Polygon contains intersecting or touching edges.",
                ));
            }
        }
    }
    Ok(())
}

fn segments_intersect(
    a: Point,
    b: Point,
    c: Point,
    d: Point,
    point_epsilon: f64,
    cross_epsilon: f64,
) -> bool {
    let orientations = [
        cross(a, b, c),
        cross(a, b, d),
        cross(c, d, a),
        cross(c, d, b),
    ];
    if opposite(orientations[0], orientations[1], cross_epsilon)
        && opposite(orientations[2], orientations[3], cross_epsilon)
    {
        return true;
    }
    [(c, orientations[0]), (d, orientations[1])]
        .into_iter()
        .any(|(point, value)| {
            value.abs() <= cross_epsilon && on_segment(point, a, b, point_epsilon)
        })
        || [(a, orientations[2]), (b, orientations[3])]
            .into_iter()
            .any(|(point, value)| {
                value.abs() <= cross_epsilon && on_segment(point, c, d, point_epsilon)
            })
}

fn opposite(a: f64, b: f64, epsilon: f64) -> bool {
    (a > epsilon && b < -epsilon) || (a < -epsilon && b > epsilon)
}

fn on_segment(point: Point, start: Point, end: Point, epsilon: f64) -> bool {
    point[0] >= start[0].min(end[0]) - epsilon
        && point[0] <= start[0].max(end[0]) + epsilon
        && point[1] >= start[1].min(end[1]) - epsilon
        && point[1] <= start[1].max(end[1]) + epsilon
}

fn point_in_triangle(
    point: Point,
    a: Point,
    b: Point,
    c: Point,
    winding: f64,
    epsilon: f64,
) -> bool {
    cross(a, b, point) * winding >= -epsilon
        && cross(b, c, point) * winding >= -epsilon
        && cross(c, a, point) * winding >= -epsilon
}

fn signed_area_twice(points: &[Point]) -> f64 {
    let origin = points[0];
    (1..points.len() - 1)
        .map(|index| cross(origin, points[index], points[index + 1]))
        .sum()
}

fn orient_triangle(mut triangle: [usize; 3], winding: f64) -> [usize; 3] {
    if winding < 0.0 {
        triangle.swap(1, 2);
    }
    triangle
}

fn geometry_issue(path: &str, message: &str) -> Deep2dPainterIssue {
    issue(Deep2dPainterIssueCode::UnsupportedGeometry, path, message)
}
