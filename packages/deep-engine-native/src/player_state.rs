pub use deep_engine_native::player_view::PlayerView;

/// 交互状态由 CPU 会话拥有，不能随 GPU 设备或交换链销毁。
#[derive(Default)]
pub struct PlayerState {
    pub view: PlayerView,
    pub camera_controls: deep_engine_native::runtime_camera::RuntimeCameraControls,
    pub verification: Option<crate::publication_record::Verification>,
    pub failure: Option<String>,
    pub selected: Option<String>,
    pub selected_point: Option<[f32; 3]>,
    pub annotations: crate::player_annotations::Annotations,
    pub cursor: Option<[f64; 2]>,
    pub measurement: crate::player_measurement::Measurement,
}

impl PlayerState {
    pub fn rebase_local(&mut self, delta: [f32; 3]) {
        if let Some(point) = self.selected_point.as_mut() {
            for axis in 0..3 {
                point[axis] += delta[axis];
            }
        }
        self.annotations.rebase_local(delta);
    }
    pub fn rotate(&mut self, delta: f32) {
        self.orbit(delta, 0.0);
    }

    pub fn orbit(&mut self, yaw_delta: f32, pitch_delta: f32) {
        self.view.yaw += yaw_delta;
        self.view.pitch += pitch_delta;
        self.view = self.view.constrained(self.camera_controls);
    }

    pub fn zoom(&mut self, wheel_delta: f64) -> bool {
        if !wheel_delta.is_finite() || wheel_delta == 0.0 {
            return false;
        }
        let previous = self.view.distance;
        let exponent = (-wheel_delta.clamp(-4.0, 4.0) * 0.12) as f32;
        self.view.distance *= exponent.exp();
        self.view = self.view.constrained(self.camera_controls);
        self.view.distance != previous
    }

    pub fn set_camera(
        &mut self,
        view: PlayerView,
        controls: deep_engine_native::runtime_camera::RuntimeCameraControls,
    ) {
        self.camera_controls = controls;
        self.view = view.constrained(controls);
    }

    pub fn renderer_ready(&mut self) {
        self.failure = None;
    }

    pub fn failed(&mut self, error: String) {
        self.failure = Some(error);
    }
}

#[cfg(test)]
mod tests {
    use super::PlayerState;

    #[test]
    fn runtime_camera_restores_eye_target_and_projection() {
        let mut camera: deep_engine_native::runtime_camera::RuntimeSceneCamera =
            serde_json::from_str(include_str!(
                "../../deep-engine/fixtures/runtime-camera-v1.json"
            ))
            .unwrap();
        for position in [
            [12.0, 8.0, 16.0],
            [3.0, 10.0, -4.0],
            [3.0, -10.0, -4.0],
            [-4.0, 2.0, 3.0],
        ] {
            camera.position = position;
            let view = super::PlayerView::from_camera(&camera).unwrap();
            for (i, value) in position.iter().enumerate() {
                assert!((view.eye()[i] - *value as f32).abs() < 0.00001);
                assert_eq!(view.target[i], camera.target[i] as f32);
            }
            assert!((2.0 * (1.0 / view.focal).atan().to_degrees() - 50.0).abs() < 0.00001);
            assert_eq!(view.near, 0.05);
            assert_eq!(view.far, 100_000.0);
        }
        camera.position = camera.target;
        assert!(super::PlayerView::from_camera(&camera).is_err());
    }

    #[test]
    fn failed_rebuild_keeps_view_and_successful_retry_clears_exit_failure() {
        let mut state = PlayerState::default();
        state.rotate(0.18);
        state.rotate(-0.36);
        let authored_view = state.view;
        state.failed("GPU initialization failed".into());
        assert!(state.failure.is_some(), "closing now must fail");
        state.failed("GPU rebuild failed".into());
        assert_eq!(state.view, authored_view);
        state.renderer_ready();
        assert!(
            state.failure.is_none(),
            "recovered session must exit successfully"
        );
        assert_eq!(state.view, authored_view);
    }

    #[test]
    fn orbit_input_consumes_authored_distance_and_polar_constraints() {
        let mut controls = deep_engine_native::runtime_camera::RuntimeCameraControls {
            min_distance: 2.0,
            max_distance: 6.0,
            min_polar_angle_degrees: 30.0,
            max_polar_angle_degrees: 120.0,
            walk_speed: 3.5,
            fly_speed: 12.0,
            ..Default::default()
        };
        let mut state = PlayerState::default();
        state.set_camera(state.view, controls);
        assert_eq!(state.camera_controls.walk_speed, 3.5);
        assert_eq!(state.camera_controls.fly_speed, 12.0);

        state.orbit(0.25, 10.0);
        assert!((state.view.pitch.to_degrees() - 60.0).abs() < 0.0001);
        state.orbit(0.0, -20.0);
        assert!((state.view.pitch.to_degrees() + 30.0).abs() < 0.0001);
        for _ in 0..20 {
            state.zoom(1000.0);
        }
        assert_eq!(state.view.distance, 2.0);
        for _ in 0..20 {
            state.zoom(-1000.0);
        }
        assert_eq!(state.view.distance, 6.0);

        controls.min_distance = 5.0;
        controls.max_distance = 10.0;
        state.set_camera(state.view, controls);
        assert_eq!(state.view.distance, 6.0);
    }
}
