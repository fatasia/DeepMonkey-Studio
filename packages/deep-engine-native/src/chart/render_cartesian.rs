//! Cartesian source rows to pixel coordinates and bar dimensions.
use super::domain::{numeric_mapper, resolve_domain, zoom_domain};
use super::{
    ChartAxis, ChartDataset, ChartIR, ChartScale, ChartSeries, ChartSeriesType, axis_of, dataset,
    dim, finite_value,
};
use crate::chart::scales::category_scale;
/// Resolves a cartesian series into pixel points plus bar layout facts
/// Pixel-space series points plus bar layout facts (band width, baseline
/// pixel y).
pub(in crate::chart) struct CartesianPoints {
    pub(in crate::chart) points: Vec<(f64, f64)>,
    pub(in crate::chart) data_indices: Vec<usize>,
    pub(super) band: f64,
    pub(super) baseline: f64,
    /// 屏幕 x → 数据坐标反解,分支与下方 x 映射严格一一对应。
    pub(in crate::chart) invert_x: XInverter,
}

/// X 轴反解器。分支必须与 `x_projector` 的正向映射同源维护:
/// 正向改了分母/偏移而这里不改,axis tooltip 就会显示错值。
#[derive(Clone)]
pub(in crate::chart) struct XInverter(XInvertKind);

#[derive(Clone)]
enum XInvertKind {
    /// 数值/时间/对数轴:zoom 后连续域上的线性(或 log 线性)反插值。
    /// 连续轴允许域外外插,与正向 scale 不 clamp 的约定一致。
    Value {
        domain: (f64, f64),
        px: f64,
        pw: f64,
        log: bool,
    },
    /// 类目轴(无窗):行带中心映射 band = pw/count 的反解。
    RowBanded { count: f64, px: f64, pw: f64 },
    /// 类目轴(有窗):窗口平移后的行带反解。
    RowWindowed {
        first: f64,
        span: f64,
        px: f64,
        pw: f64,
    },
}

impl XInverter {
    /// 返回 `None`:非有限输入、连续轴退化域(正向已不可逆)、
    /// 类目轴光标在 plot 外(离散域之外没有类目)。
    /// 类目轴返回实数行位(可为 -0.5..count-0.5 的半带值),取整归行由调用方负责。
    pub(in crate::chart) fn invert(&self, x: f64) -> Option<f64> {
        if !x.is_finite() {
            return None;
        }
        match &self.0 {
            XInvertKind::Value {
                domain,
                px,
                pw,
                log,
            } => {
                if !px.is_finite() || *pw <= 0.0 || domain.0 >= domain.1 {
                    return None;
                }
                let t = (x - px) / pw;
                let value = if *log {
                    let (lo, hi) = (domain.0.log10(), domain.1.log10());
                    10f64.powf(lo * (1.0 - t) + hi * t)
                } else {
                    domain.0 + t * (domain.1 - domain.0)
                };
                value.is_finite().then_some(value)
            }
            XInvertKind::RowBanded { count, px, pw } => {
                if x < *px || x > px + pw || *pw <= 0.0 || *count <= 0.0 {
                    return None;
                }
                Some((x - px) / pw * count - 0.5)
            }
            XInvertKind::RowWindowed {
                first,
                span,
                px,
                pw,
            } => {
                if x < *px || x > px + pw || *pw <= 0.0 || *span <= 0.0 {
                    return None;
                }
                Some((x - px) / pw * span + first - 0.5)
            }
        }
    }
}

/// (band width, baseline pixel). Returns `None` when the series has no usable
/// data (caller skips it). X mode is numeric per axis scale, or category
/// banding by row index when the column is not uniformly numeric.
#[cfg(test)]
pub(in crate::chart) fn map_cartesian(
    ir: &ChartIR,
    series: &ChartSeries,
    dataset: &ChartDataset,
    plot: [f64; 4],
    windows: &[(String, f64, f64)],
) -> Option<CartesianPoints> {
    map_cartesian_cached(
        &mut super::FrameAxisValues::new(ir),
        series,
        dataset,
        plot,
        windows,
    )
}

