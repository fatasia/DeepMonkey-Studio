use deep_engine_native::bloom::BloomSettings;
use winit::event_loop::{ControlFlow, EventLoop};

use crate::{events::GpuEvent, player_content::PlayerContent, renderer::RendererFeatures};

use super::{NativeApp, ShadowUpdateProbe};

pub fn run(
    content: PlayerContent,
    smoke_frame: bool,
    shadow_probe: bool,
    ibl_probe: bool,
    bloom: BloomSettings,
) -> Result<(), String> {
    run_internal(
        content,
        smoke_frame,
        RendererFeatures {
            bloom,
            shadow_probe,
            ibl_probe,
        },
        None,
    )
}

pub fn run_shadow_update_probe(
    content: PlayerContent,
    rejected: PlayerContent,
    out_of_range: PlayerContent,
    replacement: PlayerContent,
) -> Result<(), String> {
    run_internal(
        content,
        true,
        RendererFeatures {
            bloom: BloomSettings::default(),
            shadow_probe: true,
            ibl_probe: false,
        },
        Some(ShadowUpdateProbe::new(rejected, out_of_range, replacement)),
    )
}

fn run_internal(
    content: PlayerContent,
    smoke_frame: bool,
    features: RendererFeatures,
    shadow_update_probe: Option<ShadowUpdateProbe>,
) -> Result<(), String> {
    let event_loop = EventLoop::<GpuEvent>::with_user_event()
        .build()
        .map_err(|error| format!("event loop creation failed: {error}"))?;
    event_loop.set_control_flow(ControlFlow::Wait);
    let proxy = event_loop.create_proxy();
    let mut app = NativeApp::new(content, proxy, smoke_frame, features, shadow_update_probe);
    event_loop
        .run_app(&mut app)
        .map_err(|error| format!("native event loop failed: {error}"))?;
    app.state.failure.map_or(Ok(()), Err)
}
