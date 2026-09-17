use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn run_internal(
    content: PlayerContent,
    smoke_frame: bool,
    features: RendererFeatures,
    shadow_update_probe: Option<ShadowUpdateProbe>,
    packet_live: Option<PacketLiveSpec>,
    package_live: Option<PackageLiveSpec>,
    report: ReportMode,
) -> Result<(), String> {
    let event_loop = EventLoop::<GpuEvent>::with_user_event()
        .build()
        .map_err(|error| format!("event loop creation failed: {error}"))?;
    event_loop.set_control_flow(ControlFlow::Wait);
    let proxy = event_loop.create_proxy();
    let packet_live_probe = packet_live
        .as_ref()
        .and_then(|spec| live_probe(&spec.watch_path, &spec.smoke_rewrite, None, proxy.clone()))
        .or_else(|| {
            package_live.as_ref().and_then(|spec| {
                live_probe(
                    &spec.watch_path,
                    &spec.smoke_rewrite,
                    spec.smoke_rejected_rewrite.clone(),
                    proxy.clone(),
                )
            })
        });
    let packet_live_transport = packet_live.as_ref().map(|spec| {
        packet_live::start(
            spec.watch_path.clone(),
            content.scene_content_key(),
            proxy.clone(),
        )
    });
    let package_live_transport = if let Some(spec) = package_live.as_ref() {
        let published = content
            .runtime_package()
            .cloned()
            .ok_or("package live mode requires runtime package metadata")?;
        Some(package_live::start(
            spec.watch_path.clone(),
            published,
            proxy.clone(),
        ))
    } else {
        None
    };
    let mut app = NativeApp::new(
        content,
        proxy,
        NativeAppSetup {
            smoke_frame,
            features,
            shadow_update_probe,
            packet_live_probe,
            packet_live_transport,
            package_live_transport,
            telemetry_report: matches!(report, ReportMode::Telemetry),
            selection_probe: matches!(report, ReportMode::Selection),
            section_probe: matches!(report, ReportMode::Section),
            chart_key_probe: matches!(report, ReportMode::ChartKeyboard),
        },
    );
    if let ReportMode::Verification(verification) = report {
        app.state.verification = Some(verification);
    }
    event_loop
        .run_app(&mut app)
        .map_err(|error| format!("native event loop failed: {error}"))?;
    #[cfg(windows)]
    app.x_runtime.take();
    if let Some(error) = app.state.failure {
        return Err(error);
    }
    if let Some(verification) = app.state.verification {
        verification.finish()?;
    }
    Ok(())
}

fn live_probe(
    path: &std::path::Path,
    rewrite: &Option<Vec<u8>>,
    rejected_rewrite: Option<Vec<u8>>,
    proxy: winit::event_loop::EventLoopProxy<GpuEvent>,
) -> Option<PacketLiveProbe> {
    rewrite
        .as_ref()
        .map(|bytes| PacketLiveProbe::new(path.to_owned(), bytes.clone(), rejected_rewrite, proxy))
}
