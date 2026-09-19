use std::path::PathBuf;

mod runtime;
use runtime::run_internal;

use deep_engine_native::{bloom::BloomSettings, fog::FogSettings};
use winit::event_loop::{ControlFlow, EventLoop};

use crate::{events::GpuEvent, player_content::PlayerContent, renderer::RendererFeatures};

use super::{
    NativeApp, NativeAppSetup, ShadowUpdateProbe, dynamic_playback::DynamicPlaybackSpec,
    package_live, packet_live, packet_live_probe::PacketLiveProbe, state_ops_playback::StateOpsSpec,
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
    bloom: BloomSettings,
) -> Result<(), String> {
    run_internal(
        content,
        false,
        RendererFeatures {
            bloom,
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        },
        None,
        None,
        None,
        ReportMode::Verification(verification),
        None,
        None,
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
        None,
        None,
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
        None,
        None,
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
        None,
        None,
    )
}

/// `--smoke-dynamic-package`: real-window playback of the package's dynamic
/// runtime channel. The wall clock drives the fixed step grid; every applied
/// step mutates the packet and is re-submitted to the GPU before the next
/// present. Exits 0 with a JSON receipt listing per-step canonical frames
/// and per-presentation timings.
pub fn run_dynamic_playback(
    content: PlayerContent,
    spec: DynamicPlaybackSpec,
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
        ReportMode::None,
        Some(spec),
        None,
    )
}

/// `--smoke-state-ops`: real-window playback of the frozen R3 state-op
/// sequence. The wall clock drives the step grid; every applied step mutates
/// the real player state and is read back through the f32 pipeline before the
/// next present. Exits 0 with a JSON receipt listing per-step contract and
/// applied frames.
pub fn run_state_ops_playback(
    content: PlayerContent,
    spec: StateOpsSpec,
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
        ReportMode::None,
        None,
        Some(spec),
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
        None,
        None,
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
        None,
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
            fog: FogSettings::DISABLED,
            shadow_probe: true,
            ibl_probe: false,
            telemetry: false,
        },
        Some(ShadowUpdateProbe::new(rejected, out_of_range, replacement)),
        None,
        None,
        ReportMode::None,
        None,
        None,
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
        None,
        None,
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
        None,
        None,
    )
}

pub fn run_package_live(content: PlayerContent, spec: PackageLiveSpec) -> Result<(), String> {
    // 与 `runtime_package_startup` 的生产入口同一档位函数:纯二维
    // 组合包不代用户启用 Bloom,热更观察路径不得与冷启动路径分叉。
    let bloom = crate::renderer::entry_bloom(&content);
    run_internal(
        content,
        spec.smoke_rewrite.is_some(),
        RendererFeatures {
            bloom,
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        },
        None,
        None,
        Some(spec),
        ReportMode::None,
        None,
        None,
    )
}
