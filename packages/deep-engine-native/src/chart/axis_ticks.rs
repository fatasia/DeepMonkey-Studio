//! Axis tick derivation: deterministic tick values, category labels and
//! pixel anchors, reusing the exact scale inputs of the geometry pass.
//!
//! Contract decisions:
//! - Tick values come from `ticks_linear`/`ticks_log` on the zoomed domain
//!   that `axis_presentation` derives with the same inputs as
//!   `map_cartesian`, so a tick can never disagree with drawn geometry.
//! - Category labels come verbatim from the ChartIR row cell; null/boolean
//!   rows have no label semantics and are skipped, never invented. Rows
//!   thinned by stride or mapped outside the plot range get no label.

use super::{
    ChartAxis, ChartScale,
    render::{RowBands, axis_presentation},
    scales::{ticks_linear, ticks_log},
};

/// Ticks per numeric axis; category axes thin by stride instead.
const MAX_NUMERIC_TICKS: usize = 8;
const MAX_CATEGORY_LABELS: usize = 12;

pub(super) struct TickLabel {
    /// Anchor pixel on the axis line.
    pub(super) position: f64,
    pub(super) text: String,
}

/// Shortest stable decimal form; kills float dust from 1/2/5-step ticks
/// (`(lo / step).ceil() * step` can land on 0.30000000000000004).
pub(super) fn fmt_tick(value: f64) -> String {
    if !value.is_finite() {
        return String::new();
    }
    if (value - value.round()).abs() < 1e-9 && value.abs() < 1e15 {
        return format!("{}", value.round() as i64);
    }
    let cleaned = (value * 1e12).round();
    if cleaned.is_finite() && (cleaned / 1e12).abs() < 1e6 {
        format!("{}", cleaned / 1e12)
    } else {
        format!("{value}")
    }
}

/// Category labels come verbatim from the ChartIR row cell; null/boolean
/// rows have no label semantics and are skipped, never invented.
fn row_label(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => (!text.trim().is_empty()).then(|| text.clone()),
        serde_json::Value::Number(number) => number.as_f64().map(fmt_tick),
        _ => None,
    }
}

/// Category tick labels read the x column of the first visible series bound
/// to the axis — the same dataset/row banding its geometry uses.
fn category_labels(
    source: &super::ChartIR,
    axis: &ChartAxis,
    hidden: &[String],
    bands: &RowBands,
    range: (f64, f64),
) -> Vec<TickLabel> {
    let bound = source
        .series
        .iter()
        .find(|series| !hidden.contains(&series.id) && series.x_axis_id.as_ref() == Some(&axis.id));
    let column = bound.and_then(|series| {
        source
            .datasets
            .iter()
            .find(|data| data.id == series.dataset_id)
            .and_then(|data| {
                data.dimensions
                    .iter()
                    .position(|dimension| series.x.as_deref() == Some(dimension.as_str()))
            })
    });
    let rows = bound.and_then(|series| {
        source
            .datasets
            .iter()
            .find(|data| data.id == series.dataset_id)
            .map(|data| &data.rows)
    });
    let stride = bands.count.div_ceil(MAX_CATEGORY_LABELS).max(1);
    (0..bands.count)
        .step_by(stride)
        .filter_map(|row| {
            let text = rows
                .and_then(|rows| rows.get(row))
                .and_then(|values| values.get(column?))
                .and_then(row_label)?;
            let position = row_band_pixel(bands, row, range)?;
            Some(TickLabel { position, text })
        })
        .collect()
}

fn row_band_pixel(bands: &RowBands, row: usize, range: (f64, f64)) -> Option<f64> {
    let (px, pw) = (range.0, range.1 - range.0);
    if bands.count == 0 || pw <= 0.0 || !pw.is_finite() {
        return None;
    }
    let center = row as f64 + 0.5;
    let pixel = match &bands.window {
        Some((first, span)) if *span > 0.0 => px + (center - first) / span * pw,
        Some(_) => return None,
        None => px + center / bands.count as f64 * pw,
    };
    // Zoomed-out rows map outside the plot and get no label. Y ranges run
    // bottom-up, so test against the normalized extent.
    let (lo, hi) = (range.0.min(range.1), range.0.max(range.1));
    (pixel.is_finite() && pixel >= lo - 0.5 && pixel <= hi + 0.5).then_some(pixel)
}

/// Ticks (position + label text) for one axis over its plot `range`.
/// Returns an empty vector when nothing binds the axis or the numeric
/// domain is unusable; callers keep drawing the bare axis line.
pub(super) fn ticks_for_axis(
    source: &super::ChartIR,
    axis: &ChartAxis,
    hidden: &[String],
    windows: &[(String, f64, f64)],
    range: (f64, f64),
) -> Vec<TickLabel> {
    let Some(view) = axis_presentation(source, axis, hidden, windows) else {
        return Vec::new();
    };
    let (lo, hi) = (range.0.min(range.1), range.0.max(range.1));
    let inside =
        |position: f64| position.is_finite() && position >= lo - 0.5 && position <= hi + 0.5;
    if let Some(bands) = &view.row_bands {
        return category_labels(source, axis, hidden, bands, range);
    }
    let Some(domain) = view.numeric else {
        return Vec::new();
    };
    let Some(mapper) = super::render::numeric_mapper_for(axis, view.numeric, range) else {
        return Vec::new();
    };
    let raw = if view.log {
        ticks_log(domain, MAX_NUMERIC_TICKS)
    } else if axis.scale == ChartScale::Time {
        // Time axes interpolate linearly on epoch millis; labels stay the
        // deterministic numeric form until a calendar formatter lands.
        ticks_linear(domain, MAX_NUMERIC_TICKS)
    } else {
        ticks_linear(domain, MAX_NUMERIC_TICKS)
    };
    raw.into_iter()
        .filter_map(|value| {
            let text = fmt_tick(value);
            (!text.is_empty()).then_some(())?;
            let position = mapper(value);
            inside(position).then_some(TickLabel { position, text })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::fmt_tick;

    #[test]
    fn tick_formatting_is_deterministic_and_dust_free() {
        assert_eq!(fmt_tick(37.0), "37");
        assert_eq!(fmt_tick(0.30000000000000004), "0.3");
        assert_eq!(fmt_tick(1.5), "1.5");
        assert_eq!(fmt_tick(-0.25), "-0.25");
        assert_eq!(fmt_tick(f64::NAN), "");
        assert_eq!(fmt_tick(f64::INFINITY), "");
    }
}
