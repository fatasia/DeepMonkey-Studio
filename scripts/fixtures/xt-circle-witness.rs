//! Analytic source-circle points, independent of CAD lowering and tessellation.
pub fn circle_points(
    center: [f64; 3],
    axis: [f64; 3],
    reference: [f64; 3],
    radius: f64,
) -> Option<Vec<[f64; 3]>> {
    fn unit(v: [f64; 3]) -> Option<[f64; 3]> {
        let length = v.iter().map(|x| x * x).sum::<f64>().sqrt();
        (length.is_finite() && length > 0.0).then(|| v.map(|x| x / length))
    }
    if !center.iter().all(|x| x.is_finite()) || !radius.is_finite() || radius <= 0.0 {
        return None;
    }
    let n = unit(axis)?;
    let x = unit(reference)?;
    if n.iter().zip(x).map(|(a, b)| a * b).sum::<f64>().abs() > 1e-8 {
        return None;
    }
    let y = [
        n[1] * x[2] - n[2] * x[1],
        n[2] * x[0] - n[0] * x[2],
        n[0] * x[1] - n[1] * x[0],
    ];
    Some(
        (0..16)
            .map(|i| {
                let angle = std::f64::consts::TAU * i as f64 / 16.0;
                std::array::from_fn(|k| {
                    (center[k] + radius * (x[k] * angle.cos() + y[k] * angle.sin())) * 1000.0
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_circle_is_oriented_translated_and_millimetric() {
        let points = circle_points([1., 2., 3.], [2., 0., 0.], [0., 0., -3.], 0.004).unwrap();
        assert_eq!(points.len(), 16);
        for p in points {
            assert!((p[0] - 1000.).abs() < 1e-9);
            assert!(((p[1] - 2000.).hypot(p[2] - 3000.) - 4.).abs() < 1e-9);
        }
    }
    #[test]
    fn invalid_source_frames_are_not_repaired() {
        for (axis, reference, radius) in [
            ([0.; 3], [1., 0., 0.], 1.),
            ([0., 0., 1.], [0.; 3], 1.),
            ([0., 0., 1.], [0., 0., 1.], 1.),
            ([0., 0., 1.], [1., 0., 0.], 0.),
            ([0., 0., 1.], [1., 0., 0.], f64::NAN),
        ] {
            assert!(circle_points([0.; 3], axis, reference, radius).is_none());
        }
    }
}
