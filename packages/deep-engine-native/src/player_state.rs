#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlayerView {
    pub yaw: f32,
}

impl Default for PlayerView {
    fn default() -> Self {
        Self { yaw: 0.55 }
    }
}

/// 交互状态由 CPU 会话拥有，不能随 GPU 设备或交换链销毁。
#[derive(Default)]
pub struct PlayerState {
    pub view: PlayerView,
    pub failure: Option<String>,
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
