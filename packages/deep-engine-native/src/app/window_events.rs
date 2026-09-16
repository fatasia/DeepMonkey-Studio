use std::sync::Mutex;

use winit::{
    event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent},
    event_loop::ActiveEventLoop,
    keyboard::{KeyCode, PhysicalKey},
    window::WindowId,
};

use deep_engine_native::chart::{
    ChartAction, ChartAxisChannel,
    legend::{LegendAction, LegendFrame},
};
use deep_engine_native::deep2d::LetterboxMapping;
use deep_engine_native::native_ui::chart_a11y::{
    ChartKeyInput, ChartKeyResponse, ChartKeyboardState, LegendCommand, LegendItemSnapshot,
    LegendSnapshot, legend_item_id,
};

use crate::{app_startup::report_presented, events::RenderOutcome, renderer::Renderer};

use super::NativeApp;

/// Chart legend keyboard focus (P1-16). Single-window app: one process-wide
/// state, fed through the pure `native_ui::chart_a11y` machine so tests drive
/// the same logic without a window.
static CHART_KEYBOARD: Mutex<ChartKeyboardState> = Mutex::new(ChartKeyboardState::new());

/// 图例键盘焦点(供呈现层画焦点环);锁异常按无焦点处理。
pub(super) fn chart_legend_focus() -> Option<usize> {
    CHART_KEYBOARD
        .lock()
        .ok()
        .and_then(|state| state.focused_item())
}

