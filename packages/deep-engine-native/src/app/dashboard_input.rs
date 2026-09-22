//! Dashboard 控件输入路由；所有修改仍走宿主整帧事务。
use super::{NativeApp, apply, export_table};
use deep_engine_native::{dashboard_runtime::DashboardRuntime, deep2d::LetterboxMapping};
use winit::keyboard::KeyCode;

pub(in crate::app) fn pointer(app: &mut NativeApp, select: bool) -> bool {
    if app.content.active().dashboard.is_none() {
        return false;
    }
    let point = logical_cursor(app);
    if !select && super::input_gesture::drag(app, point) {
        return true;
    }
    let select_owns = app
        .content
        .active()
        .dashboard
        .as_ref()
        .unwrap()
        .select_owns_pointer(point);
    if select && select_owns {
        super::input_gesture::release(app);
        apply(app, |candidate| candidate.input_focus(false));
        super::text_input::refresh(app);
    }
    if select && !select_owns {
        super::input_gesture::press(app, point);
        if app
            .content
            .active()
            .dashboard
            .as_ref()
            .is_some_and(|runtime| runtime.input_focused())
        {
            return true;
        }
    }
    if select
        && !app
            .content
            .active()
            .dashboard
            .as_ref()
            .unwrap()
            .select_owns_pointer(point)
        && let Some(action) = point.and_then(|point| {
            app.content
                .active()
                .dashboard
                .as_ref()?
                .table_action_at(point)
        })
    {
        apply(app, |candidate| candidate.focus_at(point));
        if matches!(action.action.as_str(), "csv" | "xlsx") {
            export_table(app, &action);
        } else {
            apply(app, |candidate| candidate.table_action(&action));
        }
        return true;
    }
    if select && std::env::var_os("DEEP_DASHBOARD_FILTER_EVIDENCE").is_some() {
        println!(
            "dashboard filter pointer: physical={:?} logical={point:?}",
            app.state.cursor
        );
    }
    apply(app, |candidate| candidate.pointer(point, select));
    true
}

pub(in crate::app) fn zoom(app: &mut NativeApp, delta: f64) -> bool {
    if app.content.active().dashboard.is_none() {
        return false;
    }
    if let Some(point) = logical_cursor(app) {
        apply(app, |candidate| candidate.zoom_at(point, delta));
    }
    true
}

pub(in crate::app) fn key(app: &mut NativeApp, key: KeyCode) -> bool {
    let Some(runtime) = app.content.active().dashboard.as_ref() else {
        return false;
    };
    if key == KeyCode::Tab && runtime.has_focus_controls() {
        let reverse = app.input_modifiers.shift_key();
        apply(app, |candidate| candidate.focus_step(reverse));
        super::text_input::refresh(app);
        return true;
    }
    if matches!(key, KeyCode::Enter | KeyCode::Space)
        && let Some(action) = runtime.focused_table_action()
    {
        if matches!(action.action.as_str(), "csv" | "xlsx") {
            export_table(app, &action);
        } else {
            apply(app, |candidate| candidate.table_action(&action));
        }
        return true;
    }
    let select_key = match key {
        KeyCode::Tab => Some("Tab"),
        KeyCode::ArrowUp => Some("ArrowUp"),
        KeyCode::ArrowDown => Some("ArrowDown"),
        KeyCode::Home => Some("Home"),
        KeyCode::End => Some("End"),
        KeyCode::Enter => Some("Enter"),
        KeyCode::Space => Some("Space"),
        KeyCode::Escape => Some("Escape"),
        _ => None,
    };
    if let Some(select_key) = select_key {
        if runtime.select_accepts_key(select_key) {
            apply(app, |candidate| {
                candidate
                    .select_key(select_key)
                    .map(|changed| changed.unwrap_or(false))
            });
            return true;
        }
    }
    let runtime = app.content.active().dashboard.as_ref().unwrap();
    match key {
        KeyCode::ArrowUp | KeyCode::ArrowDown
            if runtime.document().filter.as_ref().is_some_and(|filter| {
                filter.presentation.is_none()
                    && runtime
                        .document()
                        .pages
                        .iter()
                        .find(|page| page.id == runtime.active_page_id())
                        .is_some_and(|page| {
                            page.nodes
                                .iter()
                                .any(|node| node.id == filter.node_id && node.visible)
                        })
            }) =>
        {
            let current = runtime.selected_filter().unwrap_or(0);
            let count = runtime.document().filter.as_ref().unwrap().options.len();
            let next = if key == KeyCode::ArrowUp {
                current.saturating_sub(1)
            } else {
                (current + 1).min(count - 1)
            };
            apply(app, |candidate| candidate.focus_filter(next));
        }
        KeyCode::PageDown | KeyCode::PageUp => {
            let pages = &runtime.document().pages;
            let current = pages
                .iter()
                .position(|page| page.id == runtime.active_page_id())
                .unwrap_or(0);
            let target = if key == KeyCode::PageDown {
                (current + 1).min(pages.len().saturating_sub(1))
            } else {
                current.saturating_sub(1)
            };
            let id = pages[target].id.clone();
            apply(app, |candidate| candidate.switch_page(&id));
        }
        KeyCode::Home => {
            apply(app, DashboardRuntime::reset);
        }
        KeyCode::Equal | KeyCode::NumpadAdd => {
            zoom(app, 1.0);
        }
        KeyCode::Minus | KeyCode::NumpadSubtract => {
            zoom(app, -1.0);
        }
        // 二维文档不接受三维相机旋转键。
        KeyCode::ArrowLeft | KeyCode::ArrowRight => {}
        _ => return false,
    }
    true
}

pub(in crate::app) fn blur(app: &mut NativeApp) {
    super::input_gesture::blur(app);
    if app.content.active().dashboard.is_some() {
        apply(app, DashboardRuntime::blur_select);
        apply(app, DashboardRuntime::blur_controls);
        apply(app, |candidate| candidate.input_focus(false));
        super::text_input::refresh(app);
    }
}

fn logical_cursor(app: &NativeApp) -> Option<[f64; 2]> {
    let list = app
        .content
        .active()
        .dashboard
        .as_ref()?
        .content()
        .display_list();
    let size = app.window.as_ref()?.inner_size();
    if size.width == 0 || size.height == 0 {
        return None;
    }
    let mapping = LetterboxMapping::new(
        [list.logical_width, list.logical_height],
        [size.width.into(), size.height.into()],
    );
    let point = mapping.physical_to_logical(app.state.cursor?);
    (point[0] >= 0.0
        && point[1] >= 0.0
        && point[0] < list.logical_width
        && point[1] < list.logical_height)
        .then_some(point)
}
