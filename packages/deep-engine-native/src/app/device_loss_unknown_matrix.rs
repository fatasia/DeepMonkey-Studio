//! Original J3-E synthetic unknown rows, on the production window/retry handler.
use super::*;
#[path = "device_loss_unknown_receipt.rs"]
mod receipt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Once,
    Retry,
    PrePresent,
    Exhaustion,
}
impl Mode {
    fn row(self) -> &'static str {
        match self {
            Self::Once => "single-unknown-mid-run",
            Self::Retry => "unknown-retry-backoff",
            Self::PrePresent => "unknown-pre-present-loss",
            Self::Exhaustion => "unknown-exhaustion-fatal",
        }
    }
    fn attempts(self) -> u8 {
        if self == Self::Once {
            1
        } else if self == Self::Exhaustion {
            3
        } else {
            2
        }
    }
}
#[test]
#[ignore = "requires a real Windows NativeApp GPU window; synthetic unknown stimulus"]
fn j3_gate_e_unknown_once() {
    run(Mode::Once);
}
#[test]
#[ignore = "requires a real Windows NativeApp GPU window; synthetic unknown stimulus"]
fn j3_gate_e_unknown_retry() {
    run(Mode::Retry);
}
#[test]
#[ignore = "requires a real Windows NativeApp GPU window; synthetic unknown stimulus"]
fn j3_gate_e_unknown_pre_present() {
    run(Mode::PrePresent);
}
#[test]
#[ignore = "requires a real Windows NativeApp GPU window; synthetic unknown stimulus"]
fn j3_gate_e_unknown_exhaustion() {
    run(Mode::Exhaustion);
}

