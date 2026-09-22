use super::player_view::PlayerView;
use super::runtime_camera::{RuntimeCameraControls, RuntimeCameraMode};
use super::runtime_navigation::{NavigationInput, NavigationState};

fn controls(mode: RuntimeCameraMode) -> RuntimeCameraControls {
    RuntimeCameraControls {
        mode,
        walk_speed: 4.0,
        fly_speed: 8.0,
        sprint_multiplier: 2.0,
        eye_height: 1.7,
        gravity: 9.81,
        jump_speed: 4.0,
        ..Default::default()
    }
}

#[test]
fn first_person_step_moves_along_camera_forward_and_normalizes_diagonal_input() {
    let mut state = NavigationState {
        grounded: true,
        ..Default::default()
    };
    let view = PlayerView {
        yaw: 0.0,
        target: [0.0, 0.0, 0.0],
        ..Default::default()
    };
    let moved = state.step(
        view,
        controls(RuntimeCameraMode::FirstPerson),
        NavigationInput {
            forward: 1.0,
            strafe: 1.0,
            sprint: false,
            ..Default::default()
        },
        0.25,
    );
    // dt is bounded to 100 ms; normalized diagonal displacement is
    // 4 m/s × 0.1 s ÷ √2.
    assert!((moved.target[0] - 0.2828427).abs() < 0.0001);
    assert!((moved.target[2] + 0.2828427).abs() < 0.0001);
}

#[test]
fn forward_motion_agrees_with_eye_to_target_for_rotated_cameras() {
    for yaw in [0.0, 0.7, -1.4, std::f32::consts::PI] {
        for mode in [
            RuntimeCameraMode::FirstPerson,
            RuntimeCameraMode::ThirdPerson,
        ] {
            let view = PlayerView {
                yaw,
                pitch: 0.3,
                ..Default::default()
            };
            let eye = view.eye();
            let facing = [view.target[0] - eye[0], view.target[2] - eye[2]];
            let moved = NavigationState::default().step(
                view,
                controls(mode),
                NavigationInput {
                    forward: 1.0,
                    ..Default::default()
                },
                0.05,
            );
            let displacement = [
                moved.target[0] - view.target[0],
                moved.target[2] - view.target[2],
            ];
            assert!(facing[0] * displacement[0] + facing[1] * displacement[1] > 0.0);
            assert!((facing[0] * displacement[1] - facing[1] * displacement[0]).abs() < 0.0001);
        }
    }
}

#[test]
fn paused_or_invalid_clock_preserves_view_and_navigation_state() {
    for dt in [0.0, -1.0, f32::NAN, f32::INFINITY] {
        let mut state = NavigationState {
            grounded: true,
            ..Default::default()
        };
        let before = state;
        let view = PlayerView::default();
        assert_eq!(
            state.step(
                view,
                controls(RuntimeCameraMode::FirstPerson),
                NavigationInput {
                    jump: true,
                    forward: 1.0,
                    ..Default::default()
                },
                dt
            ),
            view
        );
        assert_eq!(state, before);
    }
}

#[test]
fn gravity_lands_and_jump_has_bounded_vertical_motion() {
    let controls = controls(RuntimeCameraMode::FirstPerson);
    let view = PlayerView {
        target: [0.0, 1.7, 0.0],
        ..Default::default()
    };
    let mut state = NavigationState {
        grounded: true,
        ..Default::default()
    };
    let jumped = state.step(
        view,
        controls,
        NavigationInput {
            jump: true,
            ..Default::default()
        },
        1.0 / 60.0,
    );
    assert!(jumped.target[1] > view.target[1]);
    let mut current = jumped;
    for _ in 0..240 {
        current = state.step(current, controls, NavigationInput::default(), 1.0 / 60.0);
    }
    assert!((current.target[1] - view.target[1]).abs() < 0.0001);
    assert!(state.grounded);
    assert!(state.vertical_velocity.abs() < f32::EPSILON);
}

#[test]
fn orbit_mode_is_unchanged_until_native_input_adapter_is_wired() {
    let mut state = NavigationState::default();
    let view = PlayerView::default();
    assert_eq!(
        state.step(
            view,
            RuntimeCameraControls::default(),
            NavigationInput {
                forward: 1.0,
                vertical: 1.0,
                ..Default::default()
            },
            0.1
        ),
        view
    );
}
