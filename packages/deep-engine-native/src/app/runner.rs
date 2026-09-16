use std::path::PathBuf;

use deep_engine_native::{bloom::BloomSettings, fog::FogSettings};
use winit::event_loop::{ControlFlow, EventLoop};

use crate::{events::GpuEvent, player_content::PlayerContent, renderer::RendererFeatures};

use super::{
    NativeApp, NativeAppSetup, ShadowUpdateProbe, package_live, packet_live,
    packet_live_probe::PacketLiveProbe,
};

pub struct PacketLiveSpec {
    /// Watched packet file; content changes flow through `replace_render_packet`.
    pub watch_path: PathBuf,
    /// `Some` in smoke mode: bytes written to `watch_path` after the first present.
    pub smoke_rewrite: Option<Vec<u8>>,
}

pub struct PackageLiveSpec {
    pub watch_path: PathBuf,
    pub smoke_rewrite: Option<Vec<u8>>,
    pub smoke_rejected_rewrite: Option<Vec<u8>>,
}

enum ReportMode {
    None,
    Verification(crate::publication_verification::Verification),
    Telemetry,
    Selection,
    Section,
    /// P1-16 第三批:真实窗口键盘 smoke(需要图例可聚焦)。
    ChartKeyboard,
}

pub fn run_verification(
    content: PlayerContent,
    verification: crate::publication_verification::Verification,
) -> Result<(), String> {
    run_internal(
        content,
        false,
        RendererFeatures {
            bloom: BloomSettings::default(),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        },
        None,
        None,
        None,
        ReportMode::Verification(verification),
    )
}

pub fn run_section_smoke(content: PlayerContent) -> Result<(), String> {
    run_internal(
        content,
        true,
        RendererFeatures {
            bloom: BloomSettings::default(),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        },
        None,
        None,
        None,
        ReportMode::Section,
    )
}

pub fn run_selection_smoke(content: PlayerContent) -> Result<(), String> {
    run_internal(
        content,
        true,
        RendererFeatures {
            bloom: BloomSettings::default(),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        },
        None,
        None,
        None,
        ReportMode::Selection,
    )
}

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
            fog: FogSettings::DISABLED,
            shadow_probe,
            ibl_probe,
            telemetry: false,
        },
        None,
        None,
        None,
        ReportMode::None,
    )
}

pub fn run_fog(content: PlayerContent, smoke_frame: bool, fog: FogSettings) -> Result<(), String> {
    run_internal(
        content,
        smoke_frame,
        RendererFeatures {
            bloom: BloomSettings::default(),
            fog,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        },
        None,
        None,
        None,
        ReportMode::None,
    )
}

/// `--smoke-telemetry`: bounded-frame smoke that prints the JSON report at exit.
pub fn run_telemetry_smoke(content: PlayerContent) -> Result<(), String> {
    run_internal(
        content,
        true,
        RendererFeatures {
            bloom: BloomSettings::default(),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: true,
        },
        None,
        None,
        None,
        ReportMode::Telemetry,
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
            fog: FogSettings::DISABLED,
            shadow_probe: true,
            ibl_probe: false,
            telemetry: false,
        },
        Some(ShadowUpdateProbe::new(rejected, out_of_range, replacement)),
        None,
        None,
        ReportMode::None,
    )
}

/// P1-16 第三批:`--smoke-chart-keyboard` 在真实窗口按序驱动键盘路径
/// (Tab 聚焦 → 方向键移动 → 激活 → Esc 释放),每步断言状态与像素提交。
pub fn run_chart_keyboard_smoke(content: PlayerContent) -> Result<(), String> {
    run_internal(
        content,
        true,
        RendererFeatures {
            bloom: BloomSettings::default(),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        },
        None,
        None,
        None,
        ReportMode::ChartKeyboard,
    )
}

pub fn run_packet_live(content: PlayerContent, spec: PacketLiveSpec) -> Result<(), String> {
    run_internal(
        content,
        spec.smoke_rewrite.is_some(),
        RendererFeatures {
            bloom: BloomSettings::default(),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        },
        None,
        Some(spec),
        None,
        ReportMode::None,
    )
}

pub fn run_package_live(content: PlayerContent, spec: PackageLiveSpec) -> Result<(), String> {
    run_internal(
        content,
        spec.smoke_rewrite.is_some(),
        RendererFeatures {
            bloom: BloomSettings::default(),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        },
        None,
        None,
        Some(spec),
        ReportMode::None,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_internal(
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