pub(super) fn handle(
    app: &mut NativeApp,
    event_loop: &ActiveEventLoop,
    window_id: WindowId,
    event: WindowEvent,
) {
    if app
        .window
        .as_ref()
        .is_none_or(|window| window.id() != window_id)
    {
        return;
    }
    if app.state.verification.is_some()
        && !matches!(
            event,
            WindowEvent::CloseRequested
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
                | WindowEvent::Occluded(_)
                | WindowEvent::RedrawRequested
        )
    {
        return;
    }
    match event {
        WindowEvent::CloseRequested => close(app, event_loop),
        WindowEvent::DroppedFile(path) => app.drop_batch.push(path),
        WindowEvent::HoveredFile(_) => app.drop_batch.hover(),
        WindowEvent::HoveredFileCancelled => app.drop_batch.cancel(),
        WindowEvent::CursorMoved { position, .. } => {
            app.state.cursor = Some([position.x, position.y]);
            super::chart::pointer(app, false);
        }
        WindowEvent::CursorLeft { .. } => {
            app.state.cursor = None;
            super::chart::pointer(app, false);
        }
        WindowEvent::MouseWheel { delta, .. } => {
            let amount = match delta {
                MouseScrollDelta::LineDelta(_, y) => f64::from(y),
                MouseScrollDelta::PixelDelta(position) => position.y,
            };
            super::chart::zoom(app, amount);
        }
        WindowEvent::Ime(event) => super::annotations::ime(app, event),
        WindowEvent::MouseInput {
            state: ElementState::Pressed,
            button: MouseButton::Left,
            ..
        } => {
            if !super::chart::pointer(app, true) {
                super::selection::click(app);
            }
        }
        WindowEvent::Resized(size) => app.resize(size),
        WindowEvent::ScaleFactorChanged { .. } => {
            if let Some(size) = app.window.as_ref().map(|window| window.inner_size()) {
                app.resize(size);
            }
        }
        WindowEvent::Occluded(false) => app.request_redraw(),
        WindowEvent::RedrawRequested => redraw(app, event_loop),
        WindowEvent::KeyboardInput { event, .. }
            if event.state == ElementState::Pressed && !event.repeat =>
        {
            if let PhysicalKey::Code(key) = event.physical_key
                && super::annotations::key(app, key, event.text.as_deref())
            {
                return;
            }
            if let PhysicalKey::Code(key) = event.physical_key
                && super::section::key(app, key)
            {
                return;
            }
            if let PhysicalKey::Code(key) = event.physical_key
                && chart_key(app, key)
            {
                return;
            }
            match event.physical_key {
                PhysicalKey::Code(KeyCode::Escape) => close(app, event_loop),
                PhysicalKey::Code(KeyCode::ArrowLeft) => app.rotate(-0.18),
                PhysicalKey::Code(KeyCode::ArrowRight) => app.rotate(0.18),
                PhysicalKey::Code(KeyCode::KeyR) => app.initialize_renderer(),
                PhysicalKey::Code(KeyCode::KeyM) => super::selection::toggle_measurement(app),
                PhysicalKey::Code(KeyCode::Home) => {
                    if !super::chart::reset(app) {
                        super::selection::reset_view(app);
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

/// P1-16 chart keyboard entry: translates a physical key into the pure
/// `chart_a11y` state machine and applies the resulting command through the
/// SAME dispatch paths the pointer pipeline uses. Returns true when consumed.
///
/// `pub(super)`:键盘 smoke 走这条生产路径而不是复制判定,保证探针验证的就是
/// 用户按键真正会执行的分支。
pub(super) fn chart_key(app: &mut NativeApp, key: KeyCode) -> bool {
    let Some(input) = chart_key_input(key) else {
        return false;
    };
    let Some(chart) = app.content.active().chart.as_ref() else {
        return false;
    };
    let Ok(frame) = LegendFrame::prepare(chart, app.chart_legend_page) else {
        return false;
    };
    let zoom_window = chart
        .source()
        .axes
        .iter()
        .find(|axis| axis.channel == ChartAxisChannel::X)
        .and_then(|axis| chart.state().zoom_window(&axis.id))
        .unwrap_or((0.0, 1.0));
    let snapshot = LegendSnapshot {
        page: frame.page,
        pages: frame.pages,
        zoom_window,
        items: frame
            .items
            .iter()
            .map(|item| {
                let command = legend_command(&item.action);
                LegendItemSnapshot {
                    id: legend_item_id(frame.page, &command),
                    label: item.label.clone(),
                    hidden: item.hidden,
                    rect: item.rect,
                    command,
                }
            })
            .collect(),
    };
    let response = CHART_KEYBOARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .handle(&snapshot, input);
    apply_chart_key(app, response)
}

fn chart_key_input(key: KeyCode) -> Option<ChartKeyInput> {
    match key {
        KeyCode::Tab => Some(ChartKeyInput::Tab),
        KeyCode::Escape => Some(ChartKeyInput::Escape),
        KeyCode::Enter | KeyCode::NumpadEnter => Some(ChartKeyInput::Enter),
        KeyCode::Space => Some(ChartKeyInput::Space),
        KeyCode::ArrowRight | KeyCode::ArrowDown => Some(ChartKeyInput::Next),
        KeyCode::ArrowLeft | KeyCode::ArrowUp => Some(ChartKeyInput::Prev),
        KeyCode::Equal | KeyCode::NumpadAdd | KeyCode::PageUp => Some(ChartKeyInput::ZoomIn),
        KeyCode::Minus | KeyCode::NumpadSubtract | KeyCode::PageDown => {
            Some(ChartKeyInput::ZoomOut)
        }
        _ => None,
    }
}

fn legend_command(action: &LegendAction) -> LegendCommand {
    match action {
        LegendAction::Toggle(series_id) => LegendCommand::Toggle(series_id.clone()),
        LegendAction::Page(page) => LegendCommand::Page(*page),
    }
}

fn apply_chart_key(app: &mut NativeApp, response: ChartKeyResponse) -> bool {
    match response {
        ChartKeyResponse::NotHandled => false,
        ChartKeyResponse::FocusReleased => {
            announce(app, "chart legend focus released");
            super::chart::refresh_legend_focus(app);
            true
        }
        ChartKeyResponse::FocusChanged { announcement, .. } => {
            announce(app, &announcement);
            super::chart::refresh_legend_focus(app);
            true
        }
        ChartKeyResponse::Activate {
            command,
            announcement,
            ..
        } => {
            announce(app, &announcement);
            match command {
                LegendCommand::Toggle(series_id) => super::chart::update(app, |chart| {
                    chart.dispatch(ChartAction::ToggleLegend { series_id })
                }),
                LegendCommand::Page(page) => click_legend_page(app, page),
            }
            true
        }
        ChartKeyResponse::Zoom { start, end } => {
            let Some(chart) = app.content.active().chart.as_ref() else {
                return true;
            };
            let Some(axis) = chart
                .source()
                .axes
                .iter()
                .find(|axis| axis.channel == ChartAxisChannel::X)
            else {
                return true;
            };
            let axis_id = axis.id.clone();
            super::chart::update(app, move |chart| {
                chart.dispatch(ChartAction::Zoom {
                    axis_id,
                    start,
                    end,
                })
            });
            true
        }
    }
}

/// Keyboard "Enter" on a page-navigation item rides the exact pointer
/// dispatch (`pointer(app, true)` resolves the legend hit first) — the same
/// route `chart_smoke` already uses for legend verification — because the
/// page commit lives behind `app::chart`'s private change_legend_page. The
/// cursor is synthesized at the focused item center and restored immediately;
/// a legend hit never touches hover/tooltip state, so the shared
/// InteractionState is intact afterwards.
fn click_legend_page(app: &mut NativeApp, page: usize) {
    let Some(chart) = app.content.active().chart.as_ref() else {
        return;
    };
    let Ok(frame) = LegendFrame::prepare(chart, app.chart_legend_page) else {
        return;
    };
    let Some(item) = frame
        .items
        .iter()
        .find(|item| item.action == LegendAction::Page(page))
    else {
        return;
    };
    let Some(window) = app.window.as_ref() else {
        return;
    };
    let size = window.inner_size();
    if size.width == 0 || size.height == 0 {
        return;
    }
    let list = chart.frame().display_list();
    let mapping = LetterboxMapping::new(
        [list.logical_width, list.logical_height],
        [size.width.into(), size.height.into()],
    );
    let restore = app.state.cursor;
    app.state.cursor = Some(mapping.logical_to_physical([
        item.rect[0] + item.rect[2] * 0.5,
        item.rect[1] + item.rect[3] * 0.5,
    ]));
    super::chart::pointer(app, true);
    app.state.cursor = restore;
}

/// Focus/activation announcements reuse the title-bar status channel (the
/// same surface `report` writes to); the structured label list for a real
/// screen-reader bridge lives in `native_ui::chart_a11y::legend_semantics_tree`.
fn announce(app: &NativeApp, message: &str) {
    if let Some(window) = &app.window {
        window.set_title(&format!("Deep Engine Chart — {message}"));
    }
}

fn close(app: &mut NativeApp, event_loop: &ActiveEventLoop) {
    if !super::annotations::preserve(app) {
        return;
    }
    if app.smoke_frame || app.state.verification.is_some() {
        app.state
            .failed("native verification window closed before GPU completion".into());
    }
    event_loop.exit();
}

fn redraw(app: &mut NativeApp, event_loop: &ActiveEventLoop) {
    let verify = app.state.verification.is_some()
        || app.smoke_frame
        || app.content.active().pending_lkg.is_some()
        || app.content.active().pending_asset_lkg.is_some();
    let outcome = app
        .renderer
        .as_mut()
        .map(|renderer| renderer.render(verify));
    if let Some(RenderOutcome::Failed(error)) = outcome.as_ref() {
        app.state.failure = Some(error.clone());
        event_loop.exit();
        return;
    }
    if matches!(outcome, Some(RenderOutcome::Presented))
        && let Some(notice) = crate::runtime_package_startup::presented(app.content.active_mut())
        && let Some(window) = &app.window
    {
        window.set_title(&format!("Deep Engine Native Viewer — {notice}"));
    }
    if matches!(outcome, Some(RenderOutcome::Presented)) && app.state.verification.is_some() {
        let size = app.window.as_ref().expect("window exists").inner_size();
        let backend = app
            .renderer
            .as_ref()
            .expect("renderer exists")
            .verification_backend()
            .to_owned();
        match app
            .state
            .verification
            .as_mut()
            .unwrap()
            .presented(size.width, size.height, backend)
        {
            Ok(true) => event_loop.exit(),
            Ok(false) => app.request_redraw(),
            Err(error) => {
                app.state.failed(error);
                event_loop.exit();
            }
        }
        return;
    }
    if app.smoke_frame && matches!(outcome, Some(RenderOutcome::Presented)) {
        if app.chart_key_probe.is_some() {
            match super::chart_keyboard_smoke::advance_smoke(app) {
                Ok(false) => {
                    app.request_redraw();
                    return;
                }
                Ok(true) => {}
                Err(error) => {
                    app.state.failed(error);
                    event_loop.exit();
                    return;
                }
            }
        }
        if app.chart_probe.is_some() {
            match super::chart_smoke::advance_smoke(app) {
                Ok(false) => {
                    app.request_redraw();
                    return;
                }
                Ok(true) => {}
                Err(error) => {
                    app.state.failed(error);
                    event_loop.exit();
                    return;
                }
            }
        }
        if app.section_probe.is_some() {
            match super::section_probe::advance(app) {
                Ok(false) => {
                    app.request_redraw();
                    return;
                }
                Ok(true) => {}
                Err(error) => {
                    app.state.failed(error);
                    event_loop.exit();
                    return;
                }
            }
        }
        if app.selection_probe.is_some() {
            match super::selection_probe::advance(app, event_loop) {
                Ok(false) => {
                    app.request_redraw();
                    return;
                }
                Ok(true) => {}
                Err(error) => {
                    app.state.failed(error);
                    event_loop.exit();
                    return;
                }
            }
        }
        match advance_probes(app, event_loop) {
            ProbeProgress::Complete => {}
            ProbeProgress::Redraw => {
                app.request_redraw();
                return;
            }
            ProbeProgress::WaitForEvent => return,
        }
        if app.telemetry_warmup_frames_remaining > 0 {
            app.telemetry_warmup_frames_remaining -= 1;
            if app.telemetry_warmup_frames_remaining == 0 {
                app.renderer
                    .as_mut()
                    .expect("renderer remains ready during telemetry warmup")
                    .reset_telemetry();
            }
            app.request_redraw();
            return;
        }
        if app.telemetry_sample_frames_remaining > 1 {
            app.telemetry_sample_frames_remaining -= 1;
            app.request_redraw();
            return;
        }
        if app.telemetry_sample_frames_remaining == 1
            && let Some(report) = app.renderer.as_ref().and_then(Renderer::telemetry_report)
        {
            app.telemetry_sample_frames_remaining = 0;
            println!("native telemetry report: {report}");
        }
        let size = app.window.as_ref().expect("window exists").inner_size();
        report_presented(size, app.content.active().deep2d.is_some());
        event_loop.exit();
        return;
    }
    if verify && matches!(outcome, Some(RenderOutcome::Skipped)) {
        app.request_redraw();
    }
    if matches!(outcome, Some(RenderOutcome::Recover)) {
        if app.smoke_frame || app.state.verification.is_some() {
            app.state.failure = Some("surface was lost during native verification frame".into());
            event_loop.exit();
            return;
        }
        app.renderer = None;
        app.initialize_renderer();
    }
}

enum ProbeProgress {
    Complete,
    Redraw,
    WaitForEvent,
}

fn advance_probes(app: &mut NativeApp, event_loop: &ActiveEventLoop) -> ProbeProgress {
    if let Some(probe) = app.shadow_update_probe.as_mut() {
        let result = probe.after_present(
            app.renderer.as_mut().expect("renderer exists"),
            app.content.active_mut(),
        );
        match result {
            Ok(false) => {
                return ProbeProgress::Redraw;
            }
            Ok(true) => {}
            Err(error) => {
                app.state.failure = Some(error);
                event_loop.exit();
                return ProbeProgress::WaitForEvent;
            }
        }
    }
    if let Some(probe) = app.packet_live_probe.as_mut() {
        let result = probe.after_present(app.renderer.as_mut().expect("renderer exists"));
        match result {
            Ok(false) => {
                return ProbeProgress::WaitForEvent;
            }
            Ok(true) => {}
            Err(error) => {
                app.state.failure = Some(error);
                event_loop.exit();
                return ProbeProgress::WaitForEvent;
            }
        }
    }
    ProbeProgress::Complete
}
