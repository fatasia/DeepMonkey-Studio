//! Chart renderer (C03): validated ChartIR → Deep2d display list, pure CPU.
//!
//! Contract decisions:
//! - Path-only output; text (axis labels, legends) waits for the font pipeline.
//! - Arcs/circles are polyline approximations; subpaths always start with Move,
//!   closed fill subpaths keep ≥3 distinct points and stay simple polygons, so
//!   the painter's degenerate-edge and self-intersection guards never fire.
//! - Every coordinate is clamped into `[0, logical]`; colors come from fixed
//!   semantic palettes in `[0, 1]`. Output is re-validated with
//!   `deep2d::validate_display_list` (fail-closed).
//! - Missing datasets/dimensions or empty rows yield empty geometry, not errors.

use crate::chart::chart_ir::{
    ChartAxis, ChartDataset, ChartIR, ChartScale, ChartSeries, ChartSeriesType,
};
use crate::chart::layout::layout_chart;

#[path = "render_domain.rs"]
mod domain;
use crate::deep2d::{
    DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION, Deep2dColor, Deep2dCommand, Deep2dDisplayList,
    Deep2dMatrix, Deep2dPathVerb, Deep2dResource, FillRule, LineCap, LineJoin, PathCommand,
    PathResource, validate_display_list,
};
#[path = "render_cartesian.rs"]
mod cartesian;
pub(in crate::chart) use cartesian::XInverter;
pub(super) use cartesian::{CartesianPoints, map_cartesian};

const LINE_COLOR: Deep2dColor = [0.2, 0.6, 1.0, 1.0];
const BAR_COLOR: Deep2dColor = [0.2, 0.8, 0.4, 1.0];
const SCATTER_COLOR: Deep2dColor = [1.0, 0.8, 0.2, 1.0];
const GAUGE_COLOR: Deep2dColor = [0.5, 0.7, 1.0, 1.0];
const NEEDLE_COLOR: Deep2dColor = [1.0, 1.0, 1.0, 1.0];
/// Heat color ramp, cold → hot, linearly interpolated per channel.
const HEAT_COLD: [f64; 3] = [0.1, 0.2, 0.8];
const HEAT_HOT: [f64; 3] = [0.9, 0.2, 0.1];
/// Fixed 6-color ring for pie wedges, indexed by wedge % 6.
const PIE_PALETTE: [Deep2dColor; 6] = [
    [0.33, 0.44, 0.78, 1.0],
    [0.57, 0.8, 0.46, 1.0],
    [0.98, 0.78, 0.35, 1.0],
    [0.93, 0.4, 0.4, 1.0],
    [0.45, 0.75, 0.87, 1.0],
    [0.23, 0.64, 0.45, 1.0],
];
const STROKE_WIDTH: f64 = 2.0;
const SCATTER_RADIUS: f64 = 3.0;
/// Polyline segments approximating a full circle (pie ring).
const RING_SEGMENTS: usize = 24;
/// Scatter markers use a coarser octagon per the C03 contract.
const SCATTER_SEGMENTS: usize = 8;
const GAUGE_START_DEG: f64 = 135.0;
const GAUGE_SWEEP_DEG: f64 = 270.0;
const GAUGE_INNER_RATIO: f64 = 0.72;
const NEEDLE_LENGTH_RATIO: f64 = 0.8;
/// Points closer than this are duplicates; keeps polygons free of degenerate
/// edges that the painter rejects.
const POINT_EPSILON: f64 = 1e-9;

const IDENTITY_MATRIX: Deep2dMatrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn heat_color(t: f64) -> Deep2dColor {
    let [cr, cg, cb] = HEAT_COLD;
    let [hr, hg, hb] = HEAT_HOT;
    [
        cr + (hr - cr) * t,
        cg + (hg - cg) * t,
        cb + (hb - cb) * t,
        1.0,
    ]
}

fn rect_points(x: f64, y: f64, width: f64, height: f64) -> [(f64, f64); 4] {
    [
        (x, y),
        (x + width, y),
        (x + width, y + height),
        (x, y + height),
    ]
}

/// Full-circle polygon: `segments` distinct vertices, no duplicated endpoint
/// (the closing verb wraps the ring).
fn circle_points(center: (f64, f64), radius: f64, segments: usize) -> Vec<(f64, f64)> {
    let mut ring = arc_points(center, radius, 0.0, 360.0, segments);
    ring.pop();
    ring
}

