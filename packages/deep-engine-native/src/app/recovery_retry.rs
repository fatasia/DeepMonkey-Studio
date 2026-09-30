use std::time::Duration;
use web_time::Instant;
use winit::event_loop::ControlFlow;

pub(super) fn merge_animation_wake(flow: ControlFlow, next: Instant, now: Instant) -> ControlFlow {
    match flow {
        ControlFlow::Poll => ControlFlow::Poll,
        ControlFlow::WaitUntil(existing) if existing > now => {
            ControlFlow::WaitUntil(existing.min(next))
        }
        _ => ControlFlow::WaitUntil(next),
    }
}

/// Normal-window loss budget; a created candidate is not yet a recovered frame.
#[derive(Default)]
pub(super) struct RecoveryRetry {
    active: bool,
    attempts: u8,
    candidate: Option<u64>,
    wake: Option<Instant>,
    managed_wake: Option<Instant>,
}

impl RecoveryRetry {
    pub(super) fn begin(&mut self) {
        if !self.active {
            self.active = true;
            self.attempts = 0;
        }
    }
    pub(super) fn begin_attempt(&mut self) -> bool {
        if !self.active || self.attempts >= 3 {
            return false;
        }
        self.attempts += 1;
        self.candidate = None;
        self.wake = None;
        true
    }
    pub(super) fn failed(&mut self, now: Instant) -> Option<Instant> {
        self.candidate = None;
        self.wake = if self.active && self.attempts > 0 && self.attempts < 3 {
            now.checked_add(Duration::from_millis(250 << (self.attempts - 1)))
        } else {
            None
        };
        self.wake
    }
    pub(super) fn ready(&mut self, id: u64) {
        if self.active {
            self.candidate = Some(id);
            self.wake = None;
        }
    }
    pub(super) fn presented(&mut self, id: u64) {
        if self.active && self.candidate == Some(id) {
            self.cancel();
        }
    }
    pub(super) fn cancel(&mut self) {
        self.active = false;
        self.candidate = None;
        self.wake = None;
    }
    pub(super) fn take_due(&mut self, now: Instant) -> bool {
        if self.active && self.wake.is_some_and(|wake| now >= wake) {
            self.wake = None;
            true
        } else {
            false
        }
    }
    pub(super) fn attempts(&self) -> u8 {
        self.attempts
    }
    pub(super) fn active(&self) -> bool {
        self.active
    }
    /// Remove only the deadline installed by this budget; avoid an expired busy loop.
    pub(super) fn clear_managed_wake(&mut self, flow: ControlFlow) -> ControlFlow {
        match self.managed_wake.take() {
            Some(wake) if flow == ControlFlow::WaitUntil(wake) => ControlFlow::Wait,
            _ => flow,
        }
    }
    pub(super) fn merge_wake(&mut self, flow: ControlFlow) -> ControlFlow {
        let Some(wake) = self.wake else {
            return flow;
        };
        if matches!(flow, ControlFlow::Poll)
            || matches!(flow, ControlFlow::WaitUntil(existing) if existing <= wake)
        {
            return flow;
        }
        self.managed_wake = Some(wake);
        ControlFlow::WaitUntil(wake)
    }
}
