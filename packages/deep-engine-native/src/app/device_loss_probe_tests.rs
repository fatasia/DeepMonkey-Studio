use super::*;
use serde_json::json;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use winit::platform::windows::EventLoopBuilderExtWindows;

const TEST: &str = "app::device_loss_probe_tests::j3_gate_e_actual_window_device_loss";
const RETRY_TEST: &str = "app::device_loss_probe_tests::j3_gate_e_actual_window_device_loss_retry";

#[test]
#[ignore = "requires Windows GPU and a real NativeApp window"]
fn j3_gate_e_actual_window_device_loss() {
    run(false);
}

#[test]
#[ignore = "requires Windows GPU and a real NativeApp window"]
fn j3_gate_e_actual_window_device_loss_retry() {
    run(true);
}

fn run(retry: bool) {
    const CHILD: &str = "DEEP_WINDOW_LOSS_CHILD";
    if std::env::var_os(CHILD).is_none() {
        for round in 1..=2 {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    if retry { RETRY_TEST } else { TEST },
                    "--ignored",
                    "--nocapture",
                ])
                .env(CHILD, round.to_string())
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            println!("{}", String::from_utf8_lossy(&result.stdout));
        }
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
    let app = NativeApp::new(
        content,
        event_loop.create_proxy(),
        NativeAppSetup {
            smoke_frame: false,
            features: RendererFeatures {
                bloom: Default::default(),
                fog: deep_engine_native::fog::FogSettings::DISABLED,
                shadow_probe: false,
                ibl_probe: false,
                telemetry: false,
            },
            occlusion_probe: false,
            dynamic_playback: None,
            state_ops: None,
            shadow_update_probe: None,
            packet_live_probe: None,
            packet_live_transport: None,
            package_live_transport: None,
            telemetry_prepare_replay: None,
            telemetry_report: false,
            selection_probe: false,
            section_probe: false,
            chart_key_probe: false,
        },
    );
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
    };
    event_loop.run_app(&mut probe).unwrap();
    assert_eq!(probe.stage, 2);
    assert_eq!(probe.lost_callbacks, 1);
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
        let renderer = self.app.renderer.as_mut().unwrap();
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
        if let Some(started) = self.retry_started {
            assert!(started.elapsed() >= Duration::from_millis(250));
            assert_eq!(self.app.recovery_retry.attempts(), 2);
            assert!(!self.app.recovery_retry.active());
        }
        let evidence = json!({ "passed": true, "round": std::env::var("DEEP_WINDOW_LOSS_CHILD").unwrap(),
            "sourceHash":deep_engine_native::runtime_package::runtime_content_sha256(&json!(deep_engine_native::native_mesh_wgsl::native_mesh_shader_source())),
            "hashEncoding":"canonical-json-wgsl-source",
        "retryInjection":self.retry,"creationAttempts":self.app.recovery_retry.attempts(),"injectedFailures":u8::from(self.retry),
        "strategy": "destroyed-native-window-rebuild", "realCallbacks": self.lost_callbacks,
        "oldRenderer": self.old_id, "newRenderer": new_id, "packageHash": self.package_hash,
        "beforeHdr": self.before_hdr, "afterHdr": after_hdr, "relativeHdrDifference": relative,
        "presented": true, "viewPreserved": true, "selectionPreserved": true, "staleEventsRejected": true });
        if let Some(output) = std::env::var_os("J3_WINDOW_NATIVE_OUTPUT") {
            std::fs::create_dir_all(&output).unwrap();
            std::fs::write(
                PathBuf::from(output).join(format!(
                    "{}round-{}.json",
                    if self.retry { "retry-" } else { "" },
                    std::env::var("DEEP_WINDOW_LOSS_CHILD").unwrap()
                )),
                evidence.to_string(),
            )
            .unwrap();
        }
        println!("J3_WINDOW_RECOVERY {}", evidence);
        self.stage = 2;
        event_loop.exit();
    }
}
