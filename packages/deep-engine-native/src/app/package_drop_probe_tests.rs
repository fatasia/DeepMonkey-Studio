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
impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.app.window = Some(Arc::new(
            event_loop.create_window(window_attributes(true)).unwrap(),
        ));
        self.app.initialize_renderer();
        self.present(event_loop);
        let id = self.app.renderer.as_ref().unwrap().id();
        let mut candidate =
            package_source::load(self.root.join("tests/fixtures/asset-directory-v1")).unwrap();
        let renderer = self.app.renderer.as_mut().unwrap();
        let before = renderer.scene_update_evidence();
        candidate.environment.specular.mips[0].texels[0][0] = f32::NAN;
        assert!(
            pollster::block_on(
                renderer.replace_dropped_package(self.app.content.active(), &candidate)
            )
            .is_err()
        );
        assert_eq!(renderer.scene_update_evidence(), before);
        let candidate =
            package_source::load(self.root.join("tests/fixtures/asset-directory-v1")).unwrap();
        renderer
            .resize(winit::dpi::PhysicalSize::new(0, 0))
            .unwrap();
        assert!(
            pollster::block_on(
                renderer.replace_dropped_package(self.app.content.active(), &candidate)
            )
            .is_err()
        );
        assert_eq!(
            renderer.scene_update_evidence().cache_live,
            before.cache_live
        );
        renderer
            .resize(winit::dpi::PhysicalSize::new(64, 64))
            .unwrap();
        assert!(
            !PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap())
                .join("DeepEngineNative/asset-recovery")
                .exists()
        );
        self.send(event_loop, WindowEvent::DroppedFile(self.runtime.clone()));
        self.send(
            event_loop,
            WindowEvent::DroppedFile(self.root.join("tests/fixtures/asset-directory-v1")),
        );
        package_open::flush_drop(&mut self.app);
        assert!(self.app.package_open.is_none());
        self.send(event_loop, WindowEvent::DroppedFile(self.runtime.clone()));
        self.send(event_loop, WindowEvent::HoveredFileCancelled);
        package_open::flush_drop(&mut self.app);
        assert!(self.app.package_open.is_none());
        assert_eq!(self.app.renderer.as_ref().unwrap().id(), id);
        self.stage = 1;
        self.drop_path(event_loop, self.root.join("tests/fixtures/does-not-exist"));
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: GpuEvent) {
        if !matches!(event, GpuEvent::PackageOpened) {
            self.app.user_event(event_loop, event);
            return;
        }
        self.app.user_event(event_loop, event);
        match self.stage {
            1 => {
                assert_eq!(
                    self.app
                        .content
                        .active()
                        .runtime_package()
                        .unwrap()
                        .package_id,
                    "deep.runtime.author-lod.golden"
                );
                self.stage = 2;
                self.drop_path(
                    event_loop,
                    self.root.join("tests/fixtures/asset-directory-v1"),
                );
            }
            2 => {
                assert!(self.app.content.active().pending_asset_lkg.is_some());
                self.present(event_loop);
                assert!(
                    PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap())
                        .join("DeepEngineNative/asset-recovery")
                        .exists()
                );
                self.stage = 3;
                self.drop_path(
                    event_loop,
                    self.root
                        .join("tests/fixtures/asset-directory-v1/manifest.json"),
                );
            }
            3 => {
                assert!(self.app.content.active().pending_asset_lkg.is_some());
                self.present(event_loop);
                self.stage = 4;
                self.drop_path(event_loop, self.runtime.clone());
            }
            4 => {
                assert!(self.app.content.active().pending_lkg.is_some());
                self.present(event_loop);
                self.stage = 5;
                self.drop_path(
                    event_loop,
                    self.root
                        .join("tests/fixtures/runtime-package-prefiltered-ibl-v1.json"),
                );
            }
            5 => {
                assert!(matches!(
                    self.app.content.active().environment.provenance,
                    deep_engine_native::ibl::IblProvenance::ImportedHdri { .. }
                ));
                assert!(self.app.content.active().pending_lkg.is_some());
                self.present(event_loop);
                self.stage = 6;
                self.app
                    .renderer
                    .as_mut()
                    .unwrap()
                    .verify_environment_transaction_pixels(self.app.content.active());
                self.app
                    .renderer
                    .as_mut()
                    .unwrap()
                    .verify_source_domain_pixels(self.app.content.active());
                println!(
                    "native drop GPU events OK: multi/cancel/missing retain; directory/manifest/runtime/prefiltered IBL publish; checkpoint after present"
                );
                self.drop_path(
                    event_loop,
                    self.root
                        .join("tests/fixtures/runtime-package-camera-v3.json"),
                );
            }
            6 => {
                let expected = self.app.content.active().initial_view();
                assert_eq!(self.app.state.view, expected);
                let frame = self.app.renderer.as_ref().unwrap().camera_frame_for_test();
                for axis in 0..3 {
                    assert!((frame[8][axis] - expected.eye()[axis]).abs() < 0.00001);
                }
                assert_eq!(expected.far, 100000.0);
                self.present(event_loop);
                let old_id = self.app.renderer.as_ref().unwrap().id();
                let mut loaded =
                    deep_engine_native::runtime_package::parse_and_validate_runtime_package(
                        include_bytes!("../../tests/fixtures/runtime-package-camera-v3.json"),
                    )
                    .unwrap();
                loaded.camera.as_mut().unwrap().near = 100.0;
                loaded.camera.as_mut().unwrap().far = 1000.0;
                let invalid_candidate =
                    crate::player_content::PlayerContent::from_package(loaded).unwrap();
                assert!(
                    package_camera::stage_open_camera(&mut self.app, &invalid_candidate).is_err()
                );
                assert_eq!(self.app.renderer.as_ref().unwrap().id(), old_id);
                assert_eq!(self.app.state.view, expected);
                self.present(event_loop);
                self.stage = 7;
                self.drop_path(event_loop, self.runtime.clone());
            }
            7 => {
                assert_eq!(
                    self.app.state.view,
                    crate::player_state::PlayerView::default()
                );
                self.present(event_loop);
                self.stage = 8;
                println!(
                    "native camera drop GPU OK: v3 authored view committed, legacy view restored"
                );
                self.drop_path(
                    event_loop,
                    self.root
                        .join("../deep-engine/fixtures/dashboard-content-runtime-v1.json"),
                );
            }
            8 => {
                let renderer = self.app.renderer.as_ref().unwrap();
                assert_eq!(renderer.pipeline_counts(), (0, 0));
                assert_eq!(renderer.shadow_summary().depth_texture_bytes, 65536);
                assert!(self.app.content.active().packet().instances.is_empty());
                self.present(event_loop);
                self.stage = 9;
                self.drop_path(event_loop, self.runtime.clone());
            }
            9 => {
                let renderer = self.app.renderer.as_ref().unwrap();
                assert_eq!(renderer.pipeline_counts(), (12, 9));
                assert_eq!(renderer.shadow_summary().depth_texture_bytes, 67108864);
                assert!(!self.app.content.active().packet().instances.is_empty());
                self.present(event_loop);
                self.stage = 10;
                println!(
                    "native package-open profile GPU OK: 3D -> 2D -> 3D allocation and pipeline rebuilds committed"
                );
                event_loop.exit();
            }
            _ => panic!("unexpected drop probe stage"),
        }
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        self.app.window_event(event_loop, id, event);
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        assert!(
            self.started.elapsed() < Duration::from_secs(30),
            "drop probe timeout at {}",
            self.stage
        );
        self.app.about_to_wait(event_loop);
    }
}
