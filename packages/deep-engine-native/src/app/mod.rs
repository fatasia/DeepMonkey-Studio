use std::{collections::HashSet, sync::Arc};

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
use deep_engine_native::runtime_navigation::{NavigationInput, NavigationState};
#[cfg(windows)]
mod accessibility;
mod annotation_ime_area;
mod annotation_input;
mod annotations;
mod camera_views;
mod chart;
mod chart_keyboard_smoke;
mod chart_sim;
mod chart_smoke;
mod dashboard;
#[cfg(all(test, target_os = "windows"))]
mod dashboard_filter_gpu_tests;
#[cfg(all(test, target_os = "windows"))]
mod dashboard_gpu_tests;
#[cfg(windows)]
mod dashboard_video_input;
mod deep2d_context;
mod dynamic_playback;
mod lifecycle;
mod package_camera;
#[cfg(all(test, target_os = "windows"))]
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
mod touch_pointer;
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
pub use dynamic_playback::{DYNAMIC_PLAYBACK_STEP_MS, DynamicPlaybackSpec};
use package_live::PackageLiveTransport;
use packet_coalescer::{PublishedState, UpdateCoalescer};
use packet_live::PacketLiveTransport;
use packet_live_probe::PacketLiveProbe;
#[cfg(target_arch = "wasm32")]
pub use runner::spawn_wasm;
pub use runner::{
    PackageLiveSpec, PacketLiveSpec, run, run_chart_keyboard_smoke, run_dynamic_playback, run_fog,
    run_occlusion_smoke, run_package_live, run_package_telemetry_smoke, run_packet_live,
    run_section_smoke, run_selection_smoke, run_shadow_update_probe, run_state_ops_playback,
    run_telemetry_smoke, run_telemetry_smoke_prepare, run_telemetry_smoke_prepare_cast,
    run_telemetry_smoke_prepare_lod, run_telemetry_smoke_prepare_material,
    run_telemetry_smoke_prepare_shadow, run_telemetry_smoke_prepare_structural, run_verification,
};
use shadow_update_probe::ShadowUpdateProbe;
pub use state_ops_playback::StateOpsSpec;

struct NativeApp {
    input_gesture: dashboard::InputGesture,
    /// 触控→指针动作的跟踪器;触屏手势与鼠标左键共用同一条处理链。
    touch_pointer: touch_pointer::TouchPointerTracker,
    #[cfg(windows)]
    dashboard_video_input: dashboard_video_input::VideoInput,
    input_modifiers: winit::keyboard::ModifiersState,
    content: PublishedState<PlayerContent>,
    proxy: EventLoopProxy<GpuEvent>,
    window: Option<Arc<Window>>,
    renderer: Option<Renderer>,
    /// A normal native candidate has not presented its first frame yet. Smoke
    /// and publication verification retain their existing fail-fast path.
    #[cfg(not(target_arch = "wasm32"))]
    startup_frame_pending: bool,
    #[cfg(target_arch = "wasm32")]
    renderer_initializing: bool,
    #[cfg(target_arch = "wasm32")]
    deferred_layout_bump: bool,
    next_renderer_id: u64,
    smoke_frame: bool,
    features: RendererFeatures,
    shadow_update_probe: Option<ShadowUpdateProbe>,
    dynamic_playback: Option<dynamic_playback::DynamicPlaybackProbe>,
    product_dynamic_playback: Option<dynamic_playback::ProductDynamicPlayback>,
    product_physics_playback: Option<dynamic_playback::ProductPhysicsPlayback>,
    state_ops: Option<state_ops_playback::StateOpsProbe>,
    packet_live_probe: Option<PacketLiveProbe>,
    packet_live_transport: Option<PacketLiveTransport>,
    package_live_transport: Option<PackageLiveTransport>,
    package_open: Option<package_open::PackageOpen>,
    drop_batch: package_source::DropBatch,
    packet_coalescer: UpdateCoalescer,
    telemetry_warmup_frames_remaining: u16,
    telemetry_sample_frames_remaining: u16,
    /// R6-2 细分采样:遥测采样窗内每帧一次真实 packet 更新。
    telemetry_prepare_replay: Option<TelemetryPrepareReplay>,
    state: PlayerState,
    occlusion_probe: Option<u8>,
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
    dashboard_wake_at: Option<web_time::Instant>,
    navigation_input: NavigationInput,
    navigation_state: NavigationState,
    navigation_clock: Option<web_time::Instant>,
    navigation_pressed: HashSet<winit::keyboard::KeyCode>,
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
    /// R6-2/C3 细分采样:隐含 telemetry_report;Some 指定摄动类型。
    telemetry_prepare_replay: Option<TelemetryPreparePerturbation>,
    selection_probe: bool,
    section_probe: bool,
    /// R4 生产接线:遮挡链真实窗口冒烟(逐帧小幅旋转)。
    occlusion_probe: bool,
    /// P1-16 第三批:键盘 smoke。与 chart_probe 互斥(见 `NativeApp::new`)。
    chart_key_probe: bool,
}

