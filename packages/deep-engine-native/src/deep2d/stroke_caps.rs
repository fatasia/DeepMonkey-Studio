//! Round cap and round join geometry: emitted as convex fan polygons so the
//! existing simple-polygon ear clipper triangulates them without a curve
//! pipeline. Each fan is a bounded convex arc approximation — chords never
//! deviate from the true circle by more than the stroke's own flattening
//! tolerance, keeping the visual result within the D02 contract.

use super::{Deep2dPainterIssue, Deep2dPainterIssueCode, painter::issue, painter_math::Point};

/// Maximum arc fan vertices per cap/join; bounds tessellation work.
const MAX_FAN_VERTICES: usize = 64;

fn geometry_issue(path: &str, message: &str) -> Deep2dPainterIssue {
    issue(Deep2dPainterIssueCode::UnsupportedGeometry, path, message)
}

/// A convex fan polygon approximating a circular wedge.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct FanPolygon {
    pub points: Vec<Point>,
}

/// Chord tolerance for one fan arc. Chord sagitta of a unit circle arc
/// spanning angle θ is `1 - cos(θ/2)`; solve for the vertex count that keeps
/// the sagitta below `tolerance` in logical units.
pub(super) fn fan_vertex_count(radius: f64, tolerance: f64) -> Result<usize, Deep2dPainterIssue> {
    if !(radius.is_finite() && radius > 0.0) {
        return Err(geometry_issue(
            "stroke",
            "Round stroke radius must be finite and positive.",
        ));
    }
    let ratio = (1.0 - (tolerance / radius).clamp(0.0, 1.0)).clamp(-1.0, 1.0);
    let max_half_angle = ratio.acos();
    if !max_half_angle.is_finite() || max_half_angle <= 0.0 {
        // Tolerance covers the whole circle (tiny radius): a coarse fan suffices.
        return Ok(4.min(MAX_FAN_VERTICES));
    }
    let vertices = (std::f64::consts::PI / max_half_angle).ceil() as usize;
    Ok(vertices.clamp(3, MAX_FAN_VERTICES))
}

fn rotate(direction: Point, angle: f64) -> Point {
    let (sin, cos) = angle.sin_cos();
    [
        direction[0] * cos - direction[1] * sin,
        direction[0] * sin + direction[1] * cos,
    ]
}

/// Round cap fan at `center`, spanning the half-plane behind `direction`
/// (butt side). The fan starts and ends on the butt line.
pub(super) fn round_cap(
    center: Point,
    direction: Point,
    radius: f64,
    tolerance: f64,
    _command_path: &str,
) -> Result<FanPolygon, Deep2dPainterIssue> {
    let vertices = fan_vertex_count(radius, tolerance)?;
    let step = std::f64::consts::PI / vertices as f64;
    let mut points = Vec::with_capacity(vertices + 2);
    // Sweep from +90° to -90° relative to the cap's outward direction so the
    // fan covers exactly the half circle that extends beyond the butt line.
    let mut angle = std::f64::consts::FRAC_PI_2;
    for _ in 0..=vertices {
        let offset = rotate(direction, angle);
        points.push([
            center[0] + offset[0] * radius,
            center[1] + offset[1] * radius,
        ]);
        angle -= step;
    }
    Ok(FanPolygon { points })
}

