use std::sync::Arc;

use winit::{
    application::ApplicationHandler,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoopProxy},
    window::{Window, WindowId},
};

use crate::{
    app_startup::{report_renderer_ready, window_attributes},
    events::GpuEvent,
    player_content::PlayerContent,
    player_state::PlayerState,
    renderer::{Renderer, RendererFeatures},
};
#[cfg(windows)]
mod accessibility;
mod annotation_ime_area;
mod annotation_input;
mod annotations;
mod chart;
mod chart_keyboard_smoke;
mod chart_sim;
mod chart_smoke;
mod dashboard;
#[cfg(all(test, target_os = "windows"))]
mod dashboard_gpu_tests;
#[cfg(all(test, target_os = "windows"))]
mod dashboard_filter_gpu_tests;
mod deep2d_context;
mod dynamic_playback;
mod lifecycle;
mod package_camera;
#[cfg(test)]
mod package_drop_probe_tests;
mod package_live;
mod package_open;
mod package_source;
mod package_watch;
mod packet_coalescer;
mod packet_live;
mod packet_live_probe;
mod packet_mailbox;
mod packet_watch;
mod recovery;
mod renderer_lifecycle;
#[cfg(all(test, windows))]
mod resize_epoch_tests;
mod runner;
mod section;
mod section_probe;
mod selection;
mod selection_probe;
mod shadow_update_probe;
mod state_ops_playback;
mod text_scale;
mod watch_thread;
mod window_events;
#[cfg(all(test, windows))]
mod x_drop_tests;
#[cfg(windows)]
mod x_input;
#[cfg(windows)]
mod x_runtime;
#[cfg(windows)]
mod x_transport;
use package_live::PackageLiveTransport;
use packet_coalescer::{PublishedState, UpdateCoalescer};
use packet_live::PacketLiveTransport;
use packet_live_probe::PacketLiveProbe;
pub use dynamic_playback::{DYNAMIC_PLAYBACK_STEP_MS, DynamicPlaybackSpec};pub use runner::{
    PackageLiveSpec, PacketLiveSpec, run, run_chart_keyboard_smoke, run_dynamic_playback,
    run_fog, run_package_live, run_packet_live, run_section_smoke, run_selection_smoke,
    run_shadow_update_probe, run_state_ops_playback, run_telemetry_smoke,
    run_telemetry_smoke_prepare, run_verification,
};
pub use state_ops_playback::StateOpsSpec;
use shadow_update_probe::ShadowUpdateProbe;

struct NativeApp {
    content: PublishedState<PlayerContent>,
    proxy: EventLoopProxy<GpuEvent>,
    window: Option<Arc<Window>>,
    renderer: Option<Renderer>,
    next_renderer_id: u64,
    smoke_frame: bool,
    features: RendererFeatures,
    shadow_update_probe: Option<ShadowUpdateProbe>,
    dynamic_playback: Option<dynamic_playback::DynamicPlaybackProbe>,
    state_ops: Option<state_ops_playback::StateOpsProbe>,
    packet_live_probe: Option<PacketLiveProbe>,
    packet_live_transport: Option<PacketLiveTransport>,
    package_live_transport: Option<PackageLiveTransport>,
    package_open: Option<package_open::PackageOpen>,
    drop_batch: package_source::DropBatch,
    packet_coalescer: UpdateCoalescer,
    telemetry_warmup_frames_remaining: u8,
    telemetry_sample_frames_remaining: u8,
    /// R6-2 细分采样:遥测采样窗内每帧一次真实 packet 更新。
    telemetry_prepare_replay: Option<TelemetryPrepareReplay>,
    state: PlayerState,
    selection_probe: Option<u8>,
    section_probe: Option<section_probe::SectionProbe>,
    chart_probe: Option<u8>,
    /// P1-16 第三批键盘 smoke 的推进阶段;独立于 chart_probe,两者不共存。
    chart_key_probe: Option<u8>,
    chart_text: Option<deep_engine_native::platform_text::TextRasterizer>,
    annotation_editor: Option<annotation_input::AnnotationEditor>,
    chart_legend_page: usize,
    /// 上次已应用布局的窗口物理尺寸;None=窗口尚未 resize 过。layout_revision 的
    /// 去重依据:同尺寸重复事件(ScaleFactorChanged 回环、平台重发)不得推进版本。
    last_resize: Option<winit::dpi::PhysicalSize<u32>>,
    chart_sim_scheduled: bool,
    dashboard_wake_at: Option<std::time::Instant>,
    #[cfg(windows)]
    x_runtime: Option<x_runtime::Runtime>,
    #[cfg(windows)]
    accessibility: Option<accessibility::WindowAccessibility>,
}

struct NativeAppSetup {
    smoke_frame: bool,
    features: RendererFeatures,
    shadow_update_probe: Option<ShadowUpdateProbe>,
    dynamic_playback: Option<DynamicPlaybackSpec>,
    state_ops: Option<state_ops_playback::StateOpsSpec>,
    packet_live_probe: Option<PacketLiveProbe>,
    packet_live_transport: Option<PacketLiveTransport>,
    package_live_transport: Option<PackageLiveTransport>,
    telemetry_report: bool,
    /// R6-2 细分采样(`--smoke-telemetry-prepare`):隐含 telemetry_report。
    telemetry_prepare_replay: bool,
    selection_probe: bool,
    section_probe: bool,
    /// P1-16 第三批:键盘 smoke。与 chart_probe 互斥(见 `NativeApp::new`)。
    chart_key_probe: bool,
}

