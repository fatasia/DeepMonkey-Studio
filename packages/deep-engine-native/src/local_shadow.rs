//! 聚光灯投影矩阵；与 CSM 共用右手、WebGPU 0..1 深度约定。
use crate::{
    cascaded_shadow_math::{look_at, multiply},
    local_lighting::{LocalLight, LocalLightKind},
    mesh_abi::FrameUniform,
};
pub const MAX_SPOT_SHADOWS: usize = 4;
pub const MAX_LOCAL_SHADOW_VIEWS: usize = 10;
pub const MATRIX_ROW: usize = 79;
pub type Matrix = [[f32; 4]; 4];
pub const POINT_DIRECTIONS: [[f32; 3]; 6] = [
    [1.0, 0.0, 0.0],
    [-1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, -1.0, 0.0],
    [0.0, 0.0, 1.0],
    [0.0, 0.0, -1.0],
];
pub fn validate_budget(lights: &[LocalLight]) -> bool {
    lights
        .iter()
        .filter(|light| light.cast_shadow && light.kind == LocalLightKind::Spot)
        .count()
        <= MAX_SPOT_SHADOWS
        && lights
            .iter()
            .filter(|light| light.cast_shadow && light.kind == LocalLightKind::Point)
            .count()
            <= 1
}
pub fn matrices(light: LocalLight) -> Result<Vec<Matrix>, String> {
    if light.kind == LocalLightKind::Point {
        POINT_DIRECTIONS
            .into_iter()
            .map(|direction| projection(light, direction, 1.0))
            .collect()
    } else {
        Ok(vec![spot_matrix(light)?])
    }
}

pub fn spot_matrix(light: LocalLight) -> Result<Matrix, String> {
    if !light.validate() || light.outer_cos <= 0.001 || light.outer_cos >= 0.999999 {
        return Err("spot shadow requires a finite nondegenerate cone".into());
    }
    projection(
        light,
        light.direction,
        light.outer_cos / (1.0 - light.outer_cos * light.outer_cos).sqrt(),
    )
}
fn projection(light: LocalLight, direction: [f32; 3], focal: f32) -> Result<Matrix, String> {
    if !light.validate() {
        return Err("invalid local shadow light".into());
    }
    let far = if light.range > 0.0 {
        light.range
    } else {
        500.0
    };
    let near = (far * 0.001).clamp(0.0001, 0.05);
    if far <= near {
        return Err("spot shadow range is too small".into());
    }
    let projection = [
        [focal, 0.0, 0.0, 0.0],
        [0.0, focal, 0.0, 0.0],
        [0.0, 0.0, far / (near - far), -1.0],
        [0.0, 0.0, near * far / (near - far), 0.0],
    ];
    let target = std::array::from_fn(|i| light.position[i] + direction[i]);
    let up = if direction[1].abs() > 0.99 {
        [0.0, 0.0, 1.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    Ok(multiply(projection, look_at(light.position, target, up)?))
}

pub fn frame_matrices(frame: &FrameUniform) -> Vec<Matrix> {
    (0..(frame[14][3] as usize).min(MAX_LOCAL_SHADOW_VIEWS))
        .map(|index| {
            frame[MATRIX_ROW + index * 4..MATRIX_ROW + (index + 1) * 4]
                .try_into()
                .unwrap()
        })
        .collect()
}
#[cfg(test)]
#[path = "local_shadow_tests.rs"]
mod tests;
