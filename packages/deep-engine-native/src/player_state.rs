pub use deep_engine_native::player_view::PlayerView;

/// 交互状态由 CPU 会话拥有，不能随 GPU 设备或交换链销毁。
#[derive(Default)]
pub struct PlayerState {
    pub view: PlayerView,
    pub verification: Option<crate::publication_verification::Verification>,
    pub failure: Option<String>,
    pub selected: Option<String>,
    pub selected_point: Option<[f32; 3]>,
    pub annotations: crate::player_annotations::Annotations,
    pub cursor: Option<[f64; 2]>,
    pub measurement: crate::player_measurement::Measurement,
}

impl PlayerState {
    pub fn rotate(&mut self, delta: f32) {
        self.view.yaw += delta;
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
            for i in 0..3 {
                assert!((view.eye()[i] - position[i] as f32).abs() < 0.00001);
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
}