/// R6-2/C3 细分采样的摄动类型。两种摄动都保证 scene_content_key 变化
/// (不退化成 Noop),分别把更新推进到 transform-only 快路径与材质
/// uniform 快路径(或其全量对照),供同一采样窗内按摄动类型归因。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TelemetryPreparePerturbation {
    /// 首实例平移 X 摄动(transform-only 快路径被测对象)。
    Transform,
    /// 首个带 baseColor 纹理的材质 uv offset 摄动(材质 uniform 恰为纹理
    /// 变换块;base_color/metallic 走实例缓冲词,不属本通道)。
    MaterialUniform,
    /// C3 切片三:首实例 receive_shadow 翻转(receive-only 词 31 原位写被测
    /// 对象;caster 集合不变,阴影版本不失效)。
    ShadowFlag,
    /// C3 切片三:首实例 cast_shadow 翻转(批键变化 → 资源复用刷新 staging
    /// 被测对象;阴影版本失效)。
    CastFlag,
    /// C3 切片三:首实例 LOD profile 出现/移除(批键变化 → 资源复用刷新
    /// staging 被测对象)。基准 packet 会被补一个三角数严格递减的 LOD 目标
    /// 几何(两侧 packet 同补,几何列表不因摄动变化)。
    Lod,
    /// C3 切片三:首实例 id 改写(身份变化 → Structural 全量路径对照)。
    Structural,
}

/// R6-2 细分采样的交替内容对。变体按摄动类型生成,保证每次 replace 的
/// scene_content_key 都变化,不会退化成 Noop;起始即 alternate,首帧更新
/// 就是真实更新。
struct TelemetryPrepareReplay {
    original: PlayerContent,
    alternate: PlayerContent,
    use_alternate: bool,
}

