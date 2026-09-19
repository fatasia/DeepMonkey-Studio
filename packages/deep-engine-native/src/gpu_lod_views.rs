use bytemuck::cast_slice;
use deep_engine_native::{culling_contract::frustum_planes, mesh_abi::FrameUniform};
use winit::dpi::PhysicalSize;

use crate::shadow_map::ShadowViewSource;

pub fn pack_views(
    frame: &FrameUniform,
    size: PhysicalSize<u32>,
    shadows: &impl ShadowViewSource,
    count: u32,
    near: f32,
) -> Result<Vec<[u8; 160]>, String> {
    let main_matrix = frame[..4]
        .try_into()
        .map_err(|_| "native LOD camera ABI mismatch")?;
    let eye = frame[8];
    let focal = (0..3)
        .map(|axis| frame[axis][1].powi(2))
        .sum::<f32>()
        .sqrt();
    // 透视矩阵的 w 行给出观察方向；相机位置不能推导非原点目标的方向。
    let forward = [frame[0][3], frame[1][3], frame[2][3], 0.0];
    let mut views = vec![pack(
        frustum_planes(main_matrix)?,
        eye,
        forward,
        [count, 1, 0, 0],
        [size.height as f32 * focal * 0.5, near, 0.0, 0.0],
    )];
    for index in 0..shadows.shadow_view_count() as usize {
        let matrix = shadows.shadow_view_projection(index);
        let scale = (matrix[0][1].powi(2) + matrix[1][1].powi(2) + matrix[2][1].powi(2)).sqrt();
        if index >= shadows.cascade_count() as usize {
            let slot = (index - shadows.cascade_count() as usize + 1) as f32;
            let light = (0..16)
                .find(|light| {
                    let start = frame[18 + light * 4][2];
                    let count = if frame[16 + light * 4][3] == 2.0 {
                        6.0
                    } else {
                        1.0
                    };
                    start > 0.0 && slot >= start && slot < start + count
                })
                .ok_or("local shadow LOD view has no light binding")?;
            let position = frame[15 + light * 4];
            let direction = [matrix[0][3], matrix[1][3], matrix[2][3], 0.0];
            let far = if position[3] > 0.0 {
                position[3]
            } else {
                500.0
            };
            views.push(pack(
                frustum_planes(matrix)?,
                [position[0], position[1], position[2], 1.0],
                [direction[0], direction[1], direction[2], 0.0],
                [count, 1, 1, 0],
                [
                    shadows.shadow_map_size() as f32 * 0.5 * scale,
                    (far * 0.001).clamp(0.0001, 0.05),
                    0.0,
                    0.0,
                ],
            ));
            continue;
        }
        views.push(pack(
            frustum_planes(matrix)?,
            [0.0; 4],
            [0.0; 4],
            [count, 2, 1, 0],
            [
                shadows.shadow_map_size() as f32 * 0.5 * scale,
                0.0,
                0.0,
                0.0,
            ],
        ));
    }
    Ok(views)
}

#[cfg(test)]
#[path = "gpu_lod_views_tests.rs"]
mod tests;

fn pack(
    planes: [[f32; 4]; 6],
    eye: [f32; 4],
    forward: [f32; 4],
    params: [u32; 4],
    projection: [f32; 4],
) -> [u8; 160] {
    let mut bytes = [0; 160];
    bytes[..96].copy_from_slice(cast_slice(&planes));
    bytes[96..112].copy_from_slice(cast_slice(&eye));
    bytes[112..128].copy_from_slice(cast_slice(&forward));
    bytes[128..144].copy_from_slice(cast_slice(&params));
    bytes[144..].copy_from_slice(cast_slice(&projection));
    bytes
}
