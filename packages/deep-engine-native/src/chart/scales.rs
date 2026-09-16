//! Chart scales (C02): pure value→pixel mappings shared by the chart
//! renderer. Every mapping is a *total* function: degenerate domains collapse
//! to the range midpoint instead of producing NaN, because every number that
//! leaves this module is eventually written into a Deep2d display list whose
//! validator rejects non-finite values and |v| > 16_777_216.
//!
//! Scales deliberately do NOT clamp their output: they are math primitives,
//! coordinate clamping into the canvas is the renderer's job (`render.rs`).

/// Midpoint of `range`; falls back to 0.0 when the range itself is not finite
/// (fail-closed: never let NaN escape into the display list).
fn range_midpoint(range: (f64, f64)) -> f64 {
    if range.0.is_finite() && range.1.is_finite() {
        (range.0 + range.1) * 0.5
    } else {
        0.0
    }
}

fn ordered(domain: (f64, f64)) -> (f64, f64) {
    if domain.0 <= domain.1 {
        domain
    } else {
        (domain.1, domain.0)
    }
}

/// Core linear interpolation with fail-closed degeneracy handling:
/// zero-span or non-finite domain, or non-finite `value`, all map to the
/// range midpoint. Reversed ranges/domains interpolate naturally.
fn map_linear(domain: (f64, f64), range: (f64, f64), value: f64) -> f64 {
    let usable = domain.0.is_finite()
        && domain.1.is_finite()
        && range.0.is_finite()
        && range.1.is_finite()
        && domain.0 != domain.1;
    if !usable || !value.is_finite() {
        return range_midpoint(range);
    }
    let t = (value - domain.0) / (domain.1 - domain.0);
    range.0 + t * (range.1 - range.0)
}

/// Linear numeric scale, e.g. data domain `(0, 100)` onto pixel range
/// `(0, 480)`. Zero-span domains return the range midpoint for every input.
pub fn linear_scale(domain: (f64, f64), range: (f64, f64)) -> impl Fn(f64) -> f64 {
    move |value| map_linear(domain, range, value)
}

/// Time scale: epoch milliseconds → pixels. Time axes are linear on the
/// millisecond value; kept as a distinct constructor so call sites stay
/// self-documenting and a future calendar-aware implementation can slot in.
pub fn time_scale(domain: (f64, f64), range: (f64, f64)) -> impl Fn(f64) -> f64 {
    move |value| map_linear(domain, range, value)
}

/// Log10 scale. Fail-closed on construction: the domain must be finite and
/// strictly positive (log(0) / log(negative) are undefined), otherwise `Err`.
/// Domain endpoints may be given in either order. Inputs ≤ 0 or non-finite
/// passed to the returned closure are clamped to the domain minimum so the
/// mapping stays total.
pub fn log_scale(domain: (f64, f64), range: (f64, f64)) -> Result<impl Fn(f64) -> f64, String> {
    let (d0, d1) = domain;
    if !d0.is_finite() || !d1.is_finite() {
        return Err(format!(
            "log scale requires a finite domain, got ({d0}, {d1})."
        ));
    }
    if d0 <= 0.0 || d1 <= 0.0 {
        return Err(format!(
            "log scale requires a strictly positive domain, got ({d0}, {d1}); filter or clamp non-positive values before mapping."
        ));
    }
    let (lo, hi) = ordered(domain);
    let lo_log = lo.log10();
    let hi_log = hi.log10();
    Ok(move |value: f64| {
        if !range.0.is_finite() || !range.1.is_finite() {
            return range_midpoint(range);
        }
        if lo_log == hi_log {
            // Zero-span (positive) domain: constant midpoint, never 0/0.
            return range_midpoint(range);
        }
        let clamped = if value.is_finite() && value > 0.0 {
            value
        } else {
            lo
        };
        let t = (clamped.log10() - lo_log) / (hi_log - lo_log);
        range.0 + t * (range.1 - range.0)
    })
}

