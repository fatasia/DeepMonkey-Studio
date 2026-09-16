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
mod annotations;
mod chart;
mod chart_keyboard_smoke;
mod chart_sim;
mod chart_smoke;
mod deep2d_context;
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
mod runner;
mod section;
mod section_probe;
mod selection;
mod selection_probe;
mod shadow_update_probe;
mod window_events;
use package_live::PackageLiveTransport;
use packet_coalescer::{PublishedState, UpdateCoalescer};
use packet_live::PacketLiveTransport;
use packet_live_probe::PacketLiveProbe;
pub use runner::{
    PackageLiveSpec, PacketLiveSpec, run, run_chart_keyboard_smoke, run_fog, run_package_live,
    run_packet_live, run_section_smoke, run_selection_smoke, run_shadow_update_probe,
    run_telemetry_smoke, run_verification,
};
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
    packet_live_probe: Option<PacketLiveProbe>,
    packet_live_transport: Option<PacketLiveTransport>,
    package_live_transport: Option<PackageLiveTransport>,
    package_open: Option<package_open::PackageOpen>,
    drop_batch: package_source::DropBatch,
    packet_coalescer: UpdateCoalescer,
    telemetry_warmup_frames_remaining: u8,
    telemetry_sample_frames_remaining: u8,
    state: PlayerState,
    selection_probe: Option<u8>,
    section_probe: Option<section_probe::SectionProbe>,
    chart_probe: Option<u8>,
    /// P1-16 第三批键盘 smoke 的推进阶段;独立于 chart_probe,两者不共存。
    chart_key_probe: Option<u8>,
    chart_text: Option<deep_engine_native::platform_text::TextRasterizer>,
    chart_legend_page: usize,
    chart_sim_scheduled: bool,
}

struct NativeAppSetup {
    smoke_frame: bool,
    features: RendererFeatures,
    shadow_update_probe: Option<ShadowUpdateProbe>,
    packet_live_probe: Option<PacketLiveProbe>,
    packet_live_transport: Option<PacketLiveTransport>,
    package_live_transport: Option<PackageLiveTransport>,
    telemetry_report: bool,
    selection_probe: bool,
    section_probe: bool,
    /// P1-16 第三批:键盘 smoke。与 chart_probe 互斥(见 `NativeApp::new`)。
    chart_key_probe: bool,
}

impl NativeApp {
    fn new(content: PlayerContent, proxy: EventLoopProxy<GpuEvent>, setup: NativeAppSetup) -> Self {
        let view = content.initial_view();
        // 键盘 smoke 与图表交互 smoke 都推进 chart 探针,同一窗口只能选一条;
        // 键盘模式下 chart_probe 保持 None,由 chart_key_probe 独占推进权。
        let chart_probe =
            (setup.smoke_frame && content.chart.is_some() && !setup.chart_key_probe).then_some(0);
        Self {
            chart_probe,
            chart_key_probe: (setup.chart_key_probe && content.chart.is_some()).then_some(0),
            chart_text: None,
            chart_legend_page: 0,
            chart_sim_scheduled: false,
            content: PublishedState::new(content),
            proxy,
            window: None,
            renderer: None,
            next_renderer_id: 1,
            smoke_frame: setup.smoke_frame,
            features: setup.features,
            shadow_update_probe: setup.shadow_update_probe,
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
        if let Some(error) = self
            .renderer
            .as_mut()
            .and_then(|renderer| renderer.resize(size).err())
        {
            self.state.failed(error);
        }
        self.request_redraw();
    }
}
