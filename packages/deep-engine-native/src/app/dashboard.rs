//! Dashboard 输入与整页 GPU 提交。候选失败时保留运行状态和模拟游标。
use super::NativeApp;
use crate::events::RenderOutcome;
use deep_engine_native::{dashboard_runtime::DashboardRuntime, deep2d::LetterboxMapping};
use std::time::{Duration, Instant};
use winit::{
    event_loop::{ActiveEventLoop, ControlFlow},
    keyboard::KeyCode,
};

pub(super) fn pointer(app: &mut NativeApp, select: bool) -> bool {
    if app.content.active().dashboard.is_none() {
        return false;
    }
    let point = logical_cursor(app);
    apply(app, |candidate| candidate.pointer(point, select));
    true
}

pub(super) fn zoom(app: &mut NativeApp, delta: f64) -> bool {
    if app.content.active().dashboard.is_none() {
        return false;
    }
    if let Some(point) = logical_cursor(app) {
        apply(app, |candidate| candidate.zoom_at(point, delta));
    }
    true
}

pub(super) fn key(app: &mut NativeApp, key: KeyCode) -> bool {
    let Some(runtime) = app.content.active().dashboard.as_ref() else {
        return false;
    };
    match key {
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

pub(super) fn update(
    app: &mut NativeApp,
    action: impl FnOnce(&mut DashboardRuntime) -> Result<bool, String>,
) -> Result<bool, String> {
    let mut candidate = app
        .content
        .active()
        .dashboard
        .as_ref()
        .ok_or("dashboard missing")?
        .clone();
    if !action(&mut candidate)? {
        return Ok(false);
    }
    let content = candidate.content();
    let page = candidate
        .document()
        .pages
        .iter()
        .position(|page| page.id == candidate.active_page_id())
        .ok_or("dashboard active page missing")? as u64;
    let context = super::deep2d_context::active_frame_context(app, content, page);
    let renderer = app
        .renderer
        .as_mut()
        .ok_or("dashboard renderer is not ready")?;
    let staged = pollster::block_on(renderer.stage_deep2d_update_inner(Some(content), context))?;
    let outcome = renderer.present_deep2d_update(staged);
    if !presented(app, outcome)? {
        return Ok(false);
    }
    // GPU 已成功呈现，后续只有无失败赋值。
    let page_changed = app
        .content
        .active()
        .dashboard
        .as_ref()
        .is_some_and(|old| old.active_page_id() != candidate.active_page_id());
    let active = app.content.active_mut();
    active.deep2d = Some(candidate.content().clone());
    active.dashboard = Some(candidate);
    active.epoch.resource_set = page;
    active.epoch.published = true;
    if page_changed {
        app.dashboard_wake_at = None;
    }
    Ok(true)
}

fn apply(app: &mut NativeApp, action: impl FnOnce(&mut DashboardRuntime) -> Result<bool, String>) {
    match update(app, action) {
        Ok(true) => report(app, None),
        Ok(false) => {}
        Err(error) => report(app, Some(&error)),
    }
}

// The renderer guard has already restored the old painter before recovery reaches here.
pub(super) fn presented(app: &mut NativeApp, outcome: RenderOutcome) -> Result<bool, String> {
    match outcome {
        RenderOutcome::Presented => Ok(true),
        RenderOutcome::Skipped => Ok(false),
        RenderOutcome::Failed(error) => Err(error),
        RenderOutcome::Recover => {
            if app.smoke_frame || app.state.verification.is_some() {
                let error = "surface was lost during native verification frame".to_owned();
                app.state.failure = Some(error.clone());
                app.request_redraw();
                return Err(error);
            }
            app.renderer = None;
            app.initialize_renderer();
            Ok(false)
        }
    }
}

fn schedule(app: &mut NativeApp, event_loop: &ActiveEventLoop, wake: Option<Instant>) {
    app.dashboard_wake_at = wake;
    app.chart_sim_scheduled = wake.is_some();
    event_loop.set_control_flow(wake.map_or(ControlFlow::Wait, ControlFlow::WaitUntil));
}
fn retry_delay(committed: bool, due: u64, elapsed: u64) -> Duration {
    if committed {
        super::chart_sim::wake_delay(Some(due), elapsed)
    } else {
        Duration::from_millis(super::chart_sim::RETRY_BACKOFF_MS)
    }
}
pub(super) fn tick(app: &mut NativeApp, event_loop: &ActiveEventLoop) {
    if app.smoke_frame {
        return;
    }
    let now = Instant::now();
    // New content owns a fresh clock; an old package's pending wake never delays it.
    if app.content.active().dashboard_started.is_none() {
        app.dashboard_wake_at = None;
    }
    let started = *app
        .content
        .active_mut()
        .dashboard_started
        .get_or_insert(now);
    if let Some(wake) = app.dashboard_wake_at.filter(|wake| *wake > now) {
        schedule(app, event_loop, Some(wake));
        return;
    }
    let elapsed = now
        .duration_since(started)
        .as_millis()
        .min(u64::MAX as u128) as u64;
    let ready = app
        .content
        .active()
        .dashboard
        .as_ref()
        .and_then(|r| r.next_due_ms().transpose());
    let mut committed = true;
    if matches!(ready, Some(Ok(due)) if due <= elapsed) {
        match update(app, |candidate| candidate.tick(elapsed)) {
            Ok(result) => committed = result,
            Err(error) => {
                report(app, Some(&error));
                committed = false;
            }
        }
    }
    let due = app
        .content
        .active()
        .dashboard
        .as_ref()
        .and_then(|r| r.next_due_ms().transpose());
    match due {
        Some(Ok(due)) => schedule(
            app,
            event_loop,
            now.checked_add(retry_delay(committed, due, elapsed)),
        ),
        Some(Err(error)) => {
            report(app, Some(&error));
            schedule(
                app,
                event_loop,
                now.checked_add(retry_delay(false, 0, elapsed)),
            );
        }
        None => schedule(app, event_loop, None),
    }
}

fn report(app: &NativeApp, error: Option<&str>) {
    let Some(window) = app.window.as_ref() else {
        return;
    };
    let Some(runtime) = app.content.active().dashboard.as_ref() else {
        return;
    };
    let page = runtime
        .document()
        .pages
        .iter()
        .position(|page| page.id == runtime.active_page_id())
        .unwrap_or(0)
        + 1;
    let label = format!("页面 {page} / {}", runtime.document().pages.len());
    let status = error.unwrap_or(&label);
    crate::window_chrome::set_title(window, &format!("Deep Engine Dashboard — {status}"));
}

#[cfg(test)]
mod scheduling_tests {
    use super::*;
    #[test]
    fn overdue_frames_catch_up_at_ten_ms_and_failed_frames_back_off() {
        assert_eq!(retry_delay(true, 0, 60_000), Duration::from_millis(10));
        assert_eq!(retry_delay(false, 0, 60_000), Duration::from_millis(100));
        assert_eq!(retry_delay(true, 60_000, 0), Duration::from_secs(60));
    }
}