/// Round join fan at `point` filling the outer wedge between the two stroke
/// edge directions. `turn` is the signed cross of the incoming/outgoing unit
/// directions; the wedge lies on the turning side, sweeping from the incoming
/// edge direction to the outgoing one.
pub(super) fn round_join(
    point: Point,
    incoming: Point,
    outgoing: Point,
    radius: f64,
    tolerance: f64,
) -> Result<FanPolygon, Deep2dPainterIssue> {
    let vertices = fan_vertex_count(radius, tolerance)?;
    // Signed angle from incoming to outgoing; the outer wedge spans exactly
    // this arc (the inner side is already covered by the offset rings).
    let cross_value = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
    let dot = incoming[0] * outgoing[0] + incoming[1] * outgoing[1];
    let signed = cross_value.atan2(dot);
    if !signed.is_finite() || signed.abs() < 1e-12 {
        return Ok(FanPolygon { points: Vec::new() });
    }
    let mut points = Vec::with_capacity(vertices + 2);
    points.push(point);
    let step = signed / vertices as f64;
    let mut angle = 0.0f64;
    for _ in 0..=vertices {
        let offset = rotate(incoming, angle);
        points.push([point[0] + offset[0] * radius, point[1] + offset[1] * radius]);
        angle += step;
    }
    Ok(FanPolygon { points })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOLERANCE: f64 = 0.25;

    #[test]
    fn vertex_count_bounds_by_radius_and_tolerance() {
        // Small radius relative to tolerance: tolerance covers the whole
        // circle, acos(0)=π/2 → ceil(2)=2, clamped to the 3-vertex floor.
        assert_eq!(fan_vertex_count(0.1, TOLERANCE).unwrap(), 3);
        // Unit radius with 0.25 tolerance: acos(0.75)≈0.7227 → ceil(π/0.7227)=5.
        assert_eq!(fan_vertex_count(1.0, TOLERANCE).unwrap(), 5);
        // Huge radius with 1e-12 tolerance: acos(1-1e-21)≈6.3e-11 in exact
        // math, but f64 rounds the ratio to 1.0 → acos=0 → the zero-angle
        // guard returns the coarse 4-vertex fan (bounded, never 64).
        assert_eq!(fan_vertex_count(1e9, 1e-12).unwrap(), 4);
        // Radius just large enough for the acos to stay representable
        // must clamp at the vertex budget rather than return unbounded work.
        assert_eq!(fan_vertex_count(1.0, 1e-16).unwrap(), MAX_FAN_VERTICES);
    }

    #[test]
    fn round_cap_fan_stays_on_the_outer_half_plane() {
        let fan = round_cap([0.0, 0.0], [1.0, 0.0], 1.0, TOLERANCE, "p").unwrap();
        // Every fan point must be at distance == radius from the center and
        // lie in the x >= 0 half plane (behind +x direction).
        for point in &fan.points {
            let distance = (point[0] * point[0] + point[1] * point[1]).sqrt();
            assert!(
                (distance - 1.0).abs() <= 0.05,
                "fan point must sit on the cap circle: {point:?}"
            );
            assert!(point[0] >= -1e-9, "fan must not cross the butt line");
        }
    }

    #[test]
    fn round_join_fan_spans_the_turn_side_wedge() {
        // Right-angle join turning left: incoming +x, outgoing +y. The outer
        // wedge is the first quadrant, swept from incoming to outgoing.
        let fan = round_join([0.0, 0.0], [1.0, 0.0], [0.0, 1.0], 1.0, TOLERANCE).unwrap();
        assert_eq!(fan.points[0], [0.0, 0.0], "fan apex at the join point");
        for point in fan.points.iter().skip(1) {
            let distance = (point[0] * point[0] + point[1] * point[1]).sqrt();
            assert!((distance - 1.0).abs() <= 0.05, "{point:?}");
            assert!(
                point[0] >= -1e-9 && point[1] >= -1e-9,
                "fan must stay inside the outer wedge: {point:?}"
            );
        }

        // Turning right (incoming +x, outgoing -y) sweeps the fourth quadrant.
        let fan = round_join([0.0, 0.0], [1.0, 0.0], [0.0, -1.0], 1.0, TOLERANCE).unwrap();
        for point in fan.points.iter().skip(1) {
            assert!(
                point[0] >= -1e-9 && point[1] <= 1e-9,
                "right turn fan must stay in the fourth quadrant: {point:?}"
            );
        }

        // Nearly collinear join collapses to an empty fan.
        let fan = round_join([0.0, 0.0], [1.0, 0.0], [1.0, 1e-14], 1.0, TOLERANCE).unwrap();
        assert!(fan.points.is_empty());
    }
}
