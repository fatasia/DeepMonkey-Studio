use serde_json::Value;
pub const FIXTURE: &str = include_str!("../../../deep-engine/fixtures/j2-csm-parity-v1.json");
pub fn list(fixture: &Value, key: &str) -> Vec<f64> {
    fixture[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect()
}
pub fn visibility(f: &Value, filter: &str, edge: bool, blend: f64, depth: f64, u: f64) -> f64 {
    let size = f["size"].as_f64().unwrap();
    let texel = |layer: usize, x: f64| {
        let x = x.clamp(0.0, size - 1.0);
        let stored = if edge && x >= size / 2.0 {
            f["edgeRightDepths"][layer].as_f64().unwrap()
        } else {
            f["clearDepths"][layer].as_f64().unwrap()
        };
        if f["receiverDepth"].as_f64().unwrap() <= stored {
            1.0
        } else {
            0.0
        }
    };
    let sample = |layer: usize| {
        let mut sum = 0.0;
        for _y in -1..=1 {
            for x in -1..=1 {
                let coord = u + f64::from(x) / size;
                sum += if filter == "nearest" {
                    texel(layer, (coord * size).floor())
                } else {
                    let center = coord * size - 0.5;
                    let left = center.floor();
                    let t = center - left;
                    texel(layer, left) * (1.0 - t) + texel(layer, left + 1.0) * t
                };
            }
        }
        sum / 9.0
    };
    if depth > 4.0 {
        return 1.0;
    }
    if depth > 2.0 {
        return sample(1);
    }
    let current = sample(0);
    if blend >= 2.0 || depth <= blend {
        return current;
    }
    let t = ((depth - blend) / (2.0 - blend)).clamp(0.0, 1.0);
    let weight = t * t * (3.0 - 2.0 * t);
    current * (1.0 - weight) + sample(1) * weight
}
#[test]
fn cpu_seven_point_and_linear_pcf_edges() {
    let f: Value = serde_json::from_str(FIXTURE).unwrap();
    for blend in list(&f, "blendStarts") {
        let expected = if blend == 2.0 {
            vec![1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0]
        } else {
            vec![1.0, 1.0, 0.5, 0.0, 0.0, 0.0, 1.0]
        };
        for (depth, expected) in list(&f, "depths").iter().zip(expected) {
            assert!((visibility(&f, "linear", false, blend, *depth, 0.5) - expected).abs() < 1e-12);
        }
    }
    let linear = visibility(&f, "linear", true, 2.0, 1.0, 0.4375);
    let nearest = visibility(&f, "nearest", true, 2.0, 1.0, 0.4375);
    assert!((linear - 7.0 / 12.0).abs() < 1e-12);
    assert!((nearest - 2.0 / 3.0).abs() < 1e-12);
    assert!(
        (linear - nearest).abs() > 0.05,
        "wrong-filter negative control must be detectable"
    );
}