impl TelemetryPrepareReplay {
    fn build(content: &PlayerContent, perturbation: TelemetryPreparePerturbation) -> Option<Self> {
        let packet = content.packet();
        let mut moved = packet.clone();
        match perturbation {
            TelemetryPreparePerturbation::Transform => {
                let first = moved.instances.first_mut()?;
                first.transform[12] = if first.transform[12] == -0.75 {
                    -0.7
                } else {
                    -0.75
                };
            }
            TelemetryPreparePerturbation::MaterialUniform => {
                // uv offset 在 0.25 与 0.0 间翻转(无 offset 视为 0.0)。
                // 两种取值的 prepare 输出必然不同;不含实例词字段,不触发
                // instance_material_words_unchanged 守卫。
                let slot = moved
                    .materials
                    .iter_mut()
                    .find(|material| material.base_color_texture.is_some())?
                    .base_color_texture
                    .as_mut()?;
                let x = slot.offset.unwrap_or([0.0, 0.0])[0];
                let next_x = if x == 0.25 { 0.0 } else { 0.25 };
                slot.offset = Some([next_x, slot.offset.unwrap_or([0.0, 0.0])[1]]);
            }
            TelemetryPreparePerturbation::ShadowFlag => {
                // receive 语义归一(None ≡ Some(true)):Some(false) ↔ None,
                // 两种取值的实例词 31 必然不同。
                let first = moved.instances.first_mut()?;
                first.receive_shadow = if first.receive_shadow == Some(false) {
                    None
                } else {
                    Some(false)
                };
            }
            TelemetryPreparePerturbation::CastFlag => {
                // cast 语义归一(None ≡ Some(true)):Some(false) ↔ None,批键
                // 必然变化(单实例批拆分/合并)。
                let first = moved.instances.first_mut()?;
                first.cast_shadow = if first.cast_shadow == Some(false) {
                    None
                } else {
                    Some(false)
                };
            }
            TelemetryPreparePerturbation::Lod => {
                // 基准与变体都补 LOD 目标几何(几何列表两侧一致,不参与摄动),
                // 变体只在首实例上挂/摘两级 profile。
                let mut base = packet.clone();
                append_lod_target(&mut base);
                let mut moved_with_lod = base.clone();
                let first = moved_with_lod.instances.first_mut()?;
                let primary = first.geometry.clone();
                if first.lod.is_some() {
                    first.lod = None;
                } else {
                    first.lod = Some(deep_engine_native::contract::RenderLodProfile {
                        levels: vec![
                            deep_engine_native::contract::RenderLodLevel {
                                geometry: primary,
                                min_projected_diameter_pixels: 48.0,
                                geometric_error: 1.0,
                                resident: None,
                            },
                            deep_engine_native::contract::RenderLodLevel {
                                geometry: lod_target_id(&base, 0),
                                min_projected_diameter_pixels: 0.0,
                                geometric_error: 4.0,
                                resident: None,
                            },
                        ],
                        hysteresis_ratio: None,
                        author: None,
                    });
                }
                return Some(Self {
                    original: PlayerContent::from_packet(base, content.deep2d.clone()),
                    alternate: PlayerContent::from_packet(moved_with_lod, content.deep2d.clone()),
                    use_alternate: true,
                });
            }
            TelemetryPreparePerturbation::Structural => {
                // 首实例 id 改写 → 实例身份变化,永远走全量路径(对照组)。
                let first = moved.instances.first_mut()?;
                if first.id.ends_with("#alt") {
                    first.id = first.id.trim_end_matches("#alt").to_string();
                } else {
                    first.id.push_str("#alt");
                }
            }
        }
        Some(Self {
            original: PlayerContent::from_packet(packet.clone(), content.deep2d.clone()),
            alternate: PlayerContent::from_packet(moved, content.deep2d.clone()),
            use_alternate: true,
        })
    }
}

/// C3 LOD 摄动夹具:复制第 `index` 个几何,顶点全留、索引减半(至少 1 个
/// 三角形),追加为 `<id>-lod` —— 满足 validate_lod 的"三角数严格递减"。
/// 未被实例直接引用的几何是合法 packet 形态。
fn append_lod_target(packet: &mut deep_engine_native::contract::RenderPacket) {
    let primary = packet.geometries[0].clone();
    let half = (primary.indices.len() / 2).max(3) - (primary.indices.len() / 2).max(3) % 3;
    let mut reduced = primary;
    reduced.id = format!("{}-lod", reduced.id);
    reduced.indices.truncate(half.max(3));
    packet.geometries.push(reduced);
}

fn lod_target_id(packet: &deep_engine_native::contract::RenderPacket, index: usize) -> String {
    format!("{}-lod", packet.geometries[index].id)
}