fn run(mode: Mode) {
    if receipt::parent_run(mode) {
        return;
    }
    let content = package_source::load(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/runtime-package-author-lod-v1.json"),
    )
    .unwrap();
    let mut builder = winit::event_loop::EventLoop::<GpuEvent>::with_user_event();
    builder.with_any_thread(true);
    let event_loop = builder.build().unwrap();
    event_loop.set_control_flow(winit::event_loop::ControlFlow::Poll);
    let app = NativeApp::new(content, event_loop.create_proxy(), fresh::setup());
    let mut probe = UnknownProbe {
        app,
        mode,
        done: false,
        started: Instant::now(),
        loss_started: None,
        callbacks: 0,
        old_id: 0,
        before_hdr: 0.0,
        view: Default::default(),
        package_hash: String::new(),
        pre_present_id: None,
    };
    event_loop.run_app(&mut probe).unwrap();
    assert!(probe.done);
}
struct UnknownProbe {
    app: NativeApp,
    mode: Mode,
    done: bool,
    started: Instant,
    loss_started: Option<Instant>,
    callbacks: u32,
    old_id: u64,
    before_hdr: f64,
    view: crate::player_state::PlayerView,
    package_hash: String,
    pre_present_id: Option<u64>,
}
impl UnknownProbe {
    fn redraw(&mut self, event_loop: &ActiveEventLoop) {
        let id = self.app.window.as_ref().unwrap().id();
        self.app
            .window_event(event_loop, id, WindowEvent::RedrawRequested);
        assert!(
            self.app.state.failure.is_none(),
            "{:?}",
            self.app.state.failure
        );
        assert!(
            !self.app.startup_frame_pending,
            "production Presented must complete startup"
        );
    }
    fn inject(&mut self, event_loop: &ActiveEventLoop) {
        let id = self.app.renderer.as_ref().unwrap().id();
        if self.callbacks == 0 {
            self.loss_started = Some(Instant::now());
            self.app.recovery_failures_remaining = match self.mode {
                Mode::Retry => 1,
                Mode::Exhaustion => 3,
                _ => 0,
            };
        }
        self.callbacks += 1;
        self.app.user_event(
            event_loop,
            GpuEvent::DeviceLost {
                renderer_id: id,
                reason: "unknown".into(),
                message: "J3-E explicitly synthetic unknown stimulus".into(),
            },
        );
        if self.mode == Mode::PrePresent && self.callbacks == 1 {
            let candidate = self.app.renderer.as_ref().unwrap().id();
            assert_ne!(candidate, self.old_id);
            assert!(self.app.startup_frame_pending);
            assert_eq!(self.app.recovery_retry.attempts(), 1);
            assert!(self.app.recovery_retry.active());
            self.pre_present_id = Some(candidate);
            self.inject(event_loop);
        } else if self.app.renderer.is_some() {
            self.finish_success(event_loop);
        }
    }
    fn assert_state(&self) {
        assert_eq!(self.app.state.view, self.view);
        assert_eq!(
            self.app.state.selected.as_deref(),
            Some("j3-unknown-preserved-selection")
        );
        assert_eq!(
            self.app
                .content
                .active()
                .runtime_package()
                .unwrap()
                .package_hash,
            self.package_hash
        );
    }
    fn stale(&mut self, event_loop: &ActiveEventLoop) {
        let identity = self.app.renderer.as_ref().map(Renderer::id);
        let failure = self.app.state.failure.clone();
        let attempts = self.app.recovery_retry.attempts();
        for event in [
            GpuEvent::DeviceLost {
                renderer_id: self.old_id,
                reason: "unknown".into(),
                message: "stale negative".into(),
            },
            GpuEvent::UncapturedError {
                renderer_id: self.old_id,
                message: "stale negative".into(),
            },
        ] {
            self.app.user_event(event_loop, event);
        }
        assert_eq!(self.app.renderer.as_ref().map(Renderer::id), identity);
        assert_eq!(self.app.state.failure, failure);
        assert_eq!(self.app.recovery_retry.attempts(), attempts);
    }
    fn finish_success(&mut self, event_loop: &ActiveEventLoop) {
        let new_id = self.app.renderer.as_ref().unwrap().id();
        assert_ne!(new_id, self.old_id);
        assert_eq!(self.app.recovery_retry.attempts(), self.mode.attempts());
        if let Some(candidate) = self.pre_present_id {
            assert_ne!(new_id, candidate);
        }
        if self.mode == Mode::Retry {
            assert!(self.loss_started.unwrap().elapsed() >= Duration::from_millis(250));
        }
        self.assert_state();
        self.redraw(event_loop);
        assert!(!self.app.recovery_retry.active());
        let after = self
            .app
            .renderer
            .as_mut()
            .unwrap()
            .device_loss_probe_presented_hdr();
        let relative = (after - self.before_hdr).abs() / self.before_hdr;
        assert!(
            relative.is_finite() && relative <= 1e-6,
            "HDR drift {relative}"
        );
        self.stale(event_loop);
        receipt::write(self, Some((new_id, after, relative)), None);
        self.done = true;
        event_loop.exit();
    }
    fn finish_exhaustion(&mut self, event_loop: &ActiveEventLoop) {
        assert!(self.app.renderer.is_none());
        assert_eq!(self.app.recovery_retry.attempts(), 3);
        assert_eq!(self.app.recovery_failures_remaining, 0);
        let failure = self.app.state.failure.clone().unwrap();
        assert!(failure.contains("exhausted after 3 attempts") && failure.contains("press R"));
        self.assert_state();
        self.stale(event_loop);
        // Late callback + due processing cannot revive exhausted automatic recovery.
        self.app.about_to_wait(event_loop);
        assert!(self.app.renderer.is_none());
        assert_eq!(self.app.recovery_retry.attempts(), 3);
        // Exactly the production KeyR handler target; separate from automatic row outcome.
        self.app.initialize_renderer();
        let manual_id = self.app.renderer.as_ref().unwrap().id();
        self.redraw(event_loop);
        self.assert_state();
        receipt::write(self, None, Some((manual_id, failure)));
        self.done = true;
        event_loop.exit();
    }
}
impl ApplicationHandler<GpuEvent> for UnknownProbe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.old_id != 0 {
            return;
        }
        let size = winit::dpi::PhysicalSize::new(1920, 1080);
        self.app.window = Some(Arc::new(
            event_loop
                .create_window(
                    window_attributes(false)
                        .with_inner_size(size)
                        .with_min_inner_size(size)
                        .with_visible(false),
                )
                .unwrap(),
        ));
        self.app.state.orbit(0.125, 0.0625);
        self.app.state.selected = Some("j3-unknown-preserved-selection".into());
        self.view = self.app.state.view;
        self.package_hash = self
            .app
            .content
            .active()
            .runtime_package()
            .unwrap()
            .package_hash
            .clone();
        self.app.initialize_renderer();
        self.redraw(event_loop);
        let renderer = self.app.renderer.as_mut().unwrap();
        self.old_id = renderer.id();
        self.before_hdr = renderer.device_loss_probe_presented_hdr();
        assert!(self.before_hdr.is_finite() && self.before_hdr > 0.0);
        self.inject(event_loop);
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: GpuEvent) {
        let callback_id = match &event {
            GpuEvent::DeviceLost { renderer_id, .. }
            | GpuEvent::UncapturedError { renderer_id, .. } => Some(*renderer_id),
            _ => None,
        };
        if callback_id.is_some() && callback_id == self.app.renderer.as_ref().map(Renderer::id) {
            panic!("unexpected actual GPU callback in synthetic fixture");
        }
        self.app.user_event(event_loop, event);
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        if !input::fixture_lifecycle(&event) || matches!(event, WindowEvent::RedrawRequested) {
            return;
        }
        self.app.window_event(event_loop, id, event);
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        assert!(
            self.started.elapsed() < Duration::from_secs(60),
            "synthetic recovery timeout"
        );
        if self.done || self.callbacks == 0 {
            return;
        }
        self.app.about_to_wait(event_loop);
        if self.app.renderer.is_some() {
            self.finish_success(event_loop);
        } else if self.mode == Mode::Exhaustion && self.app.recovery_retry.attempts() == 3 {
            self.finish_exhaustion(event_loop);
        }
    }
}