fn arc_points(
    center: (f64, f64),
    radius: f64,
    start_deg: f64,
    sweep_deg: f64,
    segments: usize,
) -> Vec<(f64, f64)> {
    let segments = segments.max(1);
    (0..=segments)
        .map(|step| {
            let angle = (start_deg + sweep_deg * step as f64 / segments as f64).to_radians();
            (
                center.0 + radius * angle.cos(),
                center.1 + radius * angle.sin(),
            )
        })
        .collect()
}

fn extent(values: impl Iterator<Item = f64>) -> Option<(f64, f64)> {
    let (min, max) = values.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
        (lo.min(v), hi.max(v))
    });
    (min.is_finite() && max.is_finite()).then_some((min, max))
}

/// Deep2d ids must be stable ASCII identifiers; the ChartIR id is not
/// (TS/JSON ids accept Unicode), so it is sanitized, never trusted.
fn display_list_id(raw: &str) -> String {
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-');
    let filtered: String = raw.chars().filter(|c| allowed(*c)).collect();
    let mut id = if filtered.is_empty() {
        "chart".into()
    } else {
        filtered
    };
    if !id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        || matches!(id.as_str(), "__proto__" | "prototype" | "constructor")
    {
        id.insert(0, 'c');
    }
    id.truncate(256); // ASCII-only above, so byte truncation stays char-safe
    id
}

/// Per-series render context shared by all six type renderers.
struct Ctx<'a> {
    dataset: &'a ChartDataset,
    series: &'a ChartSeries,
    plot: [f64; 4],
}

/// Accumulates path resources + commands with unique ASCII ids and
/// painter-safe verb sequences.
/// Builds the min-max envelope polygon for a dense line. Points are grouped
/// by their clamped pixel x (groups are strictly x-increasing because the
/// input is x-nondecreasing), each group contributes its min-y and max-y,
/// and the fill path is the min chain left-to-right plus the max chain
/// right-to-left. Both chains are strict x-monotone functions with min<=max
/// at every x, so the closed polygon never self-intersects — a hard
/// requirement of the painter's simple-polygon fill.
fn min_max_envelope(points: &[(f64, f64)], max_groups: usize) -> Vec<(f64, f64)> {
    if points.is_empty() || max_groups == 0 {
        return Vec::new();
    }
    let group_width = points.len() as f64 / max_groups.min(points.len()) as f64;
    let mut groups: Vec<(f64, f64, f64)> = Vec::new(); // (x, min_y, max_y)
    let mut last_group: Option<usize> = None;
    for (index, point) in points.iter().enumerate() {
        let group = ((index as f64 / group_width) as usize).min(max_groups - 1);
        match last_group {
            Some(previous) if previous == group => {
                let entry = groups.last_mut().expect("group exists");
                entry.1 = entry.1.min(point.1);
                entry.2 = entry.2.max(point.1);
            }
            _ => {
                groups.push((point.0, point.1, point.1));
                last_group = Some(group);
            }
        }
    }
    let mut envelope = Vec::with_capacity(groups.len() * 2);
    for (x, min_y, _) in &groups {
        envelope.push((*x, *min_y));
    }
    for (x, _, max_y) in groups.iter().rev() {
        envelope.push((*x, *max_y));
    }
    envelope
}

struct ListBuilder {
    width: f64,
    height: f64,
    series_key: String,
    series_command: usize,
    data_index: Option<usize>,
    clip_rect: Option<crate::deep2d::Deep2dRect>,
    resources: Vec<Deep2dResource>,
    commands: Vec<Deep2dCommand>,
}

impl ListBuilder {
    fn clamp(&self, value: f64, max: f64) -> f64 {
        if value.is_nan() {
            0.0
        } else {
            value.clamp(0.0, max)
        }
    }

    fn point(&self, x: f64, y: f64) -> (f64, f64) {
        if self.clip_rect.is_some() {
            return (x, y);
        }
        (self.clamp(x, self.width), self.clamp(y, self.height))
    }

    /// Clamped, consecutive-deduped verb sequence. Drops degenerate subpaths:
    /// the painter rejects closed fill subpaths with <3 distinct points and
    /// open subpaths with <2.
    fn subpath_verbs(&self, points: &[(f64, f64)], close: bool) -> Vec<Deep2dPathVerb> {
        let min_points = if close { 3 } else { 2 };
        let mut pts: Vec<(f64, f64)> = Vec::with_capacity(points.len());
        for (x, y) in points.iter().map(|&(x, y)| self.point(x, y)) {
            let near_last = pts.last().is_some_and(|&(lx, ly)| {
                (lx - x).abs() < POINT_EPSILON && (ly - y).abs() < POINT_EPSILON
            });
            if !near_last {
                pts.push((x, y));
            }
        }
        if close && pts.len() > 1 && pts.first() == pts.last() {
            pts.pop();
        }
        if pts.len() < min_points {
            return Vec::new();
        }
        let mut verbs = Vec::with_capacity(pts.len() + 1);
        verbs.push(Deep2dPathVerb::Move {
            x: pts[0].0,
            y: pts[0].1,
        });
        for &(x, y) in &pts[1..] {
            verbs.push(Deep2dPathVerb::Line { x, y });
        }
        if close {
            verbs.push(Deep2dPathVerb::Close);
        }
        verbs
    }