impl NativeApp {
    fn new(content: PlayerContent, proxy: EventLoopProxy<GpuEvent>, setup: NativeAppSetup) -> Self {
        let view = content.initial_view();
        let camera_controls = content.camera_controls();
        let product_dynamic_playback = if !setup.smoke_frame
            && setup.dynamic_playback.is_none()
            && setup.state_ops.is_none()
        {
            dynamic_playback::ProductDynamicPlayback::for_content(&content)
        } else {
            None
        };
        let product_physics_playback = if !setup.smoke_frame
            && setup.dynamic_playback.is_none()
            && setup.state_ops.is_none()
        {
            dynamic_playback::ProductPhysicsPlayback::for_content(&content)
        } else {
            None
        };
        // 键盘 smoke 与图表交互 smoke 都推进 chart 探针,同一窗口只能选一条;
        // 键盘模式下 chart_probe 保持 None,由 chart_key_probe 独占推进权。
        let chart_probe =
            (setup.smoke_frame && content.chart.is_some() && !setup.chart_key_probe).then_some(0);
        // 无实例或无材质的包无法构造交替变体,replay 静默降级(不伪造样本)。
        let telemetry_prepare_replay = setup
            .telemetry_prepare_replay
            .and_then(|perturbation| TelemetryPrepareReplay::build(&content, perturbation));
        Self {
            input_modifiers: winit::keyboard::ModifiersState::empty(),
            input_gesture: dashboard::InputGesture::default(),
            touch_pointer: touch_pointer::TouchPointerTracker::new(),
            #[cfg(windows)]
            dashboard_video_input: dashboard_video_input::VideoInput::default(),
            chart_probe,
            chart_key_probe: (setup.chart_key_probe && content.chart.is_some()).then_some(0),
            chart_text: None,
            annotation_editor: None,
            chart_legend_page: 0,
            last_resize: None,
            chart_sim_scheduled: false,
            dashboard_wake_at: None,
            navigation_input: NavigationInput::default(),
            navigation_state: NavigationState::default(),
            navigation_clock: None,
            navigation_pressed: HashSet::new(),
            #[cfg(windows)]
            x_runtime: None,
            #[cfg(windows)]
            accessibility: None,
            content: PublishedState::new(content),
            proxy,
            window: None,
            renderer: None,
            #[cfg(not(target_arch = "wasm32"))]
            startup_frame_pending: false,
            #[cfg(target_arch = "wasm32")]
            renderer_initializing: false,
            #[cfg(target_arch = "wasm32")]
            deferred_layout_bump: false,
            next_renderer_id: 1,
            smoke_frame: setup.smoke_frame,
            features: setup.features,
            shadow_update_probe: setup.shadow_update_probe,
            dynamic_playback: setup
                .dynamic_playback
                .map(dynamic_playback::DynamicPlaybackProbe::new),
            product_dynamic_playback,
            product_physics_playback,
            state_ops: setup.state_ops.map(state_ops_playback::StateOpsProbe::new),
            packet_live_probe: setup.packet_live_probe,
            packet_live_transport: setup.packet_live_transport,
            package_live_transport: setup.package_live_transport,
            package_open: None,
            drop_batch: Default::default(),
            packet_coalescer: UpdateCoalescer::new(0),
            telemetry_warmup_frames_remaining: if setup.telemetry_report {
                crate::player_diagnostics::telemetry_warmup_frames()
            } else {
                0
            },
            telemetry_sample_frames_remaining: if setup.telemetry_report {
                crate::player_diagnostics::telemetry_sample_frames()
            } else {
                0
            },
            telemetry_prepare_replay,
            state: PlayerState {
                view,
                camera_controls,
                ..Default::default()
            },
            occlusion_probe: setup.occlusion_probe.then_some(0),
            selection_probe: setup.selection_probe.then_some(0),
            section_probe: setup
                .section_probe
                .then(section_probe::SectionProbe::default),
        }
    }

    fn rotate(&mut self, delta: f32) {
        let previous = self.state.view;
        self.state.rotate(delta);
        self.state.view = self
            .content
            .active()
            .resolve_camera_motion(Some(previous), self.state.view);
        self.publish_interactive_view();
    }

