#[derive(Default)]
pub struct Measurement {
    pub enabled: bool,
    pub anchor: Option<[f64; 3]>,
    pub distance: Option<f64>,
}

impl Measurement {
    pub fn clear(&mut self) {
        self.anchor = None;
        self.distance = None;
    }

    pub fn toggle(&mut self) {
        self.enabled = !self.enabled;
        self.clear();
    }

    pub fn hit(&mut self, point: [f64; 3]) {
        if !self.enabled || point.iter().any(|v| !v.is_finite()) {
            return;
        }
        if self.distance.is_some() {
            self.clear();
        }
        if let Some(anchor) = self.anchor {
            self.distance = Some(
                (0..3)
                    .map(|axis| (point[axis] - anchor[axis]).powi(2))
                    .sum::<f64>()
                    .sqrt(),
            );
        } else {
            self.anchor = Some(point);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Measurement;
    #[test]
    fn two_world_points_measure_and_third_starts_a_new_pair() {
        let mut measure = Measurement::default();
        measure.hit([0.; 3]);
        assert!(measure.anchor.is_none());
        measure.toggle();
        measure.hit([1., 2., 3.]);
        measure.hit([4., 6., 3.]);
        assert_eq!(measure.distance, Some(5.));
        measure.hit([9., 8., 7.]);
        assert_eq!(measure.anchor, Some([9., 8., 7.]));
        assert!(measure.distance.is_none());
        measure.hit([f64::NAN, 0., 0.]);
        assert_eq!(measure.anchor, Some([9., 8., 7.]));
        measure.toggle();
        assert!(!measure.enabled);
        assert!(measure.anchor.is_none());
    }
}
