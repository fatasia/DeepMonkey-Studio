use super::*;
use winit::platform::windows::EventLoopBuilderExtWindows;

#[test]
#[ignore = "requires actual production filter package and Windows GPU surface"]
fn production_filter_preserves_selection_and_rows_until_presented() {
    const TEST: &str = "app::dashboard_filter_gpu_tests::production_filter_preserves_selection_and_rows_until_presented";
    if std::env::var_os("DEEP_FILTER_PROBE_CHILD").is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--ignored", "--nocapture"])
            .env("DEEP_FILTER_PROBE_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        println!("{}", String::from_utf8_lossy(&result.stdout));
        return;
    }
    let bytes =
        std::fs::read(std::env::var("DEEP_FILTER_PACKAGE").expect("production package required"))
            .unwrap();
    let package =
        deep_engine_native::runtime_package::parse_and_validate_runtime_package(&bytes).unwrap();
    let content = PlayerContent::from_package(package).unwrap();
    let mut builder = winit::event_loop::EventLoop::<GpuEvent>::with_user_event();
    builder.with_any_thread(true);
    let event_loop = builder.build().unwrap();
    let app = NativeApp::new(
        content,
        event_loop.create_proxy(),
        NativeAppSetup {
            dynamic_playback: None,
            state_ops: None,
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
            telemetry_prepare_replay: None,
            telemetry_report: false,
            selection_probe: false,
            section_probe: false,
            chart_key_probe: false,
        },
    );
    let mut probe = Probe {
        app,
        verified: false,
    };
    event_loop.run_app(&mut probe).unwrap();
    assert!(probe.verified);
}
struct Probe {
    app: NativeApp,
    verified: bool,
}
impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.app.window = Some(Arc::new(
            event_loop
                .create_window(
                    crate::app_startup::window_attributes(true)
                        .with_inner_size(winit::dpi::PhysicalSize::new(960, 540)),
                )
                .unwrap(),
        ));
        self.app.initialize_renderer();
        assert!(self.app.state.failure.is_none());
        let before = self
            .app
            .content
            .active()
            .dashboard
            .as_ref()
            .unwrap()
            .clone();
        let filter = before.document().filter.as_ref().unwrap();
        let target = filter.options[0].updates[0].node_id.clone();
        assert_eq!(before.selected_filter(), Some(0));
        let hit = before.hit([60.0, 355.0]);
        assert_eq!(
            hit.as_ref().map(|value| value.node_id.as_str()),
            Some(filter.node_id.as_str()),
            "{hit:?}"
        );
        self.app
            .renderer
            .as_mut()
            .unwrap()
            .resize(winit::dpi::PhysicalSize::new(0, 0))
            .unwrap();
        assert!(!dashboard::update(&mut self.app, |next| next.select_filter(1)).unwrap());
        let retained = self.app.content.active().dashboard.as_ref().unwrap();
        assert_eq!(retained.selected_filter(), before.selected_filter());
        assert_eq!(
            retained.chart(&target).unwrap().source(),
            before.chart(&target).unwrap().source()
        );
        assert_eq!(retained.content(), before.content());
        self.app
            .renderer
            .as_mut()
            .unwrap()
            .resize(self.app.window.as_ref().unwrap().inner_size())
            .unwrap();
        assert!(
            dashboard::update(&mut self.app, |next| next
                .pointer(Some([60.0, 355.0]), true))
            .unwrap()
        );
        assert_eq!(
            self.app
                .content
                .active()
                .dashboard
                .as_ref()
                .unwrap()
                .selected_filter(),
            Some(1)
        );
        assert!(!dashboard::update(&mut self.app, |next| next.select_filter(1)).unwrap());
        assert!(dashboard::update(&mut self.app, |next| next.select_filter(99)).is_err());
        assert_eq!(
            self.app
                .content
                .active()
                .dashboard
                .as_ref()
                .unwrap()
                .selected_filter(),
            Some(1)
        );
        assert!(dashboard::key(
            &mut self.app,
            winit::keyboard::KeyCode::ArrowDown
        ));
        assert_eq!(
            self.app
                .content
                .active()
                .dashboard
                .as_ref()
                .unwrap()
                .selected_filter(),
            Some(2)
        );
        assert!(dashboard::update(&mut self.app, |next| next.select_filter(0)).unwrap());
        assert_eq!(
            self.app
                .content
                .active()
                .dashboard
                .as_ref()
                .unwrap()
                .chart(&target)
                .unwrap()
                .source(),
            before.chart(&target).unwrap().source()
        );
        println!(
            "filter GPU transaction OK: skipped retains frame/selection/rows; recovery commits; invalid/repeat hold; keyboard commits; all restores"
        );
        self.verified = true;
        event_loop.exit();
    }
    fn window_event(&mut self, _: &ActiveEventLoop, _: WindowId, _: WindowEvent) {}
}