pub(super) fn map_cartesian_cached(
    shared: &mut super::FrameAxisValues<'_>,
    series: &ChartSeries,
    dataset: &ChartDataset,
    plot: [f64; 4],
    windows: &[(String, f64, f64)],
) -> Option<CartesianPoints> {
    let ir = shared.source;
    let (x_col, y_col) = (dim(dataset, &series.x)?, dim(dataset, &series.y)?);
    let numeric = |column: usize| -> Vec<Option<f64>> {
        dataset
            .rows
            .iter()
            .map(|row| finite_value(row, column))
            .collect()
    };
    let (ys, xs) = (numeric(y_col), numeric(x_col));
    let (x_axis, y_axis) = (
        axis_of(ir, series.x_axis_id.as_ref()),
        axis_of(ir, series.y_axis_id.as_ref()),
    );
    let log_x = x_axis.is_some_and(|axis| axis.scale == ChartScale::Log);
    let log_y = y_axis.is_some_and(|axis| axis.scale == ChartScale::Log);
    let category_x = x_axis.is_some_and(|axis| axis.scale == ChartScale::Category);

    // x/y stay paired: rows without a finite y drop entirely.
    let numeric_ok = !category_x
        && ys.iter().enumerate().all(|(row, y)| match y {
            Some(_) => {
                matches!(xs.get(row), Some(Some(x)) if x.is_finite() && (!log_x || *x > 0.0))
            }
            None => true,
        });
    let mut kept: Vec<(usize, Option<f64>, f64)> = Vec::new();
    for (row, y) in ys.iter().enumerate() {
        let x = numeric_ok.then(|| xs.get(row).copied().flatten()).flatten();
        if let Some(y) = y {
            if log_y && *y <= 0.0 {
                continue;
            }
            kept.push((row, x, *y));
        }
    }
    let [px, py, pw, ph] = plot;
    // Automatic bar bounds include the zero baseline; explicit axis bounds still win.
    let shared_y = shared.get(series, false);
    let has_bar = ir
        .series
        .iter()
        .any(|peer| peer.y_axis_id == series.y_axis_id && peer.series_type == ChartSeriesType::Bar);
    let zero = (has_bar && !log_y && !shared_y.is_empty()).then_some(0.0);
    let y_domain = resolve_domain(y_axis, shared_y.iter().copied().chain(zero))?;
    let y_map = numeric_mapper(
        y_axis,
        zoom_domain(y_axis, y_domain, windows)?,
        (py + ph, py),
    )?;

    // Category/fallback row bands never consume numeric X values.
    let shared_x = numeric_ok.then(|| shared.get(series, true));
    let (x_mapper, invert_x) = x_projector(
        x_axis,
        dataset.rows.len(),
        (px, px + pw),
        numeric_ok,
        windows,
        shared_x.as_deref().unwrap_or_default().iter().copied(),
    )?;

    let points = kept
        .iter()
        .map(|&(row, x, y)| (x_mapper(row, x.unwrap_or(f64::NAN)), y_map(y)))
        .collect();
    // Bars grow from the pixel of value 0 (clamped into the plot when the
    // domain excludes zero, e.g. axis min > 0).
    let baseline = y_map(0.0).clamp(py, py + ph);
    Some(CartesianPoints {
        points,
        data_indices: kept.iter().map(|point| point.0).collect(),
        band: pw
            / dataset.rows.len().max(1) as f64
            / x_axis
                .and_then(|axis| windows.iter().find(|(id, _, _)| *id == axis.id))
                .map_or(1.0, |(_, start, end)| end - start),
        baseline,
        invert_x,
    })
}

