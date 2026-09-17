use super::*;
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};
use winit::platform::windows::EventLoopBuilderExtWindows;

const TEST: &str = "app::x_drop_tests::explicit_x_window_replaces_packages_without_reopening";

#[test]
#[ignore = "requires Windows GPU surface and packaged static CRT X worker"]
fn explicit_x_window_replaces_packages_without_reopening() {
    run_probe(false);
}

#[test]
#[ignore = "requires Windows GPU surface and packaged static CRT X worker"]
fn explicit_x_window_watches_primary_packages() {
    run_probe(true);
}

fn run_probe(live: bool) {
    let test = if live {
        "app::x_drop_tests::explicit_x_window_watches_primary_packages"
    } else {
        TEST
    };
    const CHILD: &str = "DEEP_X_DROP_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let executable = std::env::current_exe().unwrap();
        let temp = std::env::temp_dir().join(format!(
            "x-drop-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&temp).unwrap();
        fs::copy(&executable, temp.join("test.exe")).unwrap();
        fs::copy(
            executable
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("examples/x_compat_worker.exe"),
            temp.join("deep2d-x-worker.exe"),
        )
        .unwrap();
        for index in 1..=3 {
            let bytes = if let Some(source) = std::env::var_os("DEEP_X_DROP_FIXTURES") {
                fs::read(PathBuf::from(source).join(format!("frame-{index}.json"))).unwrap()
            } else {
                fixture(index)
            };
            fs::write(temp.join(format!("frame-{index}.json")), bytes).unwrap();
        }
        fs::write(temp.join("bad.json"), b"broken").unwrap();
        fs::write(
            temp.join("ordinary.json"),
            include_bytes!("../../tests/fixtures/runtime-package-v1.json"),
        )
        .unwrap();
        let output = std::process::Command::new(temp.join("test.exe"))
            .args(["--exact", test, "--ignored", "--nocapture"])
            .env(CHILD, &temp)
            .env("LOCALAPPDATA", temp.join("local"))
            .output()
            .unwrap();
        fs::remove_dir_all(temp).unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        println!("{}", String::from_utf8_lossy(&output.stdout));
        return;
    }
    let root = PathBuf::from(std::env::var_os(CHILD).unwrap());
    assert!(
        package_source::load(root.join("frame-1.json")).is_err(),
        "ordinary loader must reject X"
    );
    let content = crate::x_package_window::prepare(&root.join("frame-1.json")).unwrap();
    let before = content.deep2d.clone().unwrap();
    let mut builder = winit::event_loop::EventLoop::<GpuEvent>::with_user_event();
    builder.with_any_thread(true);
    let event_loop = builder.build().unwrap();
    let transport = live.then(|| {
        package_live::start(
            root.join("frame-1.json"),
            content.runtime_package().unwrap().clone(),
            event_loop.create_proxy(),
            package_watch::x_decoder,
        )
    });
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
            shadow_update_probe: None,
            packet_live_probe: None,
            packet_live_transport: None,
            package_live_transport: transport,
            telemetry_report: false,
            selection_probe: false,
            section_probe: false,
            chart_key_probe: false,
        },
    );
    let mut probe = Probe {
        live,
        app,
        root,
        stage: 0,
        before,
        started: Instant::now(),
        window_id: None,
        renderer_id: 0,
    };
    event_loop.run_app(&mut probe).unwrap();
    probe.app.x_runtime.take();
    probe.app.package_open.take();
    probe.app.package_live_transport.take();
    assert_eq!(probe.stage, if live { 2 } else { 4 });
}

