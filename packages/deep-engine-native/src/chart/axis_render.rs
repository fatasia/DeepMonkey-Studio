//! Presenter-layer axis presentation: axis lines and tick labels as
//! display-list quads on top of the committed series geometry. Tick values
//! and label texts are derived in `axis_ticks.rs` from the ChartIR datasets
//! and the shared scale derivation — this file only paints.
//!
//! Contract decisions:
//! - Series geometry keeps its TS-parity plot rectangle (the web geometry
//!   golden locks it), so labels ride the axis line: an X label hangs below
//!   the axis when the canvas has room and rides into the plot otherwise,
//!   on a translucent backdrop chip to stay readable over bars.
//! - Where a tick label box would overlap the tick segment, the segment is
//!   dropped — labels win. With the fixed 8px canvas padding this usually
//!   means the label position carries the tick semantics on its own.
//! - Text uses the existing text-raster image/atlas channel (the same
//!   `TextRasterizer` path as legend and tooltip). Before any rasterization
//!   the whole label set is probed for `.notdef` glyphs and a missing glyph
//!   fails closed (structured error), never a drawn tofu box.
//! - Pie/gauge/heatmap series bind no axis ticks: the ChartIR contract gives
//!   them no axis label fields, so nothing is invented for them.

use super::{
    ChartAxis, ChartAxisChannel, ChartRuntime, axis_ticks::ticks_for_axis, layout::layout_chart,
};
use crate::{
    deep2d::{
        Deep2dCommand, Deep2dDisplayList, Deep2dPathVerb, Deep2dResource, PathResource,
        validate_display_list,
    },
    native_ui::design_tokens::DesignTokenTheme,
    platform_text::{TextRasterRequest, TextRasterizer},
};

const TICK_LENGTH: f64 = 4.0;
const AXIS_STROKE_WIDTH: f64 = 1.0;
const LABEL_GAP: f64 = 2.0;
/// Axis chrome sits above series commands but below legend (MAX-2) and
/// tooltip (MAX-1/MAX) overlays.
pub const AXIS_LINE_Z: i32 = i32::MAX - 4;
pub const AXIS_TEXT_Z: i32 = i32::MAX - 3;

/// Deep2d resource ids accept a small ASCII set; the ChartIR id is untrusted.
fn axis_id(raw: &str) -> String {
    let filtered: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    if filtered.is_empty() {
        "axis".into()
    } else {
        filtered
    }
}

fn font_family(theme: &DesignTokenTheme) -> &str {
    theme
        .typography
        .font_family
        .split(',')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches(['\'', '"'])
}

fn stroke_line(
    list: &mut Deep2dDisplayList,
    revision: u64,
    id: String,
    from: (f64, f64),
    to: (f64, f64),
    color: [f64; 4],
) {
    let verbs = vec![
        Deep2dPathVerb::Move {
            x: from.0,
            y: from.1,
        },
        Deep2dPathVerb::Line { x: to.0, y: to.1 },
    ];
    list.resources.push(Deep2dResource::Path(PathResource {
        id: id.clone(),
        revision,
        verbs,
    }));
    list.commands
        .push(Deep2dCommand::Path(crate::deep2d::PathCommand {
            id: format!("{id}.cmd"),
            z_order: AXIS_LINE_Z,
            transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            opacity: None,
            clip_path_ids: None,
            clip_rect: None,
            hit_id: None,
            path_id: id,
            fill: None,
            fill_rule: None,
            stroke: Some(color),
            stroke_width: Some(AXIS_STROKE_WIDTH),
            line_cap: None,
            line_join: None,
            miter_limit: None,
            dash: None,
            dash_offset: None,
        }));
}