/// Series bound to the same numeric axis share one data domain.
pub(in crate::chart) fn shared_axis_values(
    ir: &ChartIR,
    current: &ChartSeries,
    horizontal: bool,
) -> Vec<f64> {
    let mut values = Vec::new();
    for peer in &ir.series {
        if !matches!(
            peer.series_type,
            ChartSeriesType::Line | ChartSeriesType::Bar | ChartSeriesType::Scatter
        ) || (if horizontal {
            &peer.x_axis_id
        } else {
            &peer.y_axis_id
        }) != (if horizontal {
            &current.x_axis_id
        } else {
            &current.y_axis_id
        }) {
            continue;
        }
        let Some(dataset) = ir.datasets.iter().find(|data| data.id == peer.dataset_id) else {
            continue;
        };
        let Some(y_col) = dim(dataset, &peer.y) else {
            continue;
        };
        let column = if horizontal {
            dim(dataset, &peer.x)
        } else {
            Some(y_col)
        };
        let Some(column) = column else { continue };
        let log_y =
            axis_of(ir, peer.y_axis_id.as_ref()).is_some_and(|axis| axis.scale == ChartScale::Log);
        let log_x = horizontal
            && axis_of(ir, peer.x_axis_id.as_ref())
                .is_some_and(|axis| axis.scale == ChartScale::Log);
        for row in dataset.rows.iter() {
            let Some(y) = finite_value(row, y_col) else {
                continue;
            };
            if log_y && y <= 0.0 {
                continue;
            }
            if let Some(value) = finite_value(row, column)
                && (!log_x || value > 0.0)
            {
                values.push(value);
            }
        }
    }
    values
}

/// X 轴的正向映射与反解器成对产出:数值/时间/对数轴走连续域插值,
/// 类目轴或非数值列走行带映射。反解器语义见 `XInverter::invert`。
#[allow(clippy::type_complexity)]
fn x_projector(
    x_axis: Option<&ChartAxis>,
    row_count: usize,
    x_range: (f64, f64),
    numeric_ok: bool,
    windows: &[(String, f64, f64)],
    kept_x: impl Iterator<Item = f64>,
) -> Option<(Box<dyn Fn(usize, f64) -> f64>, XInverter)> {
    let (px, pw) = (x_range.0, x_range.1 - x_range.0);
    if numeric_ok {
        let domain = resolve_domain(x_axis, kept_x)?;
        let zoomed = zoom_domain(x_axis, domain, windows)?;
        let mapper = numeric_mapper(x_axis, zoomed, x_range)?;
        let log = x_axis.is_some_and(|axis| axis.scale == ChartScale::Log);
        let invert_x = XInverter(XInvertKind::Value {
            domain: zoomed,
            px,
            pw,
            log,
        });
        return Some((Box::new(move |_, x| mapper(x)), invert_x));
    }
    let count = row_count.max(1) as f64;
    let window = x_axis.and_then(|axis| windows.iter().find(|(id, _, _)| *id == axis.id));
    let mapper: Box<dyn Fn(usize, f64) -> f64> = match window {
        Some(&(_, start, end)) => {
            let (first, span) = (start * count, (end - start) * count);
            Box::new(move |row, _| px + (row as f64 + 0.5 - first) / span * pw)
        }
        None => {
            let category = category_scale(row_count.max(1), x_range);
            Box::new(move |row, _| category(row))
        }
    };
    let invert_x = match window {
        Some(&(_, start, end)) => XInverter(XInvertKind::RowWindowed {
            first: start * count,
            span: (end - start) * count,
            px,
            pw,
        }),
        None => XInverter(XInvertKind::RowBanded { count, px, pw }),
    };
    Some((mapper, invert_x))
}

