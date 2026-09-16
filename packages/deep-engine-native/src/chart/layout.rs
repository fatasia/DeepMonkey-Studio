//! Chart layout (C02): resolves the plot / legend / title rectangles for a
//! canvas size. Pure CPU, fail-closed on unusable canvas sizes so the
//! renderer never has to invent geometry for a degenerate frame.
//!
//! Contract notes:
//! - Legend visibility and position come from ChartIR. Text measurement and
//!   legend item placement belong to the presenter; this pass reserves space.
//! - `MAX_CANVAS_SIZE` mirrors `deep2d::validate::MAX_DRAW_VALUE`: display
//!   list logical sizes (and every coordinate) must stay within that bound.

use crate::chart::chart_ir::ChartIR;
use crate::chart::interaction_contract::LegendPosition;

/// Canvas padding on all four sides, in logical pixels.
pub const PADDING: f64 = 8.0;
/// Reserved legend band height at the top of the canvas (inside padding).
pub const LEGEND_BAND_HEIGHT: f64 = 24.0;
/// Side legends reserve a label column rather than a horizontal row.
pub const LEGEND_BAND_WIDTH: f64 = 120.0;
/// Upper bound for canvas edges; matches the Deep2d display list validator.
pub const MAX_CANVAS_SIZE: f64 = 16_777_216.0;

/// Resolved chart frame; every rect is `[x, y, width, height]` in logical
/// pixels with the canvas origin at the top-left (screen space, y grows down).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChartFrame {
    pub plot: [f64; 4],
    /// `None` while the chart has no visible legend band.
    pub legend: Option<[f64; 4]>,
    /// `None` while the chart has no title.
    pub title: Option<[f64; 4]>,
}

/// Shared canvas guard for layout and rendering: finite, positive and within
/// the Deep2d display list size budget.
pub fn validate_canvas_size(width: f64, height: f64) -> Result<(), String> {
    for (name, value) in [("width", width), ("height", height)] {
        if !value.is_finite() || value <= 0.0 || value > MAX_CANVAS_SIZE {
            return Err(format!(
                "chart {name} must be a finite size in (0, {MAX_CANVAS_SIZE}] logical pixels, got {value}."
            ));
        }
    }
    Ok(())
}

/// Resolves the chart frame for `width` x `height`. Fails closed when the
/// size is invalid or too small to leave a positive plot area once the
/// legend band and padding are reserved.
pub fn layout_chart(ir: &ChartIR, width: f64, height: f64) -> Result<ChartFrame, String> {
    validate_canvas_size(width, height)?;
    let plot = [
        PADDING,
        PADDING,
        width - PADDING * 2.0,
        height - PADDING * 2.0,
    ];
    let mut plot = plot;
    let legend = if ir.legend.visible {
        let [x, y, w, h] = plot;
        Some(match ir.legend.position {
            LegendPosition::Top => {
                plot[1] += LEGEND_BAND_HEIGHT;
                plot[3] -= LEGEND_BAND_HEIGHT;
                [x, y, w, LEGEND_BAND_HEIGHT]
            }
            LegendPosition::Bottom => {
                plot[3] -= LEGEND_BAND_HEIGHT;
                [x, y + h - LEGEND_BAND_HEIGHT, w, LEGEND_BAND_HEIGHT]
            }
            LegendPosition::Left => {
                plot[0] += LEGEND_BAND_WIDTH;
                plot[2] -= LEGEND_BAND_WIDTH;
                [x, y, LEGEND_BAND_WIDTH, h]
            }
            LegendPosition::Right => {
                plot[2] -= LEGEND_BAND_WIDTH;
                [x + w - LEGEND_BAND_WIDTH, y, LEGEND_BAND_WIDTH, h]
            }
        })
    } else {
        None
    };
    if plot[2] <= 0.0 || plot[3] <= 0.0 {
        return Err(format!(
            "chart canvas {width}x{height} is too small for its legend and {PADDING}px padding."
        ));
    }
    Ok(ChartFrame {
        plot,
        legend,
        title: None,
    })
}
