use super::*;
use deep_engine_native::chart::{ChartDataMessage, DatasetRowsUpdate};
use winit::platform::windows::EventLoopBuilderExtWindows;

const TEST: &str =
    "app::dashboard_gpu_tests::dashboard_updates_present_atomically_in_the_window_host";

#[test]
#[ignore = "requires a real Windows GPU surface"]
fn dashboard_updates_present_atomically_in_the_window_host() {
    const CHILD: &str = "DEEP_DASHBOARD_PROBE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--ignored", "--nocapture"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        println!("{}", String::from_utf8_lossy(&output.stdout));
        return;
    }
    let package = deep_engine_native::runtime_package::parse_and_validate_runtime_package(
        include_bytes!("../../../deep-engine/fixtures/dashboard-composition-v1.json"),
    )
    .unwrap();
    let content = PlayerContent::from_package(package).unwrap();
    let mut builder = winit::event_loop::EventLoop::<GpuEvent>::with_user_event();
    builder.with_any_thread(true);
    let event_loop = builder.build().unwrap();
    let app = NativeApp::new(
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
        let size = winit::dpi::PhysicalSize::new(960, 540);
        self.app.window = Some(Arc::new(
            event_loop
                .create_window(crate::app_startup::window_attributes(true).with_inner_size(size))
                .unwrap(),
        ));
        self.app.initialize_renderer();
        assert!(self.app.state.failure.is_none());
        assert!(matches!(
            self.app.renderer.as_mut().unwrap().render(true),
            crate::events::RenderOutcome::Presented
        ));
        self.run_checks();
        self.check_recovery_and_schedule(event_loop);
        self.verified = true;
        event_loop.exit();
    }
    fn window_event(&mut self, _: &ActiveEventLoop, _: WindowId, _: WindowEvent) {}
}

impl Probe {
    fn check_recovery_and_schedule(&mut self, event_loop: &ActiveEventLoop) {
        let before = self.app.content.active().deep2d.clone();
        let renderer = self.app.renderer.as_ref().unwrap().id();
        // Inject the acquisition outcome, then exercise the real renderer rebuild.
        assert!(
            !dashboard::presented(&mut self.app, crate::events::RenderOutcome::Recover).unwrap()
        );
        assert_ne!(renderer, self.app.renderer.as_ref().unwrap().id());
        assert_eq!(self.app.content.active().deep2d, before);
        assert!(matches!(
            self.app.renderer.as_mut().unwrap().render(true),
            crate::events::RenderOutcome::Presented
        ));
        // A new content clock discards the previous package's distant wake deadline.
        self.app.dashboard_wake_at =
            Some(std::time::Instant::now() + std::time::Duration::from_secs(3600));
        self.app.content.active_mut().dashboard_started = None;
        dashboard::tick(&mut self.app, event_loop);
        assert!(self.app.chart_sim_scheduled);
        assert!(
            self.app.dashboard_wake_at.unwrap()
                < std::time::Instant::now() + std::time::Duration::from_secs(10)
        );
        let held = self.app.content.active().deep2d.clone();
        let wake = self.app.dashboard_wake_at;
        dashboard::tick(&mut self.app, event_loop);
        assert_eq!(self.app.dashboard_wake_at, wake);
        assert_eq!(self.app.content.active().deep2d, held);
        // Ordinary content's existing scheduler must clear dashboard's pending wake.
        chart_sim::tick(&mut self.app, event_loop);
        assert!(!self.app.chart_sim_scheduled);
        assert!(matches!(
            event_loop.control_flow(),
            winit::event_loop::ControlFlow::Wait
        ));
    }

