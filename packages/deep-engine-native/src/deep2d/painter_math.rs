use super::Deep2dMatrix;

pub(super) type Point = [f64; 2];

pub(super) fn transform_point(point: Point, matrix: Deep2dMatrix) -> Point {
    [
        matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
        matrix[1] * point[0] + matrix[3] * point[1] + matrix[5],
    ]
}

pub(super) fn cross(a: Point, b: Point, c: Point) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

pub(super) fn extent(points: &[Point]) -> f64 {
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for point in points {
        for axis in 0..2 {
            min[axis] = min[axis].min(point[axis]);
            max[axis] = max[axis].max(point[axis]);
        }
    }
    (max[0] - min[0]).max(max[1] - min[1]).max(1e-9)
}

pub(super) fn point_epsilon(points: &[Point]) -> f64 {
    (extent(points) * 1e-12).max(1e-10)
}

pub(super) fn near(a: Point, b: Point, epsilon: f64) -> bool {
    (a[0] - b[0]).hypot(a[1] - b[1]) <= epsilon
}

pub(super) fn line_distance(point: Point, start: Point, end: Point) -> f64 {
    let delta = [end[0] - start[0], end[1] - start[1]];
    let length = delta[0].hypot(delta[1]);
    if length <= f64::EPSILON {
        return (point[0] - start[0]).hypot(point[1] - start[1]);
    }
    cross(start, end, point).abs() / length
}

pub(super) fn midpoint(a: Point, b: Point) -> Point {
    [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5]
}
