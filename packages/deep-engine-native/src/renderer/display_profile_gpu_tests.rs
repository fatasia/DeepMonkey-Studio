use super::Renderer;
use crate::{events::GpuEvent, player_content::PlayerContent};
use deep_engine_native::output_color_profile::OutputColorProfile;
use std::sync::Arc;
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy},
    platform::windows::EventLoopBuilderExtWindows,
};

const TEST: &str = "renderer::content_profile::display_profile_gpu_tests::black_background_profile_change_rebuilds_output_epoch";

#[test]
#[ignore = "requires actual Windows GPU surface"]
fn black_background_profile_change_rebuilds_output_epoch() {
    const CHILD: &str = "DEEP_DISPLAY_PROFILE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--ignored", "--nocapture"])
            .env(CHILD, "1")
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
    let mut builder = EventLoop::<GpuEvent>::with_user_event();
    builder.with_any_thread(true);
    let event_loop = builder.build().unwrap();
    let mut probe = Probe {
        proxy: event_loop.create_proxy(),
        verified: false,
    };
    event_loop.run_app(&mut probe).unwrap();
    assert!(probe.verified);
}

struct Probe {
    proxy: EventLoopProxy<GpuEvent>,
    verified: bool,
}
fn content(profile: OutputColorProfile) -> PlayerContent {
    let mut package = deep_engine_native::runtime_package::parse_and_validate_runtime_package(
        include_bytes!("../../tests/fixtures/runtime-package-v1.json"),
    )
    .unwrap();
    package.background = Some([0.0; 3]);
    package.display_profile = profile;
    PlayerContent::from_package(package).unwrap()
}

impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        let window = Arc::new(
            event_loop
                .create_window(crate::app_startup::window_attributes(true))
                .unwrap(),
        );
        let legacy = content(OutputColorProfile::DeepAces);
        let selected = content(OutputColorProfile::ThreeAcesR185);
        assert_eq!(legacy.background, selected.background);
        let features = crate::renderer::RendererFeatures {
            bloom: deep_engine_native::bloom::BloomSettings::DISABLED,
            fog: deep_engine_native::fog::FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        };
        let mut old = pollster::block_on(Renderer::new_candidate(
            window.clone(),
            self.proxy.clone(),
            1,
            &legacy,
            legacy.initial_view(),
            features,
        ))
        .unwrap();
        old.verify_candidate_frame().unwrap();
        assert_eq!(
            old.output_pass.display_profile(),
            OutputColorProfile::DeepAces
        );
        assert!(!old.requires_content_rebuild(&legacy));
        assert!(old.requires_content_rebuild(&selected));
        assert!(
            pollster::block_on(old.stage_render_packet_update(legacy.packet(), &selected)).is_err()
        );
        old.verify_candidate_frame().unwrap();
        let mut next = pollster::block_on(Renderer::new_candidate(
            window,
            self.proxy.clone(),
            2,
            &selected,
            selected.initial_view(),
            features,
        ))
        .unwrap();
        next.verify_candidate_frame().unwrap();
        assert_eq!(
            next.output_pass.display_profile(),
            OutputColorProfile::ThreeAcesR185
        );
        assert!(!next.requires_content_rebuild(&selected));
        assert!(next.requires_content_rebuild(&legacy));
        println!(
            "black background profile-only transition: stale incremental epoch rejected; old and new actual GPU frames valid"
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
