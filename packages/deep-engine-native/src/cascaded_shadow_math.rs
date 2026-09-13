use crate::cascaded_shadow::{CascadedShadowCamera, Matrix4};

pub(crate) fn practical_splits(near: f32, far: f32, count: usize, lambda: f32) -> Vec<f32> {
    (1..=count)
        .map(|index| {
            if index == count {
                return far;
            }
            let ratio = index as f32 / count as f32;
            let logarithmic = near * (far / near).powf(ratio);
            let uniform = near + (far - near) * ratio;
            logarithmic * lambda + uniform * (1.0 - lambda)
        })
        .collect()
}

pub(crate) fn frustum_corners(
    camera: CascadedShadowCamera,
    forward: [f32; 3],
    right: [f32; 3],
    up: [f32; 3],
    near: f32,
    far: f32,
) -> [[f32; 3]; 8] {
    let mut out = [[0.0; 3]; 8];
    let tangent = (camera.vertical_fov_radians * 0.5).tan();
    let mut index = 0;
    for depth in [near, far] {
        let center = add(camera.eye, scale(forward, depth));
        let half_height = tangent * depth;
        let half_width = half_height * camera.aspect;
        for y in [-1.0, 1.0] {
            for x in [-1.0, 1.0] {
                out[index] = add(
                    add(center, scale(right, x * half_width)),
                    scale(up, y * half_height),
                );
                index += 1;
            }
        }
    }
    out
}

pub(crate) fn quantized_radius(center: [f32; 3], corners: &[[f32; 3]; 8]) -> f32 {
    let raw = corners
        .iter()
        .map(|corner| length(sub(*corner, center)))
        .fold(0.0_f32, f32::max);
    (raw * 16.0).ceil().max(1.0) / 16.0
}

pub(crate) fn snap_light_center(
    center: [f32; 3],
    ray: [f32; 3],
    texel: f32,
) -> Result<[f32; 3], String> {
    let backward = scale(ray, -1.0);
    let up = if backward[1].abs() > 0.98 {
        [0.0, 0.0, 1.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let right = normalize(cross(up, backward))?;
    let corrected_up = cross(backward, right);
    let x = (dot(center, right) / texel).round() * texel;
    let y = (dot(center, corrected_up) / texel).round() * texel;
    Ok(add(
        add(scale(right, x), scale(corrected_up, y)),
        scale(backward, dot(center, backward)),
    ))
}

pub(crate) fn average(values: &[[f32; 3]; 8]) -> [f32; 3] {
    scale(values.iter().copied().fold([0.0; 3], add), 1.0 / 8.0)
}

pub(crate) fn orthographic(radius: f32, near: f32, far: f32) -> Matrix4 {
    [
        [1.0 / radius, 0.0, 0.0, 0.0],
        [0.0, 1.0 / radius, 0.0, 0.0],
        [0.0, 0.0, 1.0 / (near - far), 0.0],
        [0.0, 0.0, near / (near - far), 1.0],
    ]
}

pub(crate) fn look_at(eye: [f32; 3], target: [f32; 3], up: [f32; 3]) -> Result<Matrix4, String> {
    let z = normalize(sub(eye, target))?;
    let x = normalize(cross(up, z))?;
    let y = cross(z, x);
    Ok([
        [x[0], y[0], z[0], 0.0],
        [x[1], y[1], z[1], 0.0],
        [x[2], y[2], z[2], 0.0],
        [-dot(x, eye), -dot(y, eye), -dot(z, eye), 1.0],
    ])
}

pub(crate) fn multiply(a: Matrix4, b: Matrix4) -> Matrix4 {
    let mut out = [[0.0; 4]; 4];
    for column in 0..4 {
        for row in 0..4 {
            for k in 0..4 {
                out[column][row] += a[k][row] * b[column][k];
            }
        }
    }
    out
}

pub(crate) fn normalize(value: [f32; 3]) -> Result<[f32; 3], String> {
    let length = length(value);
    if !length.is_finite() || length < 1e-8 {
        return Err("direction is degenerate".into());
    }
    Ok(scale(value, 1.0 / length))
}

fn length(value: [f32; 3]) -> f32 {
    dot(value, value).sqrt()
}

pub(crate) fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub(crate) fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn scale(value: [f32; 3], scalar: f32) -> [f32; 3] {
    [value[0] * scalar, value[1] * scalar, value[2] * scalar]
}

pub(crate) fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
