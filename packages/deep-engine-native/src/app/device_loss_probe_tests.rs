use super::*;
use serde_json::json;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use winit::platform::windows::EventLoopBuilderExtWindows;

#[path = "device_loss_probe_fresh.rs"]
mod fresh;
#[path = "device_loss_probe_input.rs"]
mod input;
#[path = "device_loss_gpu_measurement.rs"]
mod gpu_measurement;
#[path = "../../tests/support/j3_window_events.rs"]
mod window_events_support;
#[path = "device_loss_window_timing.rs"]
mod window_timing;
#[path = "device_loss_unknown_matrix.rs"]
mod unknown_matrix;
use window_events_support::WindowEventKind;
use window_timing::record_event;

pub(super) fn begin_present_measurement() -> Option<Instant> {
    window_timing::begin_present_measurement()
}

pub(super) fn observe_present(renderer_id: u64, elapsed: Duration) {
    window_timing::observe_present(renderer_id, elapsed);
}
#[test]
#[ignore = "requires Windows GPU and a real NativeApp window"]
fn j3_gate_e_actual_window_device_loss() {
    run(false, false);
}

#[test]
#[ignore = "requires Windows GPU and a real NativeApp window"]
fn j3_gate_e_actual_window_device_loss_retry() {
    run(true, false);
}

#[test]
#[ignore = "requires Windows GPU and a real NativeApp window"]
fn j3_gate_e_window_events_present() {
    run(false, true);
}

#[test]
#[ignore = "requires Windows GPU and a real NativeApp window"]
fn j3_gate_e_window_events_present_retry() {
    run(true, true);
}

fn run(retry: bool, window_events: bool) {
    if fresh::parent_run(retry, window_events) {
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
    let mut probe = Probe {
        app,
        stage: 0,
        started: Instant::now(),
        old_id: 0,
        before_hdr: 0.0,
        view: Default::default(),
        package_hash: String::new(),
        lost_callbacks: 0,
        retry,
        retry_started: None,
        window_events,
    };
    event_loop.run_app(&mut probe).unwrap();
    assert_eq!(probe.stage, 2);
    assert_eq!(probe.lost_callbacks, 1);
    window_timing::clear();
}

struct Probe {
    app: NativeApp,
    stage: u8,
    started: Instant,
    old_id: u64,
    before_hdr: f64,
    view: crate::player_state::PlayerView,
    package_hash: String,
    lost_callbacks: u32,
    retry: bool,
    retry_started: Option<Instant>,
    window_events: bool,
}
impl Probe {
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
            "real product first frame must publish"
        );
    }
}
impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.stage != 0 {
            return;
        }
        let size = winit::dpi::PhysicalSize::new(1920, 1080);
        if self.window_events {
            window_timing::start();
            // The production initializer consumes this exact next generation after window creation.
            self.old_id = self.app.next_renderer_id;
        }
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
        if self.window_events {
            record_event(WindowEventKind::WindowCreated, self.old_id);
        }
        self.app.state.orbit(0.125, 0.0625);
        self.app.state.selected = Some("j3-preserved-selection".into());
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
        input::assert_ignored(self, event_loop);
        gpu_measurement::before(self, event_loop);
        let renderer = self.app.renderer.as_mut().unwrap();
        if self.window_events {
            assert_eq!(renderer.id(), self.old_id);
        }
        self.old_id = renderer.id();
        self.before_hdr = renderer.device_loss_probe_presented_hdr();
        self.stage = 1;
        renderer.device_loss_probe_destroy();
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: GpuEvent) {
        if let GpuEvent::UncapturedError { message, .. } = &event {
            panic!("real GPU error: {message}");
        }
        if let GpuEvent::DeviceLost {
            renderer_id,
            reason,
            ..
        } = &event
        {
            assert_eq!(self.stage, 1);
            assert_eq!(*renderer_id, self.old_id);
            assert!(
                reason.to_lowercase().contains("destroyed"),
                "actual loss reason: {reason}"
            );
            self.lost_callbacks += 1;
            // Record arrival before synchronous handle/rebuild so recovery duration includes creation.
            record_event(WindowEventKind::DeviceLostCallback, *renderer_id);
            if self.retry {
                self.app.recovery_failures_remaining = 1;
                self.retry_started = Some(Instant::now());
            }
            self.app.user_event(event_loop, event);
            if self.retry {
                assert!(self.app.renderer.is_none());
                assert_eq!(self.app.recovery_failures_remaining, 0);
                assert_eq!(self.app.recovery_retry.attempts(), 1);
                event_loop.set_control_flow(winit::event_loop::ControlFlow::Wait);
                return;
            }
            self.finish_recovery(event_loop);
        } else {
            self.app.user_event(event_loop, event);
        }
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        if !input::fixture_lifecycle(&event) {
            return;
        }
        // Avoid submitting on the destroyed owner until its actual lost callback arrives.
        if self.stage == 1 && matches!(event, WindowEvent::RedrawRequested) {
            return;
        }
        self.app.window_event(event_loop, id, event);
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        assert!(
            self.started.elapsed() < Duration::from_secs(45),
            "actual lost callback timeout"
        );
        if self.retry && self.stage == 1 && self.lost_callbacks == 1 {
            self.app.about_to_wait(event_loop);
            if self.app.renderer.is_some() {
                self.finish_recovery(event_loop);
            }
        } else {
            event_loop.set_control_flow(winit::event_loop::ControlFlow::Poll);
        }
    }
}