    /// Apply one real redraw-clock navigation step. Orbit keeps its existing
    /// discrete keyboard behavior; locomotion is only active for authored
    /// first/third-person modes and remains harmless while Native preflight
    /// fail-closes those modes.
    pub(super) fn step_navigation(&mut self) {
        let controls = self.content.active().camera_controls();
        if !matches!(
            controls.mode,
            deep_engine_native::runtime_camera::RuntimeCameraMode::FirstPerson
                | deep_engine_native::runtime_camera::RuntimeCameraMode::ThirdPerson
        ) {
            self.navigation_clock = None;
            return;
        }
        let now = web_time::Instant::now();
        let dt = self
            .navigation_clock
            .replace(now)
            .map(|previous| previous.elapsed().as_secs_f32())
            .unwrap_or(0.0);
        if dt <= 0.0 {
            if self.navigation_input.forward != 0.0
                || self.navigation_input.strafe != 0.0
                || self.navigation_input.vertical != 0.0
                || self.navigation_input.jump
            {
                self.request_redraw();
            }
            return;
        }
        let previous = self.state.view;
        let candidate = self
            .navigation_state
            .step(previous, controls, self.navigation_input, dt);
        self.state.view = self
            .content
            .active()
            .resolve_camera_motion(Some(previous), candidate);
        if self.state.view != previous {
            self.publish_interactive_view();
        } else if self.navigation_input.forward != 0.0
            || self.navigation_input.strafe != 0.0
            || self.navigation_input.vertical != 0.0
            || self.navigation_input.jump
        {
            self.request_redraw();
        }
    }

    pub(super) fn navigation_key(&mut self, key: winit::keyboard::KeyCode, pressed: bool) -> bool {
        if !matches!(
            self.content.active().camera_controls().mode,
            deep_engine_native::runtime_camera::RuntimeCameraMode::FirstPerson
                | deep_engine_native::runtime_camera::RuntimeCameraMode::ThirdPerson
        ) {
            return false;
        }
        match key {
            winit::keyboard::KeyCode::KeyW
            | winit::keyboard::KeyCode::KeyS
            | winit::keyboard::KeyCode::KeyD
            | winit::keyboard::KeyCode::KeyA
            | winit::keyboard::KeyCode::KeyE
            | winit::keyboard::KeyCode::KeyQ
            | winit::keyboard::KeyCode::ShiftLeft
            | winit::keyboard::KeyCode::ShiftRight
            | winit::keyboard::KeyCode::Space => {}
            _ => return false,
        }
        if pressed {
            self.navigation_pressed.insert(key);
        } else {
            self.navigation_pressed.remove(&key);
        }
        let has = |key| self.navigation_pressed.contains(&key);
        let axis = |positive, negative| {
            (if has(positive) { 1.0 } else { 0.0 }) - (if has(negative) { 1.0 } else { 0.0 })
        };
        self.navigation_input.forward = axis(
            winit::keyboard::KeyCode::KeyW,
            winit::keyboard::KeyCode::KeyS,
        );
        self.navigation_input.strafe = axis(
            winit::keyboard::KeyCode::KeyD,
            winit::keyboard::KeyCode::KeyA,
        );
        self.navigation_input.vertical = axis(
            winit::keyboard::KeyCode::KeyE,
            winit::keyboard::KeyCode::KeyQ,
        );
        self.navigation_input.sprint =
            has(winit::keyboard::KeyCode::ShiftLeft) || has(winit::keyboard::KeyCode::ShiftRight);
        self.navigation_input.jump = has(winit::keyboard::KeyCode::Space);
        self.request_redraw();
        true
    }

    pub(super) fn clear_navigation_input(&mut self) {
        self.navigation_input = NavigationInput::default();
        self.navigation_pressed.clear();
        self.navigation_state.reset();
        self.navigation_clock = None;
    }

    fn tilt(&mut self, delta: f32) {
        let previous = self.state.view;
        self.state.orbit(0.0, delta);
        self.state.view = self
            .content
            .active()
            .resolve_camera_motion(Some(previous), self.state.view);
        self.publish_interactive_view();
    }

    fn zoom(&mut self, delta: f64) {
        let previous = self.state.view;
        if !self.state.zoom(delta) {
            return;
        }
        self.state.view = self
            .content
            .active()
            .resolve_camera_motion(Some(previous), self.state.view);
        self.publish_interactive_view();
    }

    fn publish_interactive_view(&mut self) {
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
            #[cfg(target_arch = "wasm32")]
            if self.renderer_initializing {
                self.deferred_layout_bump = true;
            } else if let Err(error) = self.content.active_mut().epoch.bump_layout() {
                self.state.failed(error);
            }
            #[cfg(not(target_arch = "wasm32"))]
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