/// Filled rectangle via a closed path (same pattern as legend focus rings).
fn stroke_rect(
    list: &mut Deep2dDisplayList,
    revision: u64,
    id: String,
    rect: [f64; 4],
    color: [f64; 4],
) {
    let [x, y, w, h] = rect;
    let verbs = vec![
        Deep2dPathVerb::Move { x, y },
        Deep2dPathVerb::Line { x: x + w, y },
        Deep2dPathVerb::Line { x: x + w, y: y + h },
        Deep2dPathVerb::Line { x, y: y + h },
        Deep2dPathVerb::Close,
    ];
    list.resources.push(Deep2dResource::Path(PathResource {
        id: id.clone(),
        revision,
        verbs,
    }));
    list.commands
        .push(Deep2dCommand::Path(crate::deep2d::PathCommand {
            id: format!("{id}.cmd"),
            z_order: AXIS_LINE_Z + 1,
            transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            opacity: None,
            clip_path_ids: None,
            clip_rect: None,
            hit_id: None,
            path_id: id,
            fill: Some(color),
            fill_rule: Some(crate::deep2d::FillRule::Nonzero),
            stroke: None,
            stroke_width: None,
            line_cap: None,
            line_join: None,
            miter_limit: None,
            dash: None,
            dash_offset: None,
        }));
}

/// Appends axis lines, ticks and tick labels for every axis that visible
/// cartesian series bind to. Fails closed on missing tokens or glyphs.
pub fn append_axes(
    list: &mut Deep2dDisplayList,
    chart: &ChartRuntime,
    rasterizer: &mut TextRasterizer,
    theme: &DesignTokenTheme,
) -> Result<(), String> {
    let source = chart.source();
    let frame = layout_chart(source, list.logical_width, list.logical_height)?;
    let plot = frame.plot;
    let line_color = theme.colors.line_strong.ok_or("axis line token missing")?;
    // Axis text is primary readout, not secondary chrome: the strong token
    // keeps every tick legible over geometry and through the linear-space
    // painter, matching the legend text layer.
    let label_color = theme.colors.text_strong.ok_or("axis label token missing")?;
    let backdrop = theme.colors.bg1.ok_or("axis backdrop token missing")?;
    let all = [line_color, label_color, backdrop];
    if all
        .iter()
        .flat_map(|color| color.iter())
        .any(|value: &f64| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        return Err("axis color token invalid".into());
    }
    let font_size = theme.typography.font_size_base;
    let line_height = font_size * theme.typography.line_height;
    let family = font_family(theme);
    let canvas = [list.logical_width, list.logical_height];
    let revision = chart.revision();
    let windows: Vec<(String, f64, f64)> = chart.state().zoom_windows.clone();
    let hidden: Vec<String> = chart.state().hidden_series.to_vec();
    let id_prefix = axis_id(&source.id);

    for axis in &source.axes {
        let horizontal = axis.channel == ChartAxisChannel::X;
        let axis_pixel = if horizontal {
            plot[1] + plot[3]
        } else {
            plot[0]
        };
        let range = if horizontal {
            (plot[0], plot[0] + plot[2])
        } else {
            (plot[1] + plot[3], plot[1])
        };
        let id = format!("chart-axis.{id_prefix}.{}", axis_id(&axis.id));
        let (from, to) = if horizontal {
            ((range.0, axis_pixel), (range.1, axis_pixel))
        } else {
            ((axis_pixel, range.0), (axis_pixel, range.1))
        };
        stroke_line(list, revision, format!("{id}.line"), from, to, line_color);

        let ticks = ticks_for_axis(source, axis, &hidden, &windows, range);
        if ticks.is_empty() {
            continue;
        }
        paint_tick_labels(
            list,
            rasterizer,
            family,
            font_size,
            line_height,
            label_color,
            axis,
            axis_pixel,
            horizontal,
            ticks,
            canvas,
            revision,
            &id,
            backdrop,
        )?;
    }
    let validation = validate_display_list(list);
    if !validation.valid {
        return Err(format!("chart axes: {:?}", validation.issues));
    }
    Ok(())
}

