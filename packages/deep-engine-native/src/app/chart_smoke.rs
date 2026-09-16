//! Programmatic window probes for actual chart GPU commits.
use super::NativeApp;
use super::chart::{pointer, reset, zoom};
use deep_engine_native::deep2d::LetterboxMapping;
#[path = "chart_data_smoke.rs"]
mod data;

pub(super) fn advance_smoke(app: &mut NativeApp) -> Result<bool, String> {
    if app.content.active().chart_sim.is_some() {
        return super::chart_sim::advance_smoke(app);
    }
    let source = app
        .content
        .active()
        .chart
        .as_ref()
        .ok_or("chart smoke source missing")?;
    let Some(axis) = source
        .source()
        .axes
        .iter()
        .find(|axis| axis.channel == deep_engine_native::chart::ChartAxisChannel::X)
    else {
        app.chart_probe = None;
        println!("native chart smoke: static GPU frame presented; no X axis");
        return Ok(true);
    };
    let (start, end) = source.state().zoom_window(&axis.id).unwrap_or((0.0, 1.0));
    let zoom_direction = if end - start <= 0.01 { -1.0 } else { 1.0 };
    let step = app.chart_probe.unwrap_or(8);
    if step >= 8 || (step >= 4 && !source.source().legend.visible) {
        app.chart_probe = None;
        println!("native chart smoke: initial/zoom/reset/tooltip/clear GPU frames presented");
        return Ok(true);
    }
    if step >= 4 {
        return advance_legend(app, step);
    }
    let size = app
        .window
        .as_ref()
        .ok_or("chart smoke window missing")?
        .inner_size();
    if step == 2 {
        if !source.source().tooltip.enabled
            || source.source().tooltip.trigger
                == deep_engine_native::chart::interaction_contract::TooltipTrigger::None
        {
            app.chart_probe = None;
            println!(
                "native chart smoke: initial/zoom/reset presented; tooltip disabled by source"
            );
            return Ok(true);
        }
        let list = source.frame().display_list();
        let point = (0..list.logical_height as u32).step_by(2).find_map(|y| {
            (0..list.logical_width as u32).step_by(2).find_map(|x| {
                source
                    .frame()
                    .pick(x.into(), y.into())
                    .filter(|hit| hit.data_index.is_some())
                    .map(|_| [f64::from(x), f64::from(y)])
            })
        });
        let Some(point) = point else {
            app.chart_probe = None;
            println!(
                "native chart smoke: initial/zoom/reset presented; no datum hit at probe resolution"
            );
            return Ok(true);
        };
        let mapping = LetterboxMapping::new(
            [list.logical_width, list.logical_height],
            [size.width.into(), size.height.into()],
        );
        app.state.cursor = Some(mapping.logical_to_physical(point));
        pointer(app, false);
        if app
            .content
            .active()
            .chart
            .as_ref()
            .is_none_or(|chart| chart.state().tooltip.is_none())
        {
            return Err("chart smoke tooltip commit failed".into());
        }
        app.chart_probe = Some(3);
        probe_selection(app)?;
        return Ok(false);
    }
    if step == 3 {
        probe_selection(app)?;
        app.state.cursor = None;
        pointer(app, false);
        if app
            .content
            .active()
            .chart
            .as_ref()
            .is_some_and(|chart| chart.state().tooltip.is_some())
        {
            return Err("chart smoke tooltip clear failed".into());
        }
        app.chart_probe = Some(4);
        return Ok(false);
    }
    app.state.cursor = Some([f64::from(size.width) * 0.5, f64::from(size.height) * 0.5]);
    let before = app
        .content
        .active()
        .chart
        .as_ref()
        .ok_or("chart smoke source missing")?
        .frame()
        .display_list()
        .revision;
    if step == 0 {
        data::append_window(app)?;
        zoom(app, zoom_direction);
    } else {
        reset(app);
    }
    let chart = app
        .content
        .active()
        .chart
        .as_ref()
        .ok_or("chart smoke source missing")?;
    if chart.frame().display_list().revision <= before {
        return Err("chart smoke geometry commit failed".into());
    }
    app.chart_probe = Some(step + 1);
    Ok(false)
}

fn probe_selection(app: &mut NativeApp) -> Result<(), String> {
    let before = app
        .content
        .active()
        .chart
        .as_ref()
        .ok_or("chart missing")?
        .state()
        .selected
        .clone();
    pointer(app, true);
    let after = &app
        .content
        .active()
        .chart
        .as_ref()
        .ok_or("chart missing")?
        .state()
        .selected;
    if *after == before {
        return Err("chart smoke selection commit failed".into());
    }
    println!("native chart smoke: selection pixels committed");
    Ok(())
}

fn advance_legend(app: &mut NativeApp, step: u8) -> Result<bool, String> {
    use deep_engine_native::chart::legend::{LegendAction, LegendFrame};
    let chart = app.content.active().chart.as_ref().ok_or("chart missing")?;
    let frame = LegendFrame::prepare(chart, app.chart_legend_page)?;
    let item = frame.items.iter().find(|item| match &item.action {
        LegendAction::Toggle(_) => step < 6,
        LegendAction::Page(page) => {
            if step == 6 {
                *page > frame.page
            } else {
                step == 7 && *page < frame.page
            }
        }
    });
    let Some(item) = item else {
        app.chart_probe = None;
        println!("native chart smoke: legend toggle verified; pagination not available");
        return Ok(true);
    };
    let action = item.action.clone();
    let old_hidden = chart.state().hidden_series.clone();
    let list = chart.frame().display_list();
    let size = app.window.as_ref().ok_or("window missing")?.inner_size();
    let mapping = LetterboxMapping::new(
        [list.logical_width, list.logical_height],
        [size.width.into(), size.height.into()],
    );
    app.state.cursor = Some(mapping.logical_to_physical([
        item.rect[0] + item.rect[2] * 0.5,
        item.rect[1] + item.rect[3] * 0.5,
    ]));
    pointer(app, true);
    let chart = app.content.active().chart.as_ref().ok_or("chart missing")?;
    match action {
        LegendAction::Toggle(id) => {
            if old_hidden.contains(&id) == chart.state().hidden_series.contains(&id) {
                return Err("chart smoke legend toggle commit failed".into());
            }
        }
        LegendAction::Page(page) => {
            if app.chart_legend_page != page {
                return Err("chart smoke legend page commit failed".into());
            }
        }
    }
    println!("native chart smoke: legend interaction {step} committed");
    app.chart_probe = Some(step + 1);
    Ok(false)
}
