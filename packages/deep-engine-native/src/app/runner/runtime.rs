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
    dynamic_playback: Option<DynamicPlaybackSpec>,
    state_ops: Option<super::StateOpsSpec>,
) -> Result<(), String> {
    // android:native-activity 要求把 AndroidApp 交给 winit;其余平台保持原路径。
    #[cfg(target_os = "android")]
    let event_loop = {
        use winit::platform::android::EventLoopBuilderExtAndroid;
        let app = crate::ANDROID_APP
            .get()
            .expect("android app must be registered by android_main")
            .clone();
        EventLoop::<GpuEvent>::with_user_event()
            .with_android_app(app)
            .build()
            .map_err(|error| format!("event loop creation failed: {error}"))?
    };
    #[cfg(not(target_os = "android"))]
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
        let decoder = super::super::package_watch::ordinary_decoder;
        #[cfg(windows)]
        let decoder: super::super::package_watch::Decoder = if content.x_template.is_some() {
            super::super::package_watch::x_decoder
        } else {
            decoder
        };
        Some(package_live::start(
            spec.watch_path.clone(),
            published,
            proxy.clone(),
            decoder,
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
            dynamic_playback,
            state_ops,
            packet_live_probe,
            packet_live_transport,
            package_live_transport,
            telemetry_report: matches!(
                report,
                ReportMode::Telemetry
                    | ReportMode::TelemetryPrepare
                    | ReportMode::TelemetryPrepareMaterial
                    | ReportMode::TelemetryPrepareShadowFlag
                    | ReportMode::TelemetryPrepareCastFlag
                    | ReportMode::TelemetryPrepareLod
                    | ReportMode::TelemetryPrepareStructural
            ),
            telemetry_prepare_replay: match report {
                ReportMode::TelemetryPrepare => {
                    Some(super::super::TelemetryPreparePerturbation::Transform)
                }
                ReportMode::TelemetryPrepareMaterial => {
                    Some(super::super::TelemetryPreparePerturbation::MaterialUniform)
                }
                ReportMode::TelemetryPrepareShadowFlag => {
                    Some(super::super::TelemetryPreparePerturbation::ShadowFlag)
                }
                ReportMode::TelemetryPrepareCastFlag => {
                    Some(super::super::TelemetryPreparePerturbation::CastFlag)
                }
                ReportMode::TelemetryPrepareLod => {
                    Some(super::super::TelemetryPreparePerturbation::Lod)
                }
                ReportMode::TelemetryPrepareStructural => {
                    Some(super::super::TelemetryPreparePerturbation::Structural)
                }
                _ => None,
            },
            selection_probe: matches!(report, ReportMode::Selection),
            occlusion_probe: matches!(report, ReportMode::Occlusion),
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
    app.packet_live_transport.take();
    app.package_live_transport.take();
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