/// Axis presentation facts shared with the presenter-layer axis renderer
/// (`axis_render.rs`). Derived from the exact same inputs as
/// `map_cartesian` — same `shared_axis_values`, same `resolve_domain`,
/// same zoom windows — so ticks can never disagree with drawn geometry.
pub(in crate::chart) struct AxisView {
    /// Zoomed numeric domain; `None` for category presentation.
    pub(in crate::chart) numeric: Option<(f64, f64)>,
    pub(in crate::chart) log: bool,
    pub(in crate::chart) row_bands: Option<RowBands>,
}

pub(in crate::chart) struct RowBands {
    pub(in crate::chart) count: usize,
    /// Zoom window in row units: (first row, row span).
    pub(in crate::chart) window: Option<(f64, f64)>,
}

/// Resolves how one axis presents ticks, anchored to the first cartesian
/// series bound to it (its dataset decides numeric vs row-banded, matching
/// that series' `map_cartesian` branch). `None` when nothing binds the axis
/// or the numeric domain is unusable (empty/non-finite data, Y category).
pub(in crate::chart) fn axis_presentation(
    ir: &ChartIR,
    axis: &ChartAxis,
    hidden_series: &[String],
    windows: &[(String, f64, f64)],
) -> Option<AxisView> {
    let series = ir.series.iter().find(|series| {
        !hidden_series.contains(&series.id)
            && matches!(
                series.series_type,
                ChartSeriesType::Line | ChartSeriesType::Bar | ChartSeriesType::Scatter
            )
            && (series.x_axis_id.as_ref() == Some(&axis.id)
                || series.y_axis_id.as_ref() == Some(&axis.id))
    })?;
    let dataset = dataset(ir, &series.dataset_id)?;
    let horizontal = series.y_axis_id.as_ref() != Some(&axis.id);
    let window = windows
        .iter()
        .find(|(id, _, _)| *id == axis.id)
        .map(|&(_, start, end)| (start, end));
    let log = axis.scale == ChartScale::Log;
    if !horizontal {
        // Y axes are numeric-only (map_cartesian maps finite y values).
        let shared = shared_axis_values(ir, series, false);
        let has_bar = ir.series.iter().any(|peer| {
            peer.y_axis_id == series.y_axis_id && peer.series_type == ChartSeriesType::Bar
        });
        let zero = (has_bar && !log && !shared.is_empty()).then_some(0.0);
        let domain = resolve_domain(Some(axis), shared.into_iter().chain(zero))?;
        return Some(AxisView {
            numeric: Some(zoom_domain(Some(axis), domain, windows)?),
            log,
            row_bands: None,
        });
    }
    let category = axis.scale == ChartScale::Category;
    let (x_col, y_col) = (dim(dataset, &series.x)?, dim(dataset, &series.y)?);
    // Numeric-column test mirrors `map_cartesian::numeric_ok`: every row with
    // a finite y must carry a finite x (positive on log axes).
    let numeric_ok = !category && dataset.rows.iter().all(|values| {
        match finite_value(values, y_col) {
            None => true,
            Some(_) => {
                matches!(finite_value(values, x_col), Some(x) if x.is_finite() && (!log || x > 0.0))
            }
        }
    });
    if numeric_ok {
        let domain = resolve_domain(Some(axis), shared_axis_values(ir, series, true).into_iter())?;
        Some(AxisView {
            numeric: Some(zoom_domain(Some(axis), domain, windows)?),
            log,
            row_bands: None,
        })
    } else {
        let count = dataset.rows.len();
        let window =
            window.map(|(start, end)| (start * count as f64, (end - start) * count as f64));
        Some(AxisView {
            numeric: None,
            log,
            row_bands: Some(RowBands { count, window }),
        })
    }
}

/// Domain-mapping forwarder for the axis renderer: same `numeric_mapper`
/// the geometry pass uses, re-exported past the render module boundary.
pub(in crate::chart) fn numeric_mapper_for(
    axis: &ChartAxis,
    domain: Option<(f64, f64)>,
    range: (f64, f64),
) -> Option<Box<dyn Fn(f64) -> f64>> {
    numeric_mapper(Some(axis), domain?, range)
}
