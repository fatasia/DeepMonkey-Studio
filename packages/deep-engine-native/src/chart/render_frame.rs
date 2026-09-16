//! Frame assembly and series visibility; primitive geometry stays in render.rs.
use super::{
    CartesianPoints, ChartIR, ChartSeriesType, Ctx, DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION,
    Deep2dDisplayList, LINE_COLOR, ListBuilder, dataset, display_list_id, layout_chart,
    map_cartesian, min_max_envelope, render_bar, render_gauge, render_heatmap, render_pie,
    render_scatter, validate_display_list,
};
/// Renders a validated ChartIR into a Deep2d display list that passes
/// `deep2d::validate_display_list`. Fails closed on unusable canvas sizes.
pub fn render_chart(ir: &ChartIR, width: f64, height: f64) -> Result<Deep2dDisplayList, String> {
    render_chart_with_hidden_series(ir, width, height, &[])
}

/// Applies legend visibility to series geometry. Zoom, emphasis, tooltip and
/// selection presentation are separate passes and are not consumed here.
pub fn render_chart_with_hidden_series(
    ir: &ChartIR,
    width: f64,
    height: f64,
    hidden_series: &[String],
) -> Result<Deep2dDisplayList, String> {
    render_chart_with_windows(ir, width, height, hidden_series, &[])
}

/// Renders visibility and normalized axis windows. Other interaction overlays
/// remain separate. Invalid or unsupported windows fail before frame assembly.
pub fn render_chart_with_windows(
    ir: &ChartIR,
    width: f64,
    height: f64,
    hidden_series: &[String],
    windows: &[(String, f64, f64)],
) -> Result<Deep2dDisplayList, String> {
    render_chart_with_points(ir, width, height, hidden_series, windows, false).map(|(list, _)| list)
}

pub(in crate::chart) fn render_chart_with_points(
    ir: &ChartIR,
    width: f64,
    height: f64,
    hidden_series: &[String],
    windows: &[(String, f64, f64)],
    retain_line_points: bool,
) -> Result<(Deep2dDisplayList, Vec<(String, CartesianPoints)>), String> {
    let mut seen = std::collections::BTreeSet::new();
    for (id, start, end) in windows {
        if !seen.insert(id)
            || !ir.axes.iter().any(|axis| axis.id == *id)
            || !(start.is_finite()
                && end.is_finite()
                && *start >= 0.0
                && *start < *end
                && *end <= 1.0)
        {
            return Err(format!("invalid chart zoom window: {id}"));
        }
    }
    let hidden: std::collections::BTreeSet<&str> =
        hidden_series.iter().map(String::as_str).collect();
    if let Some(id) = hidden
        .iter()
        .find(|id| !ir.series.iter().any(|series| series.id == **id))
    {
        return Err(format!("chart hidden series does not exist: {id}"));
    }
    let frame = layout_chart(ir, width, height)?;
    let mut builder = ListBuilder {
        width,
        height,
        series_key: String::new(),
        series_command: 0,
        data_index: None,
        clip_rect: None,
        resources: Vec::new(),
        commands: Vec::new(),
    };
    let mut line_points = Vec::new();
    for series in &ir.series {
        if hidden.contains(series.id.as_str()) {
            continue;
        }
        let Some(dataset) = dataset(ir, &series.dataset_id) else {
            continue;
        };
        // 系列切换或重排不能改变其他系列的资源身份。
        builder.series_key = crate::runtime_package::runtime_content_sha256(&serde_json::json!([
            "chart-series",
            ir.id,
            series.id
        ]));
        builder.series_command = 0;
        builder.data_index = None;
        builder.clip_rect = (series.series_type == ChartSeriesType::Heatmap
            || windows.iter().any(|(id, _, _)| {
                series.x_axis_id.as_ref() == Some(id) || series.y_axis_id.as_ref() == Some(id)
            }))
        .then_some(crate::deep2d::Deep2dRect {
            x: frame.plot[0],
            y: frame.plot[1],
            width: frame.plot[2],
            height: frame.plot[3],
        });
        let ctx = Ctx {
            dataset,
            series,
            plot: frame.plot,
        };
        match series.series_type {
            ChartSeriesType::Pie => render_pie(&mut builder, &ctx),
            ChartSeriesType::Heatmap => render_heatmap(&mut builder, &ctx, ir, windows),
            ChartSeriesType::Gauge => render_gauge(&mut builder, &ctx),
            cartesian => {
                let Some(CartesianPoints {
                    points,
                    data_indices,
                    band,
                    baseline,
                    invert_x,
                }) = map_cartesian(ir, series, dataset, frame.plot, windows)
                else {
                    continue;
                };
                match cartesian {
                    ChartSeriesType::Line => {
                        // Dense lines render as a min-max envelope fill, the
                        // standard dense-line practice: a 100k-point noise
                        // polyline's stroke outline would self-intersect (the
                        // painter correctly rejects that), while the x-monotone
                        // envelope is always a valid simple polygon.
                        const SAFE_STROKE_POINTS: usize = 480;
                        if points.len() <= SAFE_STROKE_POINTS {
                            builder.stroke(&points, LINE_COLOR);
                        } else {
                            // The painter caps one simple-polygon fill at
                            // 512 points: cap the envelope at 256 groups
                            // (2 chains x 256) — ~5px columns at 1280 wide.
                            let columns = (frame.plot[2] as usize).clamp(1, 256);
                            let envelope = min_max_envelope(&points, columns);
                            builder.fill(&envelope, LINE_COLOR);
                        }
                    }
                    ChartSeriesType::Bar => {
                        render_bar(&mut builder, &points, &data_indices, band, baseline)
                    }
                    _ => render_scatter(&mut builder, &points, &data_indices, &ctx),
                }
                if retain_line_points {
                    // 全部 cartesian 系列都保留:X 反解器不限于折线,
                    // 柱/散点的 axis tooltip 也要反解同一 X 轴。
                    line_points.push((
                        series.id.clone(),
                        CartesianPoints {
                            points,
                            data_indices,
                            band,
                            baseline,
                            invert_x,
                        },
                    ));
                }
            }
        }
    }
    let display_list = Deep2dDisplayList {
        schema_version: DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION,
        id: display_list_id(&ir.id),
        revision: 0,
        logical_width: width,
        logical_height: height,
        scale_factor: 1.0,
        resources: builder.resources,
        commands: builder.commands,
        atlases: Vec::new(),
    };
    // Self-check: a renderer that emits invalid display lists is a bug.
    let validation = validate_display_list(&display_list);
    if !validation.valid {
        return Err(format!(
            "rendered chart display list failed deep2d validation: {:?}",
            validation.issues
        ));
    }
    Ok((display_list, line_points))
}