impl Probe {
    fn finish_recovery(&mut self, event_loop: &ActiveEventLoop) {
        let new_id = self.app.renderer.as_ref().unwrap().id();
        assert_ne!(new_id, self.old_id);
        record_event(WindowEventKind::RecoveryCandidateCreated, new_id);
        assert_eq!(self.app.state.view, self.view);
        assert_eq!(
            self.app.state.selected.as_deref(),
            Some("j3-preserved-selection")
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
        self.redraw(event_loop);
        let gpu_measurement = gpu_measurement::after(self, event_loop);
        let after_hdr = self
            .app
            .renderer
            .as_mut()
            .unwrap()
            .device_loss_probe_presented_hdr();
        let relative = (after_hdr - self.before_hdr).abs() / self.before_hdr;
        assert!(relative <= 1e-6, "preserved scene HDR drift: {relative}");
        // Deliberate stale-event negative control; loss above came from wgpu.
        self.app.user_event(
            event_loop,
            GpuEvent::DeviceLost {
                renderer_id: self.old_id,
                reason: "stale-negative-control".into(),
                message: "must be ignored".into(),
            },
        );
        self.app.user_event(
            event_loop,
            GpuEvent::UncapturedError {
                renderer_id: self.old_id,
                message: "stale-negative-control".into(),
            },
        );
        assert_eq!(self.app.renderer.as_ref().unwrap().id(), new_id);
        assert!(self.app.state.failure.is_none());
        record_event(WindowEventKind::StaleEventRejected, self.old_id);
        if let Some(started) = self.retry_started {
            assert!(started.elapsed() >= Duration::from_millis(250));
            assert_eq!(self.app.recovery_retry.attempts(), 2);
            assert!(!self.app.recovery_retry.active());
        }
        let mut evidence = json!({ "passed": true, "round": std::env::var("DEEP_WINDOW_LOSS_CHILD").unwrap(),
            "sourceHash":deep_engine_native::runtime_package::runtime_content_sha256(&json!(deep_engine_native::native_mesh_wgsl::native_mesh_shader_source())),
            "hashEncoding":"canonical-json-wgsl-source",
        "retryInjection":self.retry,"creationAttempts":self.app.recovery_retry.attempts(),"injectedFailures":u8::from(self.retry),
        "strategy": "destroyed-native-window-rebuild", "realCallbacks": self.lost_callbacks,
        "oldRenderer": self.old_id, "newRenderer": new_id, "packageHash": self.package_hash,
        "beforeHdr": self.before_hdr, "afterHdr": after_hdr, "relativeHdrDifference": relative,
        "presented": true, "viewPreserved": true, "selectionPreserved": true, "staleEventsRejected": true });
        if self.window_events {
            evidence["windowEvents"] = window_timing::evidence(self.old_id, new_id);
        }
        evidence["fixtureInputNegativeControl"] = json!({"passed":true,"events":4});
        if let Some(measurement) = gpu_measurement { gpu_measurement::attach(&mut evidence, measurement, self.window_events); }
        window_timing::write_evidence(&evidence, self.retry, self.window_events);
        println!("J3_WINDOW_RECOVERY {}", evidence);
        self.stage = 2;
        event_loop.exit();
    }
}