    fn fill(&mut self, points: &[(f64, f64)], color: Deep2dColor) {
        self.emit(self.subpath_verbs(points, true), Some(color), None);
    }

    fn stroke(&mut self, points: &[(f64, f64)], color: Deep2dColor) {
        // The painter enforces three per-subpath budgets: flattened segments
        // (16384), the self-intersection check (2048) and the stroke-outline
        // simple polygon cap (512 points ≈ 170-170*2 polyline points). The
        // outline budget binds; dense series split into chained subpaths so
        // a million-point line renders instead of failing tessellation.
        const MAX_STROKE_POINTS: usize = 160;
        if points.len() <= MAX_STROKE_POINTS {
            self.emit(self.subpath_verbs(points, false), None, Some(color));
            return;
        }
        for chunk in points.chunks(MAX_STROKE_POINTS) {
            if chunk.len() < 2 {
                continue;
            }
            self.emit(self.subpath_verbs(chunk, false), None, Some(color));
        }
    }

    fn emit(
        &mut self,
        verbs: Vec<Deep2dPathVerb>,
        fill: Option<Deep2dColor>,
        stroke: Option<Deep2dColor>,
    ) {
        if verbs.is_empty() {
            return;
        }
        let index = self.commands.len();
        let local = self.series_command;
        self.series_command += 1;
        let path_id = format!("path-{}-{local}", self.series_key);
        self.resources.push(Deep2dResource::Path(PathResource {
            id: path_id.clone(),
            revision: 0,
            verbs,
        }));
        // A stroke without an explicit stroke_width fails validation
        // (validator positive-checks `stroke_width.unwrap_or(NaN)`).
        self.commands.push(Deep2dCommand::Path(PathCommand {
            id: format!("cmd-{}-{local}", self.series_key),
            z_order: index as i32,
            transform: IDENTITY_MATRIX,
            opacity: None,
            clip_path_ids: None,
            clip_rect: self.clip_rect,
            hit_id: Some(format!(
                "hit-{}-{}",
                self.series_key,
                self.data_index
                    .map_or_else(|| "series".into(), |index| index.to_string())
            )),
            path_id,
            fill,
            fill_rule: fill.map(|_| FillRule::Nonzero),
            stroke,
            stroke_width: stroke.map(|_| STROKE_WIDTH),
            line_cap: stroke.map(|_| LineCap::Round),
            line_join: stroke.map(|_| LineJoin::Round),
            miter_limit: None,
            dash: None,
            dash_offset: None,
        }));
    }
}

fn dataset<'a>(ir: &'a ChartIR, id: &str) -> Option<&'a ChartDataset> {
    ir.datasets.iter().find(|dataset| dataset.id == id)
}

fn dim(dataset: &ChartDataset, name: &Option<String>) -> Option<usize> {
    let name = name.as_deref()?;
    dataset
        .dimensions
        .iter()
        .position(|dimension| dimension == name)
}

fn finite_value(row: &[serde_json::Value], column: usize) -> Option<f64> {
    row.get(column)
        .and_then(|value| value.as_f64())
        .filter(|value| value.is_finite())
}

fn axis_of<'a>(ir: &'a ChartIR, axis_id: Option<&String>) -> Option<&'a ChartAxis> {
    let axis_id = axis_id?;
    ir.axes.iter().find(|axis| &axis.id == axis_id)
}

fn render_bar(
    builder: &mut ListBuilder,
    points: &[(f64, f64)],
    indices: &[usize],
    band: f64,
    baseline: f64,
) {
    let width = band * 0.8;
    for (&(x, y), &index) in points.iter().zip(indices) {
        builder.data_index = Some(index);
        if width <= 0.0 || (y - baseline).abs() < POINT_EPSILON {
            continue; // zero-height bars would be degenerate polygons
        }
        let (top, bottom) = if y <= baseline {
            (y, baseline)
        } else {
            (baseline, y)
        };
        builder.fill(
            &rect_points(x - width * 0.5, top, width, bottom - top),
            BAR_COLOR,
        );
    }
}

