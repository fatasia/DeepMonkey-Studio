use deep_engine_native::{
    cascaded_shadow::CascadedShadowCamera,
    mesh_abi::{CAMERA_FAR, CAMERA_FOCAL, CAMERA_NEAR, FrameUniform, frame_uniform},
    scene_bounds::SceneWorldBounds,
};
use winit::dpi::PhysicalSize;

use crate::shadow_map::ShadowMap;

pub fn frame_data(size: PhysicalSize<u32>, yaw: f32) -> FrameUniform {
    frame_uniform(size.width.max(1) as f32 / size.height.max(1) as f32, yaw)
}

pub fn shadow_camera(size: PhysicalSize<u32>, frame: &FrameUniform) -> CascadedShadowCamera {
    let eye = [frame[8][0], frame[8][1], frame[8][2]];
    CascadedShadowCamera {
        eye,
        target: [0.0; 3],
        up: [0.0, 1.0, 0.0],
        vertical_fov_radians: 2.0 * (1.0 / CAMERA_FOCAL).atan(),
        aspect: size.width.max(1) as f32 / size.height.max(1) as f32,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
    }
}

pub fn shadow_ray_direction(frame: &FrameUniform) -> [f32; 3] {
    let surface_to_light = frame[11];
    [
        -surface_to_light[0],
        -surface_to_light[1],
        -surface_to_light[2],
    ]
}

pub fn create_shadow_map(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    size: PhysicalSize<u32>,
    frame: &FrameUniform,
    scene_bounds: Option<SceneWorldBounds>,
) -> Result<ShadowMap, String> {
    ShadowMap::new(
        device,
        layout,
        frame,
        shadow_camera(size, frame),
        shadow_ray_direction(frame),
        scene_bounds,
    )
}

pub fn update_shadow_map(
    shadow_map: &mut ShadowMap,
    queue: &wgpu::Queue,
    size: PhysicalSize<u32>,
    frame: &FrameUniform,
) -> Result<(), String> {
    shadow_map.update(
        queue,
        frame,
        shadow_camera(size, frame),
        shadow_ray_direction(frame),
    )
}
