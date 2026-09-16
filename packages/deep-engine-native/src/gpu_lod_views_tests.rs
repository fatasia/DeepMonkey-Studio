use super::*;
use crate::gpu_resources::{frame_data_with_view, shadow_camera};
use deep_engine_native::fog::FogSettings;
use deep_engine_native::mesh_abi::{CAMERA_FOCAL, CAMERA_NEAR};

struct Shadows;
impl ShadowViewSource for Shadows {
    fn cascade_count(&self) -> u32 {
        1
    }
    fn cascade_view_projection(&self, _: usize) -> [[f32; 4]; 4] {
        std::array::from_fn(|column| {
            std::array::from_fn(|row| if column == row { 1.0 } else { 0.0 })
        })
    }
    fn shadow_map_size(&self) -> u32 {
        2048
    }
}

fn vector(bytes: &[u8; 160], offset: usize) -> [f32; 4] {
    std::array::from_fn(|i| {
        f32::from_ne_bytes(
            bytes[offset + i * 4..offset + (i + 1) * 4]
                .try_into()
                .unwrap(),
        )
    })
}

fn close(actual: f32, expected: f32) {
    assert!((actual - expected).abs() < 0.0001, "{actual} != {expected}");
}

#[test]
fn translated_focus_uses_projected_depth_for_lod_and_shadow_camera() {
    let size = PhysicalSize::new(1280, 720);
    for yaw in [0.0, 0.55, -1.2, std::f32::consts::PI] {
        for target in [[0.0; 3], [30.0, -12.0, 19.0], [-70.0, 20.0, -40.0]] {
            let frame = frame_data_with_view(size, yaw, target, 6.0, FogSettings::default());
            let views = pack_views(&frame, size, &Shadows, 7, CAMERA_NEAR).unwrap();
            let eye = vector(&views[0], 96);
            let forward = vector(&views[0], 112);
            let shadow = shadow_camera(size, &frame, Default::default());
            for axis in 0..3 {
                close(forward[axis], (target[axis] - eye[axis]) / 6.0);
                close(forward[axis], shadow.target[axis] - shadow.eye[axis]);
            }
            for point in [target, [1.0, 3.0, 7.0], [-10.0, -3.0, 2.0]] {
                let lod_depth: f32 = (0..3).map(|i| (point[i] - eye[i]) * forward[i]).sum();
                let clip_w = frame[3][3] + (0..3).map(|i| frame[i][3] * point[i]).sum::<f32>();
                close(lod_depth, clip_w);
            }
            assert_eq!(views.len(), 2);
            assert_eq!(vector(&views[1], 112), [0.0; 4]);
            assert_eq!(
                vector(&views[0], 144),
                [720.0 * CAMERA_FOCAL * 0.5, CAMERA_NEAR, 0.0, 0.0]
            );
        }
    }
}

#[test]
fn eye_at_world_origin_has_finite_lod_direction() {
    let frame = frame_data_with_view(
        PhysicalSize::new(100, 100),
        0.0,
        [0.0, 0.0, -4.0],
        4.0,
        FogSettings::default(),
    );
    let views = pack_views(
        &frame,
        PhysicalSize::new(100, 100),
        &Shadows,
        1,
        CAMERA_NEAR,
    )
    .unwrap();
    assert_eq!(vector(&views[0], 96), [0.0, 0.0, 0.0, 1.0]);
    assert_eq!(vector(&views[0], 112), [0.0, 0.0, -1.0, 0.0]);
}

#[test]
fn pitched_camera_basis_reaches_lod_and_shadow_without_pole_singularity() {
    use crate::gpu_resources::frame_data_with_camera;
    use deep_engine_native::player_view::PlayerView;
    let size = PhysicalSize::new(1280, 720);
    for pitch in [
        -std::f32::consts::FRAC_PI_2,
        -0.7,
        0.7,
        std::f32::consts::FRAC_PI_2,
    ] {
        let view = PlayerView {
            pitch,
            target: [9.0, 3.0, -7.0],
            ..Default::default()
        };
        let frame = frame_data_with_camera(size, view, FogSettings::default());
        let views = pack_views(&frame, size, &Shadows, 1, CAMERA_NEAR).unwrap();
        let shadow = shadow_camera(size, &frame, Default::default());
        let [right, up, forward] = view.basis();
        let packed = vector(&views[0], 112);
        for axis in 0..3 {
            close(packed[axis], forward[axis]);
            close(shadow.up[axis], up[axis]);
            close(
                view.eye()[axis] + view.distance * forward[axis],
                view.target[axis],
            );
        }
        close((0..3).map(|i| right[i] * up[i]).sum(), 0.0);
        close((0..3).map(|i| forward[i] * up[i]).sum(), 0.0);
        assert!(frame.iter().flatten().all(|v| v.is_finite()));
    }
}

#[test]
fn zero_pitch_preserves_existing_frame_projection() {
    use crate::gpu_resources::frame_data_with_camera;
    use deep_engine_native::player_view::PlayerView;
    for yaw in [-1.2, 0.0, 0.55, 2.4] {
        let expected = deep_engine_native::mesh_abi::frame_uniform(16.0 / 9.0, yaw);
        let actual = frame_data_with_camera(
            PhysicalSize::new(1280, 720),
            PlayerView {
                yaw,
                ..Default::default()
            },
            FogSettings::DISABLED,
        );
        for column in 0..13 {
            for row in 0..4 {
                close(actual[column][row], expected[column][row]);
            }
        }
    }
}

#[test]
fn projection_parameters_reach_depth_lod_and_shadow_without_far_plane_reconstruction() {
    use crate::gpu_resources::frame_data_with_camera;
    use deep_engine_native::player_view::PlayerView;
    let size = PhysicalSize::new(1280, 720);
    for (focal, near, far) in [(1.2, 0.05, 100_000.0), (3.0, 0.5, 200.0)] {
        let view = PlayerView {
            focal,
            near,
            far,
            pitch: 0.4,
            ..Default::default()
        };
        let frame = frame_data_with_camera(size, view, FogSettings::DISABLED);
        let shadow = shadow_camera(size, &frame, view);
        assert_eq!(shadow.near, near);
        assert_eq!(shadow.far, far);
        close(shadow.vertical_fov_radians, 2.0 * (1.0 / focal).atan());
        let views = pack_views(&frame, size, &Shadows, 1, near).unwrap();
        let projection = vector(&views[0], 144);
        close(projection[0] / 360.0, focal);
        assert_eq!(projection[1], near);
        for (depth, expected) in [(near, 0.0), (far, 1.0)] {
            let forward = view.basis()[2];
            let point: [f32; 3] = std::array::from_fn(|i| view.eye()[i] + forward[i] * depth);
            let clip = |row| frame[3][row] + (0..3).map(|i| frame[i][row] * point[i]).sum::<f32>();
            close(clip(2) / clip(3), expected);
        }
    }
}
