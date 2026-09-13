use bytemuck::cast_slice;
use deep_engine_native::{
    culling_contract::frustum_planes,
    mesh_abi::{CAMERA_FOCAL, CAMERA_NEAR, FrameUniform},
};
use winit::dpi::PhysicalSize;

use crate::shadow_map::ShadowViewSource;

pub fn pack_views(
    frame: &FrameUniform,
    size: PhysicalSize<u32>,
    shadows: &impl ShadowViewSource,
    count: u32,
) -> Result<Vec<[u8; 160]>, String> {
    let main_matrix = frame[..4]
        .try_into()
        .map_err(|_| "native LOD camera ABI mismatch")?;
    let eye = frame[8];
    let length = (eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2]).sqrt();
    let forward = [-eye[0] / length, -eye[1] / length, -eye[2] / length, 0.0];
    let mut views = vec![pack(
        frustum_planes(main_matrix)?,
        eye,
        forward,
        [count, 1, 0, 0],
        [
            size.height as f32 * CAMERA_FOCAL * 0.5,
            CAMERA_NEAR,
            0.0,
            0.0,
        ],
    )];
    for index in 0..shadows.cascade_count() as usize {
        let matrix = shadows.cascade_view_projection(index);
        let scale = (matrix[0][1].powi(2) + matrix[1][1].powi(2) + matrix[2][1].powi(2)).sqrt();
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
