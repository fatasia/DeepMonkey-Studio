//! Keyhole bridging: splices a hole ring into an outer ring so the combined
//! ring stays strictly simple and the existing ear clipper applies.

use super::{
    Deep2dPainterIssue,
    painter_math::{Point, extent, near, point_epsilon},
    painter_polygon::{geometry_issue, segments_intersect, signed_area_twice},
};

/// Bridges one hole ring into an outer ring with a zero-area keyhole slit so
/// the combined ring stays simple and the existing ear clipper applies.
/// The hole winding is normalized against the outer ring so nonzero and
/// evenodd fill rules agree for single-level holes.
pub(super) fn bridge_hole(
    outer: &[Point],
    hole: &[Point],
    path: &str,
) -> Result<Vec<Point>, Deep2dPainterIssue> {
    if hole.len() < 3 {
        return Err(geometry_issue(
            path,
            "Hole polygons need at least three points.",
        ));
    }
    let outer_area = signed_area_twice(outer);
    let mut hole = hole.to_vec();
    if outer_area.signum() * signed_area_twice(&hole).signum() > 0.0 {
        hole.reverse();
    }
    let (hole_index, &hole_point) = hole
        .iter()
        .enumerate()
        .max_by(|a, b| {
            (a.1[0])
                .total_cmp(&b.1[0])
                .then((a.1[1]).total_cmp(&b.1[1]))
        })
        .expect("non-empty hole");
    let mut order: Vec<usize> = (0..outer.len()).collect();
    order.sort_by(|&first, &second| {
        let distance =
            |point: Point| (point[0] - hole_point[0]).powi(2) + (point[1] - hole_point[1]).powi(2);
        distance(outer[first]).total_cmp(&distance(outer[second]))
    });
    let epsilon = point_epsilon(outer);
    for &outer_index in order.iter() {
        let outer_point = outer[outer_index];
        if near(outer_point, hole_point, epsilon) {
            continue;
        }
        let bridge = [hole_point, outer_point];
        let clear = outer
            .iter()
            .zip(outer.iter().skip(1).cycle().take(outer.len()))
            .chain(
                hole.iter()
                    .zip(hole.iter().skip(1).cycle().take(hole.len())),
            )
            .all(|(start, end)| {
                let touches_endpoints = near(*start, bridge[0], epsilon)
                    || near(*start, bridge[1], epsilon)
                    || near(*end, bridge[0], epsilon)
                    || near(*end, bridge[1], epsilon);
                !segments_intersect(
                    *start,
                    *end,
                    bridge[0],
                    bridge[1],
                    epsilon,
                    (extent(outer).powi(2) * 1e-12).max(1e-16),
                ) || touches_endpoints
            });
        if !clear {
            continue;
        }
        // Split the bridge vertex by a sub-visual epsilon so the ring stays
        // strictly simple (a plain keyhole touches itself at the hole vertex).
        let direction = [
            outer_point[0] - hole_point[0],
            outer_point[1] - hole_point[1],
        ];
        let length = (direction[0] * direction[0] + direction[1] * direction[1])
            .sqrt()
            .max(1e-9);
        let delta = epsilon.max(1e-9) * 4.0;
        let normal = [-direction[1] / length, direction[0] / length];
        let enter = [
            hole_point[0] - normal[0] * delta,
            hole_point[1] - normal[1] * delta,
        ];
        let exit = [
            hole_point[0] + normal[0] * delta,
            hole_point[1] + normal[1] * delta,
        ];
        let mut ring = Vec::with_capacity(outer.len() + hole.len() + 2);
        ring.extend_from_slice(&outer[..=outer_index]);
        ring.push(enter);
        for step in 1..hole.len() {
            ring.push(hole[(hole_index + step) % hole.len()]);
        }
        ring.push(exit);
        ring.extend_from_slice(&outer[outer_index + 1..]);
        return Ok(ring);
    }
    Err(geometry_issue(
        path,
        "Hole polygon has no visible bridge vertex to the outer ring.",
    ))
}
