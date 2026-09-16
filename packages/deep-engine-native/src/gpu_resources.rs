use deep_engine_native::{
    cascaded_shadow::CascadedShadowCamera,
    fog::FogSettings,
    mesh_abi::{FrameUniform, frame_uniform},
    scene_bounds::SceneWorldBounds,
};
use winit::dpi::PhysicalSize;

use crate::shadow_map::ShadowMap;

pub fn frame_data(size: PhysicalSize<u32>, yaw: f32) -> FrameUniform {
    frame_uniform(size.width.max(1) as f32 / size.height.max(1) as f32, yaw)
}

pub fn frame_data_with_fog(size: PhysicalSize<u32>, yaw: f32, fog: FogSettings) -> FrameUniform {
    let mut frame = frame_data(size, yaw);
    frame[12] = fog.frame_tuning();
    frame
}

#[cfg(test)]
pub fn frame_data_with_view(
    size: PhysicalSize<u32>,
    yaw: f32,
    target: [f32; 3],
    distance: f32,
    fog: FogSettings,
) -> FrameUniform {
    frame_data_with_camera(
        size,
        deep_engine_native::player_view::PlayerView {
            yaw,
            target,
            distance,
            ..Default::default()
        },
        fog,
    )
}

pub fn frame_data_with_camera(
    size: PhysicalSize<u32>,
    view: deep_engine_native::player_view::PlayerView,
    fog: FogSettings,
) -> FrameUniform {
    let mut frame = frame_data_with_fog(size, view.yaw, fog);
    let [right, up, forward] = view.basis();
    let eye = view.eye();
    let aspect = (size.width.max(1) as f32 / size.height.max(1) as f32).max(0.01);
    let depth = view.far / (view.far - view.near);
    for axis in 0..3 {
        frame[axis] = [
            view.focal / aspect * right[axis],
            view.focal * up[axis],
            depth * forward[axis],
            forward[axis],
        ];
    }
    frame[3] =
        std::array::from_fn(|row| -(0..3).map(|axis| frame[axis][row] * eye[axis]).sum::<f32>());
    frame[3][2] -= view.near * depth;
    frame[8] = [eye[0], eye[1], eye[2], 1.0];
    frame
}

pub fn shadow_camera(
    size: PhysicalSize<u32>,
    frame: &FrameUniform,
    view: deep_engine_native::player_view::PlayerView,
) -> CascadedShadowCamera {
    let eye = [frame[8][0], frame[8][1], frame[8][2]];
    CascadedShadowCamera {
        eye,
        target: [
            eye[0] + frame[0][3],
            eye[1] + frame[1][3],
            eye[2] + frame[2][3],
        ],
        up: [
            frame[0][1] / view.focal,
            frame[1][1] / view.focal,
            frame[2][1] / view.focal,
        ],
        vertical_fov_radians: 2.0 * (1.0 / view.focal).atan(),
        aspect: size.width.max(1) as f32 / size.height.max(1) as f32,
        near: view.near,
        far: view.far,
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
    view: deep_engine_native::player_view::PlayerView,
) -> Result<ShadowMap, String> {
    ShadowMap::new(
        device,
        layout,
        frame,
        shadow_camera(size, frame, view),
        shadow_ray_direction(frame),
        scene_bounds,
    )
}

pub fn update_shadow_map(
    shadow_map: &mut ShadowMap,
    queue: &wgpu::Queue,
    size: PhysicalSize<u32>,
    frame: &FrameUniform,
    view: deep_engine_native::player_view::PlayerView,
) -> Result<(), String> {
    shadow_map.update(
        queue,
        frame,
        shadow_camera(size, frame, view),
        shadow_ray_direction(frame),
    )
}
