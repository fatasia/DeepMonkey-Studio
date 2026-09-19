use super::*;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use winit::platform::windows::EventLoopBuilderExtWindows;

#[test]
#[ignore = "requires Windows GPU and offscreen winit surface"]
fn asset_directory_drop_events_publish_only_validated_frames() {
    const CHILD: &str = "DEEP_DROP_PROBE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let temp = std::env::temp_dir().join(format!("deep-drop-probe-{}", std::process::id()));
        std::fs::create_dir_all(&temp).unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "app::package_drop_probe_tests::asset_directory_drop_events_publish_only_validated_frames", "--ignored", "--nocapture"])
            .env(CHILD, "1").env("LOCALAPPDATA", &temp).output().unwrap();
        std::fs::remove_dir_all(temp).unwrap();
        assert!(
            result.status.success(),
            "status={} {}{}",
            result.status,
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        println!("{}", String::from_utf8_lossy(&result.stdout));
        return;
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let runtime = root.join("tests/fixtures/runtime-package-author-lod-v1.json");
    let content = package_source::load(runtime.clone()).unwrap();
    let mut builder = winit::event_loop::EventLoop::<GpuEvent>::with_user_event();
    builder.with_any_thread(true);
    let event_loop = builder.build().unwrap();
    event_loop.set_control_flow(winit::event_loop::ControlFlow::Poll);
    let native = NativeApp::new(
        content,
        event_loop.create_proxy(),
        NativeAppSetup {
            dynamic_playback: None,
            smoke_frame: false,
            features: RendererFeatures {
                bloom: Default::default(),
                fog: deep_engine_native::fog::FogSettings::DISABLED,
                shadow_probe: false,
                ibl_probe: false,
                telemetry: false,
            },
            shadow_update_probe: None,
            packet_live_probe: None,
            packet_live_transport: None,
            package_live_transport: None,
            telemetry_report: false,
            selection_probe: false,
            section_probe: false,
            chart_key_probe: false,
        },
    );
    let mut probe = Probe {
        app: native,
        root,
        runtime,
        stage: 0,
        started: Instant::now(),
    };
    event_loop.run_app(&mut probe).unwrap();
    assert_eq!(probe.stage, 10);
}

struct Probe {
    app: NativeApp,
    root: PathBuf,
    runtime: PathBuf,
    stage: u8,
    started: Instant,
}
impl Probe {
    fn send(&mut self, event_loop: &ActiveEventLoop, event: WindowEvent) {
        let id = self.app.window.as_ref().unwrap().id();
        window_events::handle(&mut self.app, event_loop, id, event);
    }
    fn drop_path(&mut self, event_loop: &ActiveEventLoop, path: PathBuf) {
        self.send(event_loop, WindowEvent::DroppedFile(path));
        package_open::flush_drop(&mut self.app);
    }
    fn present(&mut self, event_loop: &ActiveEventLoop) {
        for _ in 0..30 {
            self.send(event_loop, WindowEvent::RedrawRequested);
            if self.app.content.active().pending_asset_lkg.is_none()
                && self.app.content.active().pending_lkg.is_none()
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(self.app.state.failure.is_none());
        assert!(self.app.content.active().pending_asset_lkg.is_none());
        assert!(self.app.content.active().pending_lkg.is_none());
    }
}
mod events;