    fn run_checks(&mut self) {
        let runtime = self.app.content.active().dashboard.as_ref().unwrap();
        let pages: Vec<_> = runtime
            .document()
            .pages
            .iter()
            .map(|page| page.id.clone())
            .collect();
        let nodes: Vec<_> = runtime.document().pages[0]
            .nodes
            .iter()
            .filter(|node| node.chart.is_some())
            .map(|node| node.id.clone())
            .collect();
        assert_eq!(nodes.len(), 2);
        let before = runtime.content().clone();
        assert!(dashboard::update(&mut self.app, |next| next.switch_page("missing-page")).is_err());
        assert_eq!(
            self.app
                .content
                .active()
                .dashboard
                .as_ref()
                .unwrap()
                .content(),
            &before
        );

        let message = replacement(
            self.app.content.active().dashboard.as_ref().unwrap(),
            &nodes[0],
        );
        let other_revision = self
            .app
            .content
            .active()
            .dashboard
            .as_ref()
            .unwrap()
            .chart(&nodes[1])
            .unwrap()
            .data_revision();
        assert!(
            dashboard::update(&mut self.app, |next| next.apply_data(&nodes[0], message)).unwrap()
        );
        assert_eq!(
            self.app
                .content
                .active()
                .dashboard
                .as_ref()
                .unwrap()
                .chart(&nodes[1])
                .unwrap()
                .data_revision(),
            other_revision
        );
        assert_ne!(self.app.content.active().deep2d.as_ref().unwrap(), &before);

        // 无可呈现表面时，已准备的有效候选也不能推进数据或模拟游标。
        self.app
            .renderer
            .as_mut()
            .unwrap()
            .resize(winit::dpi::PhysicalSize::new(0, 0))
            .unwrap();
        let before_skip = self
            .app
            .content
            .active()
            .dashboard
            .as_ref()
            .unwrap()
            .content()
            .clone();
        let before_scale = self
            .app
            .content
            .active()
            .dashboard
            .as_ref()
            .unwrap()
            .text_scale();
        assert!(!dashboard::update(&mut self.app, |next| next.set_text_scale(1.5)).unwrap());
        assert_eq!(
            self.app
                .content
                .active()
                .dashboard
                .as_ref()
                .unwrap()
                .text_scale(),
            before_scale
        );
        assert_eq!(
            self.app.content.active().deep2d.as_ref().unwrap(),
            &before_skip
        );
        assert!(!dashboard::update(&mut self.app, |next| next.tick(0)).unwrap());
        assert_eq!(
            self.app
                .content
                .active()
                .dashboard
                .as_ref()
                .unwrap()
                .content(),
            &before_skip
        );
        self.app
            .renderer
            .as_mut()
            .unwrap()
            .resize(self.app.window.as_ref().unwrap().inner_size())
            .unwrap();
        assert!(dashboard::update(&mut self.app, |next| next.tick(0)).unwrap());
        assert!(dashboard::update(&mut self.app, |next| next.set_text_scale(1.5)).unwrap());
        assert_eq!(
            self.app
                .content
                .active()
                .dashboard
                .as_ref()
                .unwrap()
                .text_scale(),
            1.5
        );
        let expected_scale = super::text_scale::effective_scale(&self.app).unwrap();
        super::text_scale::refresh(&mut self.app);
        assert_eq!(
            self.app
                .content
                .active()
                .dashboard
                .as_ref()
                .unwrap()
                .text_scale(),
            expected_scale
        );
        assert!(
            self.app
                .content
                .active()
                .dashboard
                .as_ref()
                .unwrap()
                .chart(&nodes[1])
                .unwrap()
                .data_revision()
                > other_revision
        );

        assert!(dashboard::key(
            &mut self.app,
            winit::keyboard::KeyCode::PageDown
        ));
        assert_eq!(
            self.app
                .content
                .active()
                .dashboard
                .as_ref()
                .unwrap()
                .active_page_id(),
            pages[1]
        );
        assert!(dashboard::key(
            &mut self.app,
            winit::keyboard::KeyCode::PageUp
        ));
        assert_eq!(
            self.app
                .content
                .active()
                .dashboard
                .as_ref()
                .unwrap()
                .active_page_id(),
            pages[0]
        );
        println!(
            "dashboard host: independent chart data, skipped frame rollback, sim retry and page keys passed"
        );
    }
}

fn replacement(
    runtime: &deep_engine_native::dashboard_runtime::DashboardRuntime,
    node: &str,
) -> ChartDataMessage {
    let chart = runtime.chart(node).unwrap();
    let dataset = &chart.source().datasets[0];
    let mut rows = dataset.rows.to_vec();
    rows[0][1] = serde_json::json!(7);
    ChartDataMessage {
        schema: "deep-engine.chart-data-update".into(),
        schema_version: 1,
        chart_id: chart.source().id.clone(),
        expected_data_revision: chart.data_revision(),
        data_revision: chart.data_revision() + 1,
        datasets: vec![DatasetRowsUpdate::Replace {
            dataset_id: dataset.id.clone(),
            rows,
        }],
    }
}
