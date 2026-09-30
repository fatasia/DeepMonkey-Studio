//! Optional display math; author grading and upstream linear exposure are independent.
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OutputColorProfile {
    #[default]
    DeepAces,
    #[serde(rename = "three-aces-r185")]
    ThreeAcesR185,
}

const INPUT: [f64; 9] = [
    0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777,
];
const OUTPUT: [f64; 9] = [
    1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602,
];

fn multiply(matrix: [f64; 9], value: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|row| {
        (0..3)
            .map(|axis| matrix[row * 3 + axis] * value[axis])
            .sum()
    })
}

fn inverse(matrix: [f64; 9]) -> [f64; 9] {
    let [a, b, c, d, e, f, g, h, i] = matrix;
    let determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    [
        e * i - f * h,
        c * h - b * i,
        b * f - c * e,
        f * g - d * i,
        a * i - c * g,
        c * d - a * f,
        d * h - e * g,
        b * g - a * h,
        a * e - b * d,
    ]
    .map(|v| v / determinant)
}

fn srgb_to_linear(value: f64) -> f64 {
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

pub fn three_background_linear(srgb: [f64; 3]) -> [f64; 3] {
    if srgb == [0.0; 3] {
        return [0.0; 3];
    }
    let linear = srgb.map(srgb_to_linear);
    // RGBA16F has ten fraction bits. Select a clamp-equivalent endpoint with
    // one relative precision step of slack so input quantization cannot turn
    // exact black channels into amplified positive sRGB leakage. Interior
    // targets are unchanged; scale the slack to keep dark colors reachable.
    let endpoint_slack = linear.into_iter().fold(0.0, f64::max) / 1024.0;
    let unclamped = std::array::from_fn(|axis| match srgb[axis] {
        0.0 => -endpoint_slack,
        1.0 => 1.0 + endpoint_slack,
        _ => linear[axis],
    });
    let fitted = multiply(inverse(OUTPUT), unclamped);
    let input = fitted.map(|y| {
        let a = 1.0 - 0.983729 * y;
        let b = 0.0245786 - 0.4329510 * y;
        let c = -0.000090537 - 0.238081 * y;
        (-b + (b * b - 4.0 * a * c).sqrt()) / (2.0 * a)
    });
    multiply(inverse(INPUT), input).map(|channel| channel * 0.6)
}

/// CPU display reference: same published math, independent of shader assembly.
pub fn display_srgb(source: [f64; 3], profile: OutputColorProfile) -> [f64; 3] {
    let linear = match profile {
        OutputColorProfile::DeepAces => {
            source.map(|c| (c * (2.51 * c + 0.03) / (c * (2.43 * c + 0.59) + 0.14)).clamp(0.0, 1.0))
        }
        OutputColorProfile::ThreeAcesR185 => {
            let input = multiply(INPUT, source.map(|c| c / 0.6));
            let fitted = input.map(|c| {
                (c * (c + 0.0245786) - 0.000090537) / (c * (0.983729 * c + 0.4329510) + 0.238081)
            });
            multiply(OUTPUT, fitted).map(|c| c.clamp(0.0, 1.0))
        }
    };
    linear.map(|c| {
        if c <= 0.0031308 {
            c * 12.92
        } else {
            1.055 * c.powf(1.0 / 2.4) - 0.055
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_background_primary_and_gray_reachable_without_positive_clamp() {
        for color in [
            [0.0; 3],
            [1.0; 3],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.5; 3],
            [0.1, 0.2, 0.3],
            [0.0, 0.5, 1.0],
        ] {
            let hdr = three_background_linear(color);
            let actual = display_srgb(hdr, OutputColorProfile::ThreeAcesR185);
            assert!(hdr.iter().all(|c| c.is_finite()));
            for axis in 0..3 {
                assert!((actual[axis] - color[axis]).abs() < 1e-12);
            }
        }
        assert!(three_background_linear([0.0, 1.0, 0.0])[0] < 0.0);
    }

    #[test]
    fn profile_wire_rejects_unknown_and_keeps_deep_default() {
        assert_eq!(OutputColorProfile::default(), OutputColorProfile::DeepAces);
        assert_eq!(
            serde_json::from_str::<OutputColorProfile>("\"three-aces-r185\"").unwrap(),
            OutputColorProfile::ThreeAcesR185
        );
        assert!(serde_json::from_str::<OutputColorProfile>("\"native-aces-grading-v9\"").is_err());
    }

    #[test]
    fn three_background_endpoint_slack_preserves_dark_and_interior_targets() {
        let values = [0.0, 1e-10, 0.001, 0.04, 0.25, 0.5, 0.99, 1.0];
        for r in values {
            for g in values {
                for b in values {
                    let color = [r, g, b];
                    let hdr = three_background_linear(color);
                    assert!(hdr.iter().all(|c| c.is_finite()));
                    let actual = display_srgb(hdr, OutputColorProfile::ThreeAcesR185);
                    for axis in 0..3 {
                        assert!((actual[axis] - color[axis]).abs() < 1e-12);
                    }
                }
            }
        }
    }
}
