//! Dashboard 输入与整页 GPU 提交。候选失败时保留运行状态和模拟游标。
use super::NativeApp;
use crate::events::RenderOutcome;
use deep_engine_native::dashboard_runtime::DashboardRuntime;
use std::time::Duration;
use web_time::Instant;
use winit::event_loop::{ActiveEventLoop, ControlFlow};

#[cfg(windows)]
#[path = "dashboard_clipboard.rs"]
mod clipboard;
#[path = "dashboard_clipboard_input.rs"]
mod clipboard_input;
#[path = "dashboard_input.rs"]
mod input;
#[path = "dashboard_input_gesture.rs"]
mod input_gesture;
#[path = "dashboard_text_input.rs"]
mod text_input;
pub(super) use input::{blur, key, pointer, zoom};
pub(super) use input_gesture::{InputGesture, release as release_input};
pub(super) use text_input::{ime, refresh as refresh_input, select_text_key, text_key};

fn export_table(app: &NativeApp, action: &deep_engine_native::dashboard_runtime::TableAction) {
    #[cfg(not(windows))]
    let _ = action;
    #[cfg(windows)]
    let result = (|| -> Result<String, String> {
        let (filename, bytes) = app
            .content
            .active()
            .dashboard
            .as_ref()
            .ok_or("dashboard missing")?
            .table_export(action)?;
        report(app, Some("请选择报表保存位置"));
        use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let owner = match app
            .window
            .as_ref()
            .ok_or("window missing")?
            .window_handle()
            .map_err(|error| error.to_string())?
            .as_raw()
        {
            RawWindowHandle::Win32(handle) => handle.hwnd.get(),
            _ => return Err("Windows 窗口不可用".into()),
        };
        let Some(path) = deep_engine_native::dashboard_runtime::report_save::choose_report_path(
            &filename,
            &action.action,
            owner,
        )?
        else {
            return Ok("已取消导出".into());
        };
        deep_engine_native::dashboard_runtime::report_save::save_report_bytes(&path, &bytes)?;
        println!(
            "dashboard table exported: table={} format={} bytes={} path={}",
            action.table_id,
            action.action,
            bytes.len(),
            path.display()
        );
        Ok(format!("已导出：{}", path.display()))
    })();
    #[cfg(not(windows))]
    let result: Result<String, String> = Err("当前平台不支持报表保存窗口".into());
    match result {
        Ok(message) => report(app, Some(&message)),
        Err(error) => report(app, Some(&format!("导出失败：{error}"))),
    }
}

pub(super) fn update(
    app: &mut NativeApp,
    action: impl FnOnce(&mut DashboardRuntime) -> Result<bool, String>,
) -> Result<bool, String> {
    let started = Instant::now();
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
    let action_ms = started.elapsed().as_secs_f64() * 1000.0;
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
    let stage_ms = started.elapsed().as_secs_f64() * 1000.0 - action_ms;
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
    if std::env::var_os("DEEP_DASHBOARD_FILTER_EVIDENCE").is_some()
        && let Some(runtime) = &active.dashboard
        && let Some(filter) = &runtime.document().filter
    {
        println!(
            "dashboard filter presented: selected={:?} rows={:?} update_ms={:.3} action_ms={action_ms:.3} stage_ms={stage_ms:.3}",
            runtime.selected_filter(),
            filter.options[0]
                .updates
                .iter()
                .map(|update| (
                    update.node_id.as_str(),
                    runtime.chart(&update.node_id).map(|chart| chart
                        .source()
                        .datasets
                        .iter()
                        .map(|dataset| dataset.rows.len())
                        .collect::<Vec<_>>())
                ))
                .collect::<Vec<_>>(),
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
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
    let selection = runtime
        .document()
        .filter
        .as_ref()
        .and_then(|filter| {
            runtime
                .selected_filter()
                .and_then(|index| filter.options.get(index))
        })
        .map(|option| format!(" · {}", option.value))
        .unwrap_or_default();
    let label = format!(
        "页面 {page} / {}{selection}",
        runtime.document().pages.len()
    );
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