/// R6-2 细分采样的交替内容对。变体只翻转首个实例的平移 X(与
/// `moved_packet_bytes` 同一摄动),保证每次 replace 的 scene_content_key
/// 都变化,不会退化成 Noop;起始即 alternate,首帧更新就是真实 Replace。
struct TelemetryPrepareReplay {
    original: PlayerContent,
    alternate: PlayerContent,
    use_alternate: bool,
}

impl TelemetryPrepareReplay {
    fn build(content: &PlayerContent) -> Option<Self> {
        let packet = content.packet();
        let next_x = if packet.instances.first()?.transform[12] == -0.75 {
            -0.7
        } else {
            -0.75
        };
        let mut moved = packet.clone();
        moved.instances[0].transform[12] = next_x;
        Some(Self {
            original: PlayerContent::from_packet(packet.clone(), content.deep2d.clone()),
            alternate: PlayerContent::from_packet(moved, content.deep2d.clone()),
            use_alternate: true,
        })
    }
}

impl NativeApp {
    fn new(content: PlayerContent, proxy: EventLoopProxy<GpuEvent>, setup: NativeAppSetup) -> Self {
        let view = content.initial_view();
        // 键盘 smoke 与图表交互 smoke 都推进 chart 探针,同一窗口只能选一条;
        // 键盘模式下 chart_probe 保持 None,由 chart_key_probe 独占推进权。
        let chart_probe =
            (setup.smoke_frame && content.chart.is_some() && !setup.chart_key_probe).then_some(0);
        // 无实例的包无法构造交替变体,replay 静默降级(不伪造样本)。
        let telemetry_prepare_replay = setup
            .telemetry_prepare_replay
            .then(|| TelemetryPrepareReplay::build(&content))
            .flatten();
        Self {
            chart_probe,
            chart_key_probe: (setup.chart_key_probe && content.chart.is_some()).then_some(0),
            chart_text: None,
            annotation_editor: None,
            chart_legend_page: 0,
            last_resize: None,
            chart_sim_scheduled: false,
            dashboard_wake_at: None,
            #[cfg(windows)]
            x_runtime: None,
            #[cfg(windows)]
            accessibility: None,
            content: PublishedState::new(content),
            proxy,
            window: None,
            renderer: None,
            next_renderer_id: 1,
            smoke_frame: setup.smoke_frame,
            features: setup.features,
            shadow_update_probe: setup.shadow_update_probe,
            dynamic_playback: setup.dynamic_playback.map(dynamic_playback::DynamicPlaybackProbe::new),
            state_ops: setup.state_ops.map(state_ops_playback::StateOpsProbe::new),
            packet_live_probe: setup.packet_live_probe,
            packet_live_transport: setup.packet_live_transport,
            package_live_transport: setup.package_live_transport,
            package_open: None,
            drop_batch: Default::default(),
            packet_coalescer: UpdateCoalescer::new(0),
            telemetry_warmup_frames_remaining: if setup.telemetry_report {
                crate::player_diagnostics::TELEMETRY_WARMUP_FRAMES
            } else {
                0
            },
            telemetry_sample_frames_remaining: if setup.telemetry_report {
                crate::player_diagnostics::TELEMETRY_SAMPLE_FRAMES
            } else {
                0
            },
            telemetry_prepare_replay,
            state: PlayerState {
                view,
                ..Default::default()
            },
            selection_probe: setup.selection_probe.then_some(0),
            section_probe: setup
                .section_probe
                .then(section_probe::SectionProbe::default),
        }
    }

    fn rotate(&mut self, delta: f32) {
        self.state.rotate(delta);
        if let Some(renderer) = self.renderer.as_mut() {
            renderer.set_view(self.state.view);
        }
        self.request_redraw();
    }

    fn request_redraw(&self) {
        if let Some(window) = self.window.as_ref() {
            window.request_redraw();
        }
    }

    fn resize(&mut self, size: winit::dpi::PhysicalSize<u32>) {
        // P1-01 布局版本入口:仅物理尺寸真实变化时推进 layout_revision,依赖布局版本
        // 的消费方(GPU 目标重建/letterbox 映射/命中索引)以 revision 推进判定布局变化。
        // revision 先于渲染落地;GPU 同步语义由 published 承担,两者不混用。
        // 溢出为不可恢复终态:revision 耗尽即无法再表达布局变化,按失败收口。
        if self.last_resize != Some(size) {
            self.last_resize = Some(size);
            if let Err(error) = self.content.active_mut().epoch.bump_layout() {
                self.state.failed(error);
            }
        }
        if let Some(error) = self
            .renderer
            .as_mut()
            .and_then(|renderer| renderer.resize(size).err())
        {
            self.state.failed(error);
        }
        text_scale::refresh(self);
        self.request_redraw();
    }
}
