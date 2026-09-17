use super::*;

/// Chart legend keyboard focus (P1-16). Single-window app: one process-wide
/// state, fed through the pure `native_ui::chart_a11y` machine so tests drive
/// the same logic without a window.
static CHART_KEYBOARD: Mutex<ChartKeyboardState> = Mutex::new(ChartKeyboardState::new());

/// 图例键盘焦点(供呈现层画焦点环);锁异常按无焦点处理。
pub(in crate::app) fn chart_legend_focus() -> Option<usize> {
    CHART_KEYBOARD
        .lock()
        .ok()
        .and_then(|state| state.focused_item())
}

/// P1-16 chart keyboard entry: translates a physical key into the pure
/// `chart_a11y` state machine and applies the resulting command through the
/// SAME dispatch paths the pointer pipeline uses. Returns true when consumed.
///
/// `pub(super)`:键盘 smoke 走这条生产路径而不是复制判定,保证探针验证的就是
/// 用户按键真正会执行的分支。
pub(in crate::app) fn chart_key(app: &mut NativeApp, key: KeyCode) -> bool {
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
        crate::window_chrome::set_title(window, &format!("Deep Engine Chart — {message}"));
    }
}
