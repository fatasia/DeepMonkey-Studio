//! CPU reference for the native/browser direct-light GGX contract.

const PI: f64 = std::f64::consts::PI;

pub fn direct_brdf(
    normal: [f64; 3],
    view: [f64; 3],
    light: [f64; 3],
    base_color: [f64; 3],
    metallic: f64,
    roughness: f64,
) -> [f64; 3] {
    let normal = normalize(normal, [0.0, 1.0, 0.0]);
    let view = normalize(view, normal);
    let light = normalize(light, normal);
    let half = normalize(add(view, light), normal);
    let n_dot_v = dot(normal, view).clamp(0.0001, 1.0);
    let n_dot_l = dot(normal, light).clamp(0.0, 1.0);
    let n_dot_h = dot(normal, half).clamp(0.0, 1.0);
    let v_dot_h = dot(view, half).clamp(0.0, 1.0);
    let metal = metallic.clamp(0.0, 1.0);
    let rough = roughness.clamp(0.045, 1.0);
    let alpha = rough * rough;
    let alpha2 = alpha * alpha;
    let denominator = n_dot_h * n_dot_h * (alpha2 - 1.0) + 1.0;
    let distribution = alpha2 / (PI * denominator * denominator).max(0.000001);
    let gv = n_dot_l * (alpha2 + (1.0 - alpha2) * n_dot_v * n_dot_v).sqrt();
    let gl = n_dot_v * (alpha2 + (1.0 - alpha2) * n_dot_l * n_dot_l).sqrt();
    let visibility = 0.5 / (gv + gl).max(0.000001);
    let factor = 2.0_f64.powf((-5.55473 * v_dot_h - 6.98316) * v_dot_h);
    std::array::from_fn(|index| {
        let base = base_color[index].max(0.0);
        let f0 = 0.04 * (1.0 - metal) + base * metal;
        let fresnel = f0 * (1.0 - factor) + factor;
        let specular = distribution * visibility * fresnel;
        let diffuse = (1.0 - metal) * base / PI;
        (diffuse + specular) * n_dot_l
    })
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn normalize(value: [f64; 3], fallback: [f64; 3]) -> [f64; 3] {
    let length_squared = dot(value, value);
    if !length_squared.is_finite() || length_squared <= 1.0e-8 {
        return fallback;
    }
    let inverse = length_squared.sqrt().recip();
    [value[0] * inverse, value[1] * inverse, value[2] * inverse]
}

#[cfg(test)]
mod tests {
    use super::direct_brdf;

    #[test]
    fn browser_formula_golden_is_stable_and_finite() {
        let result = direct_brdf(
            [0.0, 0.0, 1.0],
            [0.3, 0.2, 1.0],
            [-0.4, 0.1, 1.0],
            [0.8, 0.35, 0.12],
            0.42,
            0.31,
        );
        let expected = [0.390_417_792_832, 0.180_155_624_464, 0.072_688_293_964];
        for (actual, expected) in result.into_iter().zip(expected) {
            assert!((actual - expected).abs() < 1.0e-8, "{actual} != {expected}");
        }
    }

    #[test]
    fn degenerate_directions_and_extreme_materials_stay_finite() {
        for result in [
            direct_brdf([0.0; 3], [0.0; 3], [0.0; 3], [1.0; 3], -1.0, 0.0),
            direct_brdf(
                [0.0, 0.0, 1.0],
                [0.0, 0.0, -1.0],
                [0.0, 0.0, 1.0],
                [8.0; 3],
                2.0,
                4.0,
            ),
        ] {
            assert!(result.into_iter().all(f64::is_finite));
        }
    }
}
