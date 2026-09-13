#[derive(Debug)]
pub enum GpuEvent {
    DeviceLost {
        renderer_id: u64,
        reason: String,
        message: String,
    },
    UncapturedError {
        renderer_id: u64,
        message: String,
    },
    SmokeTimeout,
}

pub fn targets_active_renderer(active_renderer_id: Option<u64>, renderer_id: u64) -> bool {
    active_renderer_id == Some(renderer_id)
}

pub enum RenderOutcome {
    Presented,
    Skipped,
    Recover,
    Failed(String),
}

#[cfg(test)]
mod tests {
    use super::targets_active_renderer;

    #[test]
    fn gpu_callbacks_only_target_the_renderer_that_published_them() {
        assert!(targets_active_renderer(Some(4), 4));
        assert!(!targets_active_renderer(Some(4), 3));
        assert!(!targets_active_renderer(None, 4));
    }
}
