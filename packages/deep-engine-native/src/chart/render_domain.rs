//! Cartesian domain resolution keeps each authored bound and axis scale.
use super::{ChartAxis, ChartScale};
use crate::chart::scales::{linear_scale, log_scale};

pub(super) fn resolve_domain(
    axis: Option<&ChartAxis>,
    values: impl Iterator<Item = f64>,
) -> Option<(f64, f64)> {
    let logarithmic = axis.is_some_and(|axis| axis.scale == ChartScale::Log);
    let (lo, hi) = values
        .filter(|value| value.is_finite() && (!logarithmic || *value > 0.0))
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), value| {
            (lo.min(value), hi.max(value))
        });
    let min = axis.and_then(|axis| axis.min).unwrap_or(lo);
    let max = axis.and_then(|axis| axis.max).unwrap_or(hi);
    (min.is_finite() && max.is_finite() && min <= max && (!logarithmic || min > 0.0 && max > 0.0))
        .then_some((min, max))
}

pub(super) fn numeric_mapper(
    axis: Option<&ChartAxis>,
    domain: (f64, f64),
    range: (f64, f64),
) -> Option<Box<dyn Fn(f64) -> f64>> {
    if axis.is_some_and(|axis| axis.scale == ChartScale::Log) {
        Some(Box::new(log_scale(domain, range).ok()?))
    } else {
        Some(Box::new(linear_scale(domain, range)))
    }
}

pub(super) fn zoom_domain(
    axis: Option<&ChartAxis>,
    domain: (f64, f64),
    windows: &[(String, f64, f64)],
) -> Option<(f64, f64)> {
    let Some((_, start, end)) =
        axis.and_then(|axis| windows.iter().find(|(id, _, _)| *id == axis.id))
    else {
        return Some(domain);
    };
    let log = axis.is_some_and(|axis| axis.scale == ChartScale::Log);
    let (lo, hi) = if log {
        (domain.0.log10(), domain.1.log10())
    } else {
        domain
    };
    let interpolate = |t: f64| {
        let value = lo * (1.0 - t) + hi * t;
        if log { 10.0_f64.powf(value) } else { value }
    };
    let result = (interpolate(*start), interpolate(*end));
    (result.0.is_finite() && result.1.is_finite() && result.0 <= result.1).then_some(result)
}