/// Rasterizes and places one image quad per tick label.
#[allow(clippy::too_many_arguments)]
fn paint_tick_labels(
    list: &mut Deep2dDisplayList,
    rasterizer: &mut TextRasterizer,
    family: &str,
    font_size: f64,
    line_height: f64,
    color: [f64; 4],
    axis: &ChartAxis,
    axis_pixel: f64,
    horizontal: bool,
    ticks: Vec<super::axis_ticks::TickLabel>,
    canvas: [f64; 2],
    revision: u64,
    id: &str,
    backdrop: [f64; 4],
) -> Result<(), String> {
    let joined: String = ticks.iter().map(|tick| tick.text.as_str()).collect();
    if !rasterizer.shapes_without_missing_glyphs(family, &joined) {
        return Err(format!(
            "chart axis {}: tick labels need glyphs missing from family \"{family}\"; \
             bind a covering font or simplify the labels.",
            axis.id
        ));
    }
    for tick in ticks {
        let measured = rasterizer
            .measure(&tick.text, family, font_size as f32, line_height as f32)?
            .max(1.0);
        let width = (f64::from(measured).ceil() + 2.0).clamp(1.0, 2048.0);
        let height = line_height.ceil().clamp(1.0, 2048.0);
        // X: centered under the tick, below the axis while the canvas allows.
        // Y: right-aligned against the axis, vertically centered on the tick.
        let (origin, outer_segment) = if horizontal {
            let x = (tick.position - width * 0.5).clamp(0.0, (canvas[0] - width).max(0.0));
            let y = (axis_pixel + LABEL_GAP).min((canvas[1] - height).max(0.0));
            ((x, y), (tick.position, axis_pixel + TICK_LENGTH))
        } else {
            let x = (axis_pixel + LABEL_GAP - width).clamp(0.0, (canvas[0] - width).max(0.0));
            let y = (tick.position - height * 0.5).clamp(0.0, (canvas[1] - height).max(0.0));
            ((x, y), (axis_pixel - TICK_LENGTH, tick.position))
        };
        // Drop the tick segment when the label box would cover it.
        let overlaps = if horizontal {
            origin.1 <= outer_segment.1 + 0.5
        } else {
            origin.0 + width >= outer_segment.0 - 0.5
        };
        if !overlaps {
            let (from, to) = if horizontal {
                (
                    (outer_segment.0, axis_pixel),
                    (outer_segment.0, outer_segment.1),
                )
            } else {
                (
                    (outer_segment.0, outer_segment.1),
                    (axis_pixel, outer_segment.1),
                )
            };
            stroke_line(
                list,
                revision,
                format!("{id}.tick.{}", tick.position),
                from,
                to,
                color,
            );
        }
        if horizontal {
            // Translucent backdrop so the label stays readable over bars.
            let pad = 3.0;
            stroke_rect(
                list,
                revision,
                format!("{id}.backdrop.{}", tick.position),
                [origin.0 - pad, origin.1, width + pad * 2.0, height],
                [backdrop[0], backdrop[1], backdrop[2], 0.78],
            );
        }
        let pixels = rasterizer.rasterize_for_display(TextRasterRequest {
            text: &tick.text,
            family,
            font_size: font_size as f32,
            line_height: line_height as f32,
            width: width as u32,
            height: height as u32,
            color: color.map(|value| (value * 255.0).round() as u8),
        })?;
        let label_key = crate::runtime_package::runtime_content_sha256(&serde_json::json!([
            "chart-axis-label",
            axis.id,
            tick.text,
            tick.position
        ]));
        let layer = pixels.into_display_list(
            &format!("chart-axis.{label_key}"),
            revision,
            canvas,
            [origin.0, origin.1],
            AXIS_TEXT_Z,
        )?;
        list.resources.extend(layer.resources);
        list.commands.extend(layer.commands);
        list.atlases.extend(layer.atlases);
    }
    Ok(())
}
