use super::*;
use crate::events::GpuEvent;
use winit::{
    application::ApplicationHandler,
    event_loop::{ActiveEventLoop, EventLoop},
    platform::windows::EventLoopBuilderExtWindows,
};

const TEST: &str = "renderer::content_profile_gpu_tests::two_dimensional_allocation_and_three_dimensional_transition";

#[test]
#[ignore = "requires a real Windows GPU surface"]
fn two_dimensional_allocation_and_three_dimensional_transition() {
    const CHILD: &str = "DEEP_CONTENT_PROFILE_CHILD";
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

impl ApplicationHandler<GpuEvent> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        let window = Arc::new(
            event_loop
                .create_window(crate::app_startup::window_attributes(true))
                .unwrap(),
        );
        let two = load(include_bytes!(
            "../../../deep-engine/fixtures/dashboard-content-runtime-v1.json"
        ));
        let three = load(include_bytes!(
            "../../tests/fixtures/runtime-package-v1.json"
        ));
        let features = RendererFeatures {
            bloom: deep_engine_native::bloom::BloomSettings::DISABLED,
            fog: deep_engine_native::fog::FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        };
        let mut renderer = pollster::block_on(Renderer::new_candidate(
            window.clone(),
            self.proxy.clone(),
            1,
            &two,
            two.initial_view(),
            features,
        ))
        .unwrap();
        renderer.verify_candidate_frame().unwrap();
        assert!(renderer.content_profile.compact_forward_targets);
        assert_eq!(renderer.forward_targets.resolved_texture().size().width, 1);
        assert_eq!(renderer.forward_targets.resolved_texture().size().height, 1);
        renderer.resize(PhysicalSize::new(980, 617)).unwrap();
        renderer.verify_candidate_frame().unwrap();
        assert_eq!(renderer.forward_targets.resolved_texture().size().width, 1);
        assert_eq!(renderer.config.width, 980);
        assert_eq!(renderer.config.height, 617);
        renderer.activate_surface();
        assert!(matches!(
            renderer.render(true),
            crate::events::RenderOutcome::Presented
        ));
        renderer.resize(PhysicalSize::new(0, 0)).unwrap();
        assert!(matches!(
            renderer.render(true),
            crate::events::RenderOutcome::Skipped
        ));
        renderer.resize(PhysicalSize::new(1280, 720)).unwrap();
        assert!(matches!(
            renderer.render(true),
            crate::events::RenderOutcome::Presented
        ));
        assert_eq!(renderer.forward_targets.resolved_texture().size().width, 1);
        let compact = renderer.shadow_summary();
        assert_eq!(compact.depth_texture_bytes, 65536);
        assert_eq!(renderer.pipeline_counts(), (0, 0));
        assert!(!renderer.requires_content_rebuild(&two));
        assert!(renderer.requires_content_rebuild(&three));
        // The incremental API must not render incoming 3D with the compact allocation.
        assert!(
            pollster::block_on(renderer.stage_render_packet_update(two.packet(), &three)).is_err()
        );
        assert_eq!(renderer.shadow_summary(), compact);
        renderer.verify_candidate_frame().unwrap();
        let mut full = pollster::block_on(Renderer::new_candidate(
            window.clone(),
            self.proxy.clone(),
            2,
            &three,
            three.initial_view(),
            features,
        ))
        .unwrap();
        full.verify_candidate_frame().unwrap();
        assert!(!full.content_profile.compact_forward_targets);
        assert_eq!(
            full.forward_targets.resolved_texture().size().width,
            full.size.width
        );
        assert_eq!(full.shadow_summary().depth_texture_bytes, 67108864);
        assert_eq!(full.pipeline_counts(), (18, 9));
        assert!(!full.requires_content_rebuild(&three));
        assert!(full.requires_content_rebuild(&two));
        // A same-profile edit remains incremental; failed validation keeps the previous allocation.
        pollster::block_on(full.replace_render_packet(three.packet(), &three)).unwrap();
        let mut compact_again = pollster::block_on(Renderer::new_candidate(
            window,
            self.proxy.clone(),
            3,
            &two,
            two.initial_view(),
            features,
        ))
        .unwrap();
        compact_again.verify_candidate_frame().unwrap();
        assert!(compact_again.content_profile.compact_forward_targets);
        assert_eq!(
            compact_again
                .forward_targets
                .resolved_texture()
                .size()
                .width,
            1
        );
        assert_eq!(compact_again.shadow_summary().depth_texture_bytes, 65536);
        assert_eq!(compact_again.pipeline_counts(), (0, 0));
        println!(
            "2D/3D/2D verified: shadow depth bytes 65536 -> 67108864 -> 65536; rejected incremental transition preserves old frame"
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

fn load(bytes: &[u8]) -> PlayerContent {
    PlayerContent::from_package(
        deep_engine_native::runtime_package::parse_and_validate_runtime_package(bytes).unwrap(),
    )
    .unwrap()
}
