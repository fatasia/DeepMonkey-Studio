//! ChartIR viewer uses the existing window, letterbox mapping and GPU staging.
use super::NativeApp;
use deep_engine_native::chart::{ChartAction, ChartEpochCommit, ChartRuntime};
use deep_engine_native::deep2d::{Deep2dRuntimeContent, LetterboxMapping};

pub(super) fn pointer(app: &mut NativeApp, select: bool) -> bool {
    if super::dashboard::pointer(app, select) {
        return true;
    }
    if app.content.active().chart.is_none() {
        return false;
    }
    let point = logical_cursor(app);
    if select && let Some(point) = point {
        let chart = app.content.active().chart.as_ref().unwrap();
        match deep_engine_native::chart::legend::LegendFrame::prepare(chart, app.chart_legend_page)
        {
            Ok(frame) => {
                if let Some(action) = frame.hit(point).cloned() {
                    use deep_engine_native::chart::legend::LegendAction;
                    match action {
                        LegendAction::Toggle(series_id) => update(app, |chart| {
                            chart.dispatch(ChartAction::ToggleLegend { series_id })
                        }),
                        LegendAction::Page(page) => change_legend_page(app, page),
                    }
                    return true;
                }
            }
            Err(error) => {
                report(app, Some(&error));
                return true;
            }
        }
    }
    update(app, move |chart| match (select, point) {
        (true, Some([x, y])) => chart.pointer_select(x, y),
        (false, Some([x, y])) => chart.pointer_move(x, y),
        (false, None) => chart.dispatch(ChartAction::HoverEnd),
        _ => Ok(false),
    });
    true
}

pub(super) fn zoom(app: &mut NativeApp, delta: f64) -> bool {
    if super::dashboard::zoom(app, delta) {
        return true;
    }
    if app.content.active().chart.is_none() {
        return false;
    }
    if !delta.is_finite() || delta == 0.0 || logical_cursor(app).is_none() {
        return true;
    }
    update(app, move |chart| {
        let Some(axis) = chart
            .source()
            .axes
            .iter()
            .find(|axis| axis.channel == deep_engine_native::chart::ChartAxisChannel::X)
        else {
            return Ok(false);
        };
        let id = axis.id.clone();
        let (start, end) = chart.state().zoom_window(&id).unwrap_or((0.0, 1.0));
        let span = ((end - start) * if delta > 0.0 { 0.8 } else { 1.25 }).clamp(0.01, 1.0);
        let start = ((start + end - span) * 0.5).clamp(0.0, 1.0 - span);
        chart.dispatch(ChartAction::Zoom {
            axis_id: id,
            start,
            end: start + span,
        })
    });
    true
}

pub(super) fn reset(app: &mut NativeApp) -> bool {
    if app.content.active().chart.is_none() {
        return false;
    }
    update(app, |chart| chart.dispatch(ChartAction::ResetZoom));
    true
}

fn logical_cursor(app: &NativeApp) -> Option<[f64; 2]> {
    let chart = app.content.active().chart.as_ref()?;
    let size = app.window.as_ref()?.inner_size();
    if size.width == 0 || size.height == 0 {
        return None;
    }
    let list = chart.frame().display_list();
    let mapping = LetterboxMapping::new(
        [list.logical_width, list.logical_height],
        [size.width.into(), size.height.into()],
    );
    let point = mapping.physical_to_logical(app.state.cursor?);
    (point[0] >= 0.0
        && point[0] <= list.logical_width
        && point[1] >= 0.0
        && point[1] <= list.logical_height)
        .then_some(point)
}