fn render_scatter(
    builder: &mut ListBuilder,
    points: &[(f64, f64)],
    indices: &[usize],
    ctx: &Ctx<'_>,
) {
    let [_, _, pw, ph] = ctx.plot;
    let radius = SCATTER_RADIUS.max(0.5).min(pw * 0.5).min(ph * 0.5);
    for (&(x, y), &index) in points.iter().zip(indices) {
        builder.data_index = Some(index);
        builder.fill(
            &circle_points((x, y), radius, SCATTER_SEGMENTS),
            SCATTER_COLOR,
        );
    }
}

fn render_pie(builder: &mut ListBuilder, ctx: &Ctx<'_>) {
    let Some(value_col) = dim(ctx.dataset, &ctx.series.value) else {
        return;
    };
    // Negative/zero values have no wedge; they are skipped, not clamped.
    let values: Vec<(usize, f64)> = ctx
        .dataset
        .rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| finite_value(row, value_col).map(|value| (index, value)))
        .filter(|(_, value)| *value > 0.0)
        .collect();
    let total: f64 = values.iter().map(|(_, value)| value).sum();
    if total <= 0.0 {
        return;
    }
    let [px, py, pw, ph] = ctx.plot;
    let radius = (pw.min(ph) * 0.5 - 4.0)
        .max(1.0)
        .min(pw * 0.5)
        .min(ph * 0.5);
    let center = (px + pw * 0.5, py + ph * 0.5);
    let mut start = -90.0; // 12 o'clock; y-down screen space sweeps clockwise
    for (index, (data_index, value)) in values.iter().enumerate() {
        builder.data_index = Some(*data_index);
        let sweep = value / total * 360.0;
        let color = PIE_PALETTE[index % PIE_PALETTE.len()];
        if sweep >= 360.0 - POINT_EPSILON {
            builder.fill(&circle_points(center, radius, RING_SEGMENTS), color);
        } else {
            let segments = (sweep / 360.0 * RING_SEGMENTS as f64).ceil().max(1.0) as usize;
            let mut wedge = vec![center];
            wedge.extend(arc_points(center, radius, start, sweep, segments));
            builder.fill(&wedge, color);
        }
        start += sweep;
    }
}

fn slot(list: &mut Vec<serde_json::Value>, key: serde_json::Value) -> usize {
    list.iter()
        .position(|value| *value == key)
        .unwrap_or_else(|| {
            list.push(key);
            list.len() - 1
        })
}

fn render_gauge(builder: &mut ListBuilder, ctx: &Ctx<'_>) {
    let [px, py, pw, ph] = ctx.plot;
    let center = (px + pw * 0.5, py + ph * 0.5);
    let radius = (pw.min(ph) * 0.5 - 8.0).max(1.0);
    // Arc band: outer arc forward + inner arc backward, closed once — a
    // single simple polygon, correct under the nonzero fill rule.
    let segments = (RING_SEGMENTS as f64 * GAUGE_SWEEP_DEG / 360.0) as usize;
    let mut band = arc_points(center, radius, GAUGE_START_DEG, GAUGE_SWEEP_DEG, segments);
    band.extend(arc_points(
        center,
        radius * GAUGE_INNER_RATIO,
        GAUGE_START_DEG + GAUGE_SWEEP_DEG,
        -GAUGE_SWEEP_DEG,
        segments,
    ));
    builder.fill(&band, GAUGE_COLOR);

    let (Some(min), Some(max)) = (ctx.series.min, ctx.series.max) else {
        return;
    };
    if !(min.is_finite() && max.is_finite() && max > min) {
        return;
    }
    let Some(value_col) = dim(ctx.dataset, &ctx.series.value) else {
        return;
    };
    let rows = &ctx.dataset.rows;
    let Some(value) = rows.iter().find_map(|row| finite_value(row, value_col)) else {
        return;
    };
    // Needle from center to the value angle; without rows there is no needle.
    let t = ((value - min) / (max - min)).clamp(0.0, 1.0);
    let angle = (GAUGE_START_DEG + GAUGE_SWEEP_DEG * t).to_radians();
    let (dx, dy) = (angle.cos(), angle.sin());
    let tip = (
        center.0 + NEEDLE_LENGTH_RATIO * radius * dx,
        center.1 + NEEDLE_LENGTH_RATIO * radius * dy,
    );
    builder.stroke(&[center, tip], NEEDLE_COLOR);
}

#[path = "render_frame.rs"]
mod frame;
pub(super) use frame::render_chart_with_points;
pub use frame::{render_chart, render_chart_with_hidden_series, render_chart_with_windows};

#[path = "render_heatmap.rs"]
mod heatmap;
use heatmap::render_heatmap;
