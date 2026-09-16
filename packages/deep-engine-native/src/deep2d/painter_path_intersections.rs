use super::{
    Deep2dPainterIssue, Deep2dPainterIssueCode, painter::issue, painter_math::Point,
    painter_path::LinearSubPath,
};

/// Bounds the quadratic validation cost. Oversized paths fail closed.
const MAX_INTERSECTION_CHECK_SEGMENTS: usize = 2048;

pub(super) fn reject_self_intersections(
    subpath: &LinearSubPath,
    command_path: &str,
) -> Result<(), Deep2dPainterIssue> {
    let segments = subpath.segments();
    let limit = MAX_INTERSECTION_CHECK_SEGMENTS;
    if segments.len() > limit {
        return Err(issue(
            Deep2dPainterIssueCode::TessellationBudgetExceeded,
            command_path,
            &format!("Subpath exceeds the {limit} segment budget for the self-intersection check."),
        ));
    }
    for (a, pair_a) in segments.iter().enumerate() {
        for (b, pair_b) in segments.iter().enumerate().skip(a + 1) {
            if adjacent(a, b, segments.len()) {
                continue;
            }
            if segments_properly_intersect(pair_a, pair_b) {
                return Err(issue(
                    Deep2dPainterIssueCode::UnsupportedGeometry,
                    command_path,
                    "Subpath is self-intersecting; simple polygons only.",
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn reject_cross_subpath_intersections(
    subpaths: &[LinearSubPath],
    command_path: &str,
) -> Result<(), Deep2dPainterIssue> {
    let total: usize = subpaths
        .iter()
        .map(|subpath| subpath.segments().len())
        .sum();
    let limit = MAX_INTERSECTION_CHECK_SEGMENTS;
    if total > limit {
        return Err(issue(
            Deep2dPainterIssueCode::TessellationBudgetExceeded,
            command_path,
            &format!("Path exceeds the {limit} segment budget for the disjointness check."),
        ));
    }
    for (a_index, subpath_a) in subpaths.iter().enumerate() {
        for subpath_b in &subpaths[a_index + 1..] {
            for pair_a in subpath_a.segments() {
                for pair_b in subpath_b.segments() {
                    if segments_properly_intersect(&pair_a, &pair_b) {
                        return Err(issue(
                            Deep2dPainterIssueCode::UnsupportedGeometry,
                            command_path,
                            "Subpaths must be mutually disjoint.",
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

fn adjacent(a: usize, b: usize, count: usize) -> bool {
    let (low, high) = if a < b { (a, b) } else { (b, a) };
    high - low == 1 || (low == 0 && high == count - 1)
}

fn segments_properly_intersect(a: &[Point; 2], b: &[Point; 2]) -> bool {
    let d1 = cross2(b[0], b[1], a[0]);
    let d2 = cross2(b[0], b[1], a[1]);
    let d3 = cross2(a[0], a[1], b[0]);
    let d4 = cross2(a[0], a[1], b[1]);
    ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0))
        && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
}

fn cross2(segment_start: Point, segment_end: Point, point: Point) -> f64 {
    (segment_end[0] - segment_start[0]) * (point[1] - segment_start[1])
        - (segment_end[1] - segment_start[1]) * (point[0] - segment_start[0])
}