pub(super) fn update(
    app: &mut NativeApp,
    action: impl FnOnce(&mut ChartRuntime) -> Result<bool, String>,
) {
    let Some(active) = app.content.active().chart.as_ref() else {
        return;
    };
    let mut candidate = active.clone();
    let anchor = logical_cursor(app).unwrap_or([0.0, 0.0]);
    let result = (|| {
        if !action(&mut candidate)? {
            return Ok(false);
        }
        let pixels_unchanged = app.content.active().chart.as_ref().is_some_and(|active| {
            std::ptr::eq(candidate.frame(), active.frame()) && candidate.state() == active.state()
        });
        if pixels_unchanged {
            app.content.active_mut().chart = Some(candidate);
            return Ok(false);
        }
        {
            let rasterizer = app.chart_text.get_or_insert_with(Default::default);
            let list = deep_engine_native::chart::presentation::present_chart(
                &candidate,
                rasterizer,
                app.chart_legend_page,
                anchor,
                super::window_events::chart_legend_focus(),
            )?;
            let content = Deep2dRuntimeContent::DisplayList(list);
            let epoch = super::deep2d_context::current_resource_epoch(app);
            let context = super::deep2d_context::active_frame_context(app, &content, epoch);
            let renderer = app.renderer.as_mut().ok_or("chart renderer is not ready")?;
            let staged =
                pollster::block_on(renderer.stage_deep2d_update_inner(Some(&content), context))?;
            // 提交区:publish 不可回滚,之后只有无失败赋值,epoch 与内容同帧落地。
            let commit = ChartEpochCommit::new(candidate, content, app.chart_legend_page);
            renderer.publish_deep2d_update(staged);
            let (chart, deep2d) = commit.commit(&mut app.content.active_mut().epoch);
            let active = app.content.active_mut();
            active.chart = Some(chart);
            active.deep2d = Some(deep2d);
        }
        Ok::<_, String>(true)
    })();
    match result {
        Ok(true) => {
            report(app, None);
            app.request_redraw();
        }
        Ok(false) => {}
        Err(error) => report(app, Some(&error)),
    }
}

fn change_legend_page(app: &mut NativeApp, page: usize) {
    let result = (|| {
        let chart = app
            .content
            .active()
            .chart
            .as_ref()
            .ok_or("chart missing")?
            .clone();
        let rasterizer = app.chart_text.get_or_insert_with(Default::default);
        let list = deep_engine_native::chart::presentation::present_chart(
            &chart,
            rasterizer,
            page,
            [0.0, 0.0],
            super::window_events::chart_legend_focus(),
        )?;
        let content = Deep2dRuntimeContent::DisplayList(list);
        // 资源代次传**目标页**:提交后 resource_set 会变成 page,暂存阶段先用它,
        // 旧页条目才会在下一次 prepare 按 epoch 失效;传旧值会漏掉这次换页。
        let context = super::deep2d_context::active_frame_context(app, &content, page as u64);
        let renderer = app.renderer.as_mut().ok_or("chart renderer is not ready")?;
        let staged =
            pollster::block_on(renderer.stage_deep2d_update_inner(Some(&content), context))?;
        // 提交区:legend 页计入 resource_set,与 chart/deep2d 同帧落地。
        let commit = ChartEpochCommit::new(chart, content, page);
        renderer.publish_deep2d_update(staged);
        let (chart, deep2d) = commit.commit(&mut app.content.active_mut().epoch);
        let active = app.content.active_mut();
        active.chart = Some(chart);
        active.deep2d = Some(deep2d);
        app.chart_legend_page = page;
        Ok::<_, String>(())
    })();
    match result {
        Ok(()) => app.request_redraw(),
        Err(error) => report(app, Some(&error)),
    }
}

/// 焦点移动不改变图表内容,但焦点环画在图例像素里——重呈现当前页使环跟随。
pub(super) fn refresh_legend_focus(app: &mut NativeApp) {
    change_legend_page(app, app.chart_legend_page);
}

fn report(app: &NativeApp, error: Option<&str>) {
    let Some(window) = &app.window else { return };
    let Some(chart) = app.content.active().chart.as_ref() else {
        return;
    };
    let status = error.map(str::to_owned).unwrap_or_else(|| {
        if let Some(tooltip) = &chart.state().tooltip {
            format!(
                "{} · {}: {}",
                tooltip.series_id, tooltip.x_value, tooltip.y_value
            )
        } else {
            format!(
                "{} · selected {}",
                chart.source().id,
                chart.state().selected.len()
            )
        }
    });
    crate::window_chrome::set_title(window, &format!("Deep Engine Chart — {status}"));
}
