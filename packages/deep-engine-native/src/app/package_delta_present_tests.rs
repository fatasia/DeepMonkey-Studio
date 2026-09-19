use super::*;
use crate::app::{
    NativeAppSetup,
    package_watch::delta_tests::{fixture, snapshot, source},
};
use deep_engine_native::runtime_package::build_runtime_package_delta;
use std::time::{Duration, Instant};
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop},
    platform::windows::EventLoopBuilderExtWindows,
};

#[test]
#[ignore = "requires a real Windows GPU surface"]
fn delta_checkpoint_advances_only_after_real_present_and_restart_recovers() {
    run(
        "delta_checkpoint_advances_only_after_real_present_and_restart_recovers",
        fixture,
    );
}

#[test]
#[ignore = "requires a real Windows GPU surface"]
fn deep2d_delta_checkpoint_advances_only_after_real_present() {
    run(
        "deep2d_delta_checkpoint_advances_only_after_real_present",
        crate::app::package_watch::delta_tests::deep2d_fixture,
    );
}

fn run(name: &str, fixture: fn(u64) -> Vec<u8>) {
    const CHILD: &str = "DEEP_DELTA_PRESENT_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!("app::package_live::delta_present_tests::{name}"),
                "--ignored",
                "--nocapture",
            ])
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
    let path = source();
    std::fs::write(&path, fixture(0)).unwrap();
    let content = crate::runtime_package_startup::load_auto(&path)
        .unwrap()
        .into_content();
    let mut builder = EventLoop::<GpuEvent>::with_user_event();
    builder.with_any_thread(true);
    let event_loop = builder.build().unwrap();
    let mailbox = LatestMailbox::default();
    let published = Arc::new(RwLock::new(content.runtime_package().unwrap().clone()));
    let transport = PackageLiveTransport {
        _watcher: package_watch::spawn(
            path.clone(),
            mailbox.clone(),
            published.clone(),
            event_loop.create_proxy(),
            package_watch::ordinary_decoder,
        ),
        mailbox: mailbox.clone(),
        published: published.clone(),
        retry: None,
    };
    let app = NativeApp::new(
        content,
        event_loop.create_proxy(),
        NativeAppSetup {
            dynamic_playback: None,
            smoke_frame: true,
            features: crate::renderer::RendererFeatures {
                bloom: Default::default(),
                fog: deep_engine_native::fog::FogSettings::DISABLED,
                shadow_probe: false,
                ibl_probe: false,
                telemetry: false,
            },
            shadow_update_probe: None,
            packet_live_probe: None,
            packet_live_transport: None,
            package_live_transport: Some(transport),
            telemetry_report: false,
            selection_probe: false,
            section_probe: false,
            chart_key_probe: false,
        },
    );
    let mut probe = Probe {
        app,
        path,
        mailbox,
        published,
        verified: false,
        fixture,
    };
    event_loop.run_app(&mut probe).unwrap();
    assert!(probe.verified);
    probe.app.package_live_transport.take();
    std::fs::remove_file(probe.path).unwrap();
}

struct Probe {
    app: NativeApp,
    path: PathBuf,
    mailbox: LatestMailbox<WatchedPackage>,
    published: Arc<RwLock<RuntimePackageSnapshot>>,
    verified: bool,
    fixture: fn(u64) -> Vec<u8>,
}

impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.app.resumed(event_loop);
        let fixture = self.fixture;
        let base = fixture(0);
        let target = fixture(1);
        let old_hash = snapshot(&base).package_hash;
        let store = crate::runtime_lkg::Store::local(&self.path).unwrap();
        // Initial frame uses the production presentation path before establishing its checkpoint.
        let outcome = self.app.renderer.as_mut().unwrap().render(true);
        assert!(matches!(outcome, crate::events::RenderOutcome::Presented));
        crate::runtime_package_startup::presented(self.app.content.active_mut());
        assert_eq!(snapshot(&store.restore().unwrap()).package_hash, old_hash);
        let delta = build_runtime_package_delta(&base, &target).unwrap();
        self.app
            .renderer
            .as_mut()
            .unwrap()
            .resize(winit::dpi::PhysicalSize::new(0, 0))
            .unwrap();
        std::fs::write(&self.path, &delta).unwrap();
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: GpuEvent) {
        assert!(
            !matches!(event, GpuEvent::SmokeTimeout),
            "file watcher timed out"
        );
        if !matches!(event, GpuEvent::PackageArrived) {
            return;
        }
        self.app.user_event(event_loop, event);
        let fixture = self.fixture;
        let base = fixture(0);
        let target = fixture(1);
        let delta = build_runtime_package_delta(&base, &target).unwrap();
        let old_hash = snapshot(&base).package_hash;
        let store = crate::runtime_lkg::Store::local(&self.path).unwrap();
        let size = self.app.window.as_ref().unwrap().inner_size();
        assert_eq!(self.published.read().unwrap().package_hash, old_hash);
        assert_eq!(snapshot(&store.restore().unwrap()).package_hash, old_hash);
        assert!(
            self.app
                .package_live_transport
                .as_ref()
                .unwrap()
                .retry
                .is_some()
        );
        self.app.renderer.as_mut().unwrap().resize(size).unwrap();
        for _ in 0..30 {
            if !retry(
                &mut self.app,
                event_loop,
                Instant::now() + Duration::from_secs(1),
            ) {
                break;
            }
        }
        let target_hash = snapshot(&target).package_hash;
        assert_eq!(self.published.read().unwrap().package_hash, target_hash);
        assert_eq!(
            snapshot(&store.restore().unwrap()).package_hash,
            target_hash
        );
        assert!(self.app.content.active().pending_lkg.is_none());
        assert!(
            package_watch::ordinary_decoder(&delta, &self.path, &snapshot(&target))
                .unwrap()
                .is_none()
        );
        assert!(
            package_watch::ordinary_decoder(b"broken", &self.path, &snapshot(&target)).is_err()
        );
        // A delta prepared against the old base must not roll back a newer presentation.
        let mut stale = package_watch::ordinary_decoder(
            &build_runtime_package_delta(&target, &fixture(2)).unwrap(),
            &self.path,
            &snapshot(&target),
        )
        .unwrap()
        .unwrap();
        stale.base_package_hash = Some(old_hash);
        self.mailbox.push(2, stale);
        apply_latest(&mut self.app);
        assert_eq!(self.published.read().unwrap().package_hash, target_hash);
        assert_eq!(
            snapshot(&store.restore().unwrap()).package_hash,
            target_hash
        );
        let recovered = crate::runtime_package_startup::load_auto(&self.path)
            .unwrap()
            .into_content();
        assert_eq!(
            recovered.runtime_package().unwrap().package_hash,
            target_hash
        );
        println!(
            "delta filesystem watcher and GPU present verified: zero-size deferred; target presented; complete LKG committed; stale and broken candidates retained LKG; restart restored target"
        );
        self.verified = true;
        event_loop.exit();
    }
    fn window_event(
        &mut self,
        _: &ActiveEventLoop,
        _: winit::window::WindowId,
        _: winit::event::WindowEvent,
    ) {
    }
}