struct Probe {
    live: bool,
    app: NativeApp,
    root: PathBuf,
    stage: u8,
    before: deep_engine_native::deep2d::Deep2dRuntimeContent,
    started: Instant,
    window_id: Option<WindowId>,
    renderer_id: u64,
}
impl Probe {
    fn present(&mut self, event_loop: &ActiveEventLoop) {
        for _ in 0..30 {
            self.app.window_event(
                event_loop,
                self.window_id.unwrap(),
                WindowEvent::RedrawRequested,
            );
            if self.app.content.active().pending_x_lkg.is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(self.app.content.active().pending_x_lkg.is_none());
        assert!(self.app.state.failure.is_none());
    }
    fn request(&mut self, event_loop: &ActiveEventLoop, name: &str) {
        if self.live {
            fs::write(
                self.root.join("frame-1.json"),
                fs::read(self.root.join(name)).unwrap(),
            )
            .unwrap();
            return;
        }
        self.app.window_event(
            event_loop,
            self.window_id.unwrap(),
            WindowEvent::DroppedFile(self.root.join(name)),
        );
        package_open::flush_drop(&mut self.app);
    }
}
impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        let window = event_loop
            .create_window(
                window_attributes(true).with_inner_size(winit::dpi::PhysicalSize::new(960, 540)),
            )
            .unwrap();
        self.window_id = Some(window.id());
        self.app.window = Some(Arc::new(window));
        self.app.initialize_renderer();
        self.renderer_id = self.app.renderer.as_ref().unwrap().id();
        self.present(event_loop);
        x_runtime::tick(&mut self.app, event_loop);
        self.request(event_loop, "frame-2.json");
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: GpuEvent) {
        let opened = if self.live {
            matches!(event, GpuEvent::PackageArrived)
        } else {
            matches!(event, GpuEvent::PackageOpened)
        };
        self.app.user_event(event_loop, event);
        if !opened {
            return;
        }
        assert_eq!(
            self.app.window.as_ref().unwrap().id(),
            self.window_id.unwrap()
        );
        assert_eq!(self.app.renderer.as_ref().unwrap().id(), self.renderer_id);
        let current = self.app.content.active().deep2d.clone().unwrap();
        if self.stage < 2 {
            assert_ne!(current, self.before);
            assert!(self.app.content.active().pending_x_lkg.is_some());
            self.present(event_loop);
            self.before = current;
        } else {
            assert_eq!(
                current, self.before,
                "rejected drop must retain accepted display"
            );
        }
        self.stage += 1;
        if self.live && self.stage == 2 {
            let snapshot = self.app.content.active().runtime_package().unwrap();
            assert!(
                package_watch::x_decoder(b"broken", &self.root.join("frame-1.json"), snapshot)
                    .is_err()
            );
            assert!(
                package_watch::x_decoder(
                    include_bytes!("../../tests/fixtures/runtime-package-v1.json"),
                    &self.root.join("frame-1.json"),
                    snapshot
                )
                .is_err()
            );
            println!("X live file replacements=2 checkpoints=presented invalid/ordinary=rejected");
            event_loop.exit();
            return;
        }
        match self.stage {
            1 => self.request(event_loop, "frame-3.json"),
            2 => self.request(event_loop, "bad.json"),
            3 => self.request(event_loop, "ordinary.json"),
            _ => {
                println!(
                    "X same-window replacements=2 rejected=2 renderer=unchanged checkpoints=presented"
                );
                event_loop.exit();
            }
        }
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        assert!(
            self.started.elapsed() < Duration::from_secs(15),
            "X drop probe timeout"
        );
        self.app.about_to_wait(event_loop);
        event_loop.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(
            Instant::now() + Duration::from_millis(20),
        ));
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        self.app.window_event(event_loop, id, event);
    }
}

fn fixture(revision: u64) -> Vec<u8> {
    use deep_engine_native::runtime_package::{freeze_x_resource, runtime_package_sha256};
    let mut package: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../deep-engine/fixtures/experimental-x-display-runtime-v6.json"
    ))
    .unwrap();
    let mut request: deep_engine_native::compat_x::XRequest =
        serde_json::from_value(package["payloads"]["x:display"]["content"]["request"].clone())
            .unwrap();
    request.expected_epoch = revision;
    if let deep_engine_native::compat_x::XCall::EmitDisplayList(list) = &mut request.calls[0] {
        list.revision = revision;
        list.logical_width = 320.0 + revision as f64 * 20.0;
    }
    let (index, payload) = freeze_x_resource("x:display", revision, request).unwrap();
    package["payloads"]["x:display"] = payload;
    *package["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|value| value["id"] == "x:display")
        .unwrap() = serde_json::to_value(index).unwrap();
    package["packageHash"]["value"] = runtime_package_sha256(&package).unwrap().into();
    serde_json::to_vec(&package).unwrap()
}
