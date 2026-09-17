use super::*;
use crate::app::{NativeAppSetup, watch_thread::WatchThread};
use crate::{player_content::PlayerContent, renderer::RendererFeatures};
use std::time::{Duration, Instant};
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop},
    platform::windows::EventLoopBuilderExtWindows,
};

const TEST: &str =
    "app::packet_live::present_tests::skipped_packet_updates_retain_state_and_only_retry_latest";

#[test]
#[ignore = "requires a real Windows GPU surface"]
fn skipped_packet_updates_retain_state_and_only_retry_latest() {
    const CHILD: &str = "DEEP_PACKET_PRESENT_CHILD";
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
    let mut builder = EventLoop::<GpuEvent>::with_user_event();
    builder.with_any_thread(true);
    let event_loop = builder.build().unwrap();
    let content = content(0.0);
    let key = content.scene_content_key();
    let mailbox = LatestMailbox::default();
    let published_key = Arc::new(AtomicU64::new(key));
    let transport = PacketLiveTransport {
        // 本测试注入已经验证的解码结果；文件监听另由真实 CLI smoke 覆盖。
        _watcher: WatchThread::spawn(|_| {}),
        mailbox: mailbox.clone(),
        published_key: published_key.clone(),
        retry: None,
    };
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
            packet_live_transport: Some(transport),
            package_live_transport: None,
            telemetry_report: false,
            selection_probe: false,
            section_probe: false,
            chart_key_probe: false,
        },
    );
    let mut probe = Probe {
        app,
        mailbox,
        published_key,
        verified: false,
    };
    event_loop.run_app(&mut probe).unwrap();
    assert!(probe.verified);
}

struct Probe {
    app: NativeApp,
    mailbox: LatestMailbox<WatchedPacket>,
    published_key: Arc<AtomicU64>,
    verified: bool,
}
impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.app.resumed(event_loop);
        let old_key = self.app.content.active().scene_content_key();
        let before = self.app.renderer.as_ref().unwrap().scene_update_evidence();
        let size = self.app.window.as_ref().unwrap().inner_size();
        self.app
            .renderer
            .as_mut()
            .unwrap()
            .resize(winit::dpi::PhysicalSize::new(0, 0))
            .unwrap();
        for generation in 1..=2 {
            let content = content(generation as f32);
            let key = content.scene_content_key();
            self.mailbox.push(
                generation,
                WatchedPacket {
                    content: Box::new(content),
                    key,
                },
            );
            apply_latest(&mut self.app);
            assert_eq!(self.app.content.active().scene_content_key(), old_key);
            assert_eq!(self.published_key.load(Ordering::Acquire), old_key);
            assert_eq!(self.app.packet_coalescer.published(), 0);
            let after = self.app.renderer.as_ref().unwrap().scene_update_evidence();
            assert_eq!(before.bounds, after.bounds);
            assert_eq!(before.shadow_version, after.shadow_version);
            assert_eq!(before.cache_live, after.cache_live);
            assert_eq!(
                self.app
                    .packet_live_transport
                    .as_ref()
                    .unwrap()
                    .retry
                    .as_ref()
                    .unwrap()
                    .1,
                generation
            );
        }
        assert!(retry(&mut self.app, event_loop, Instant::now()));
        assert_eq!(self.app.packet_coalescer.published(), 0);
        let old_renderer_id = self.app.renderer.as_ref().unwrap().id();
        assert!(
            !crate::app::dashboard::presented(&mut self.app, crate::events::RenderOutcome::Recover)
                .unwrap()
        );
        assert_ne!(self.app.renderer.as_ref().unwrap().id(), old_renderer_id);
        assert_eq!(self.app.content.active().scene_content_key(), old_key);
        assert_eq!(self.published_key.load(Ordering::Acquire), old_key);
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
        assert_eq!(self.app.packet_coalescer.published(), 2);
        assert_eq!(
            self.app.content.active().scene_content_key(),
            content(2.0).scene_content_key()
        );
        assert_eq!(
            self.published_key.load(Ordering::Acquire),
            self.app.content.active().scene_content_key()
        );
        assert!(
            self.app
                .packet_live_transport
                .as_ref()
                .unwrap()
                .retry
                .is_none()
        );
        let published = self.app.renderer.as_ref().unwrap().scene_update_evidence();
        assert_ne!(published.bounds, before.bounds);
        // 同修订修改几何：必须在呈现前拒绝，并保留已呈现的 generation 2。
        let mut invalid = content(3.0);
        invalid.mutate_packet_for_test(|packet| packet.geometries[0].vertices[0] += 1.0);
        let key = invalid.scene_content_key();
        self.mailbox.push(
            3,
            WatchedPacket {
                content: Box::new(invalid),
                key,
            },
        );
        apply_latest(&mut self.app);
        assert_eq!(self.app.packet_coalescer.published(), 2);
        assert!(self.app.packet_coalescer.is_failed(3));
        assert_eq!(
            self.app.renderer.as_ref().unwrap().scene_update_evidence(),
            published
        );
        assert_eq!(
            self.published_key.load(Ordering::Acquire),
            content(2.0).scene_content_key()
        );
        println!(
            "packet present barrier: skipped generations 1/2 retained old CPU/cache; latest retry presented generation 2; invalid generation 3 retained published state"
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

fn content(offset: f32) -> PlayerContent {
    let package = deep_engine_native::runtime_package::parse_and_validate_runtime_package(
        include_bytes!("../../tests/fixtures/runtime-package-v1.json"),
    )
    .unwrap();
    let mut packet = package.render_packet;
    packet.instances[0].transform[12] += offset;
    PlayerContent::from_packet(packet, None)
}