/// Category scale: `count` equal bands across `range`, index → band center.
/// Out-of-range indices are clamped into the last band (fail-closed: callers
/// stay total without panicking). `count == 0` maps everything to the midpoint.
pub fn category_scale(count: usize, range: (f64, f64)) -> impl Fn(usize) -> f64 {
    move |index| {
        if count == 0 || !range.0.is_finite() || !range.1.is_finite() {
            return range_midpoint(range);
        }
        let band = (range.1 - range.0) / count as f64;
        let clamped = (index.min(count - 1)) as f64;
        range.0 + band * (clamped + 0.5)
    }
}

/// Nice ticks on 1/2/5 × 10^k steps. Zero-span domains return the single
/// domain point; non-finite domains, `max_ticks == 0`, spans that overflow to
/// infinity (e.g. ±1e308) and steps that underflow to zero (e.g. 1e-320 span)
/// all fail closed to an empty vector.
pub fn ticks_linear(domain: (f64, f64), max_ticks: usize) -> Vec<f64> {
    let (d0, d1) = domain;
    if max_ticks == 0 || !d0.is_finite() || !d1.is_finite() {
        return Vec::new();
    }
    let (lo, hi) = ordered(domain);
    let span = hi - lo;
    if span == 0.0 {
        return vec![lo];
    }
    if span < 0.0 || !span.is_finite() {
        return Vec::new();
    }
    let raw_step = span / max_ticks as f64;
    // NaN-safe: `!(x > 0)` 与 `x <= 0` 对 NaN 同为真,clippy 偏好后者。
    if raw_step <= 0.0 || !raw_step.is_finite() {
        return Vec::new();
    }
    let magnitude = 10f64.powi(raw_step.log10().floor() as i32);
    if !magnitude.is_finite() || magnitude <= 0.0 {
        return Vec::new();
    }
    let normalized = raw_step / magnitude;
    let step = magnitude
        * if normalized < 1.5 {
            1.0
        } else if normalized < 3.5 {
            2.0
        } else if normalized < 7.5 {
            5.0
        } else {
            10.0
        };
    let mut ticks = Vec::new();
    let mut value = (lo / step).ceil() * step;
    // Hard iteration cap: float rounding must never be able to hang a frame.
    for _ in 0..=(max_ticks * 4).max(16) {
        if value > hi + step * 1e-9 {
            break;
        }
        if value >= lo - step * 1e-9 {
            ticks.push(value);
        }
        value += step;
        if !value.is_finite() {
            break;
        }
    }
    ticks
}

/// Log ticks: the 10^k powers inside the domain, thinned by a constant
/// integer stride when they exceed `max_ticks`. Non-positive or non-finite
/// domains fail closed to an empty vector (log of such domains is undefined).
pub fn ticks_log(domain: (f64, f64), max_ticks: usize) -> Vec<f64> {
    let (d0, d1) = domain;
    if max_ticks == 0 || !d0.is_finite() || !d1.is_finite() || d0 <= 0.0 || d1 <= 0.0 {
        return Vec::new();
    }
    let (lo, hi) = ordered(domain);
    // 1e-9 in log space absorbs libm rounding dust (log10(0.1) must yield
    // exponent -1, not -1+ε); candidates are filtered back to the exact
    // domain afterwards so no out-of-domain tick can leak.
    let first = (lo.log10() - 1e-9).ceil();
    let last = (hi.log10() + 1e-9).floor();
    if last < first {
        return Vec::new();
    }
    let needed = (last - first) as usize + 1;
    let stride = needed.div_ceil(max_ticks).max(1) as i32;
    let mut ticks = Vec::new();
    let mut exponent = first as i32;
    let last_exponent = last as i32;
    while exponent <= last_exponent {
        let tick = 10f64.powi(exponent);
        if !tick.is_finite() {
            break;
        }
        if tick >= lo && tick <= hi {
            ticks.push(tick);
        }
        exponent += stride;
    }
    ticks
}
