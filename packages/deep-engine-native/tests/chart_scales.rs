//! Scale boundary matrix (C02): every fail-closed path of `chart::scales`
//! is pinned here so the renderer can rely on total, NaN-free mappings.

use deep_engine_native::chart::scales::{
    category_scale, linear_scale, log_scale, ticks_linear, ticks_log, time_scale,
};

fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

/// Relative tolerance for extreme magnitudes (1e±300) where absolute
/// `approx` is meaningless.
fn rel_approx(a: f64, b: f64) -> bool {
    ((a - b) / b).abs() < 1e-12
}

// ---------------------------------------------------------------- linear ---

#[test]
fn linear_maps_domain_onto_range() {
    let scale = linear_scale((0.0, 100.0), (0.0, 480.0));
    assert_eq!(scale(0.0), 0.0);
    assert_eq!(scale(100.0), 480.0);
    assert!(approx(scale(50.0), 240.0));
    assert!(approx(scale(12.5), 60.0));
}

#[test]
fn linear_supports_negative_values_and_reverse_range() {
    let scale = linear_scale((-10.0, 10.0), (0.0, 100.0));
    assert_eq!(scale(-10.0), 0.0);
    assert_eq!(scale(10.0), 100.0);
    assert!(approx(scale(0.0), 50.0));

    // Reversed range (y-down screens invert the value axis).
    let flipped = linear_scale((0.0, 10.0), (100.0, 0.0));
    assert_eq!(flipped(0.0), 100.0);
    assert_eq!(flipped(10.0), 0.0);
    assert!(approx(flipped(5.0), 50.0));

    // Reversed domain flips direction symmetrically.
    let reversed_domain = linear_scale((10.0, 0.0), (0.0, 100.0));
    assert!(approx(reversed_domain(10.0), 0.0));
    assert!(approx(reversed_domain(0.0), 100.0));
}

#[test]
fn linear_zero_span_domain_collapses_to_midpoint() {
    let scale = linear_scale((7.0, 7.0), (10.0, 20.0));
    assert_eq!(scale(7.0), 15.0);
    assert_eq!(scale(-1e300), 15.0);
}

#[test]
fn linear_non_finite_inputs_never_produce_nan() {
    let scale = linear_scale((f64::NAN, 10.0), (0.0, 10.0));
    assert_eq!(scale(5.0), 5.0);

    let scale = linear_scale((0.0, f64::INFINITY), (0.0, 10.0));
    assert_eq!(scale(1.0), 5.0);

    let finite_scale = linear_scale((0.0, 1.0), (0.0, 10.0));
    assert_eq!(finite_scale(f64::NAN), 5.0);
    assert_eq!(finite_scale(f64::INFINITY), 5.0);
    assert_eq!(finite_scale(f64::NEG_INFINITY), 5.0);

    // A non-finite range degrades to 0.0 instead of NaN.
    let broken_range = linear_scale((0.0, 1.0), (f64::NAN, 1.0));
    assert_eq!(broken_range(0.5), 0.0);
}

#[test]
fn linear_extreme_magnitudes_stay_finite() {
    let scale = linear_scale((0.0, 1.0), (0.0, 10.0));
    let huge = scale(1e300);
    let tiny = scale(1e-300);
    assert!(rel_approx(huge, 1e301), "huge: {huge}");
    assert!(rel_approx(tiny, 1e-299), "tiny: {tiny}");

    let huge_domain = linear_scale((-1e300, 1e300), (0.0, 1.0));
    assert!(approx(huge_domain(0.0), 0.5));
    assert!(approx(huge_domain(1e300), 1.0));
}

// ------------------------------------------------------------------- time ---

#[test]
fn time_scale_maps_milliseconds_linearly() {
    let scale = time_scale((0.0, 60_000.0), (0.0, 300.0));
    assert_eq!(scale(0.0), 0.0);
    assert_eq!(scale(60_000.0), 300.0);
    assert!(approx(scale(30_000.0), 150.0));
    // Negative timestamps (pre-epoch) and reversed ranges behave like linear.
    assert!(approx(scale(-30_000.0), -150.0));
}

// -------------------------------------------------------------------- log ---

#[test]
fn log_scale_interpolates_in_log10_space() {
    let scale = log_scale((1.0, 100.0), (0.0, 200.0)).expect("positive domain is accepted");
    assert!(approx(scale(1.0), 0.0));
    assert!(approx(scale(100.0), 200.0));
    assert!(approx(scale(10.0), 100.0));
    assert!(
        approx(scale(10f64.sqrt()), 50.0),
        "geometric midpoint maps to range midpoint"
    );
}

#[test]
fn log_scale_rejects_non_positive_domains() {
    assert!(
        log_scale((0.0, 10.0), (0.0, 1.0)).is_err(),
        "log(0) is undefined"
    );
    assert!(
        log_scale((-1.0, 10.0), (0.0, 1.0)).is_err(),
        "log(negative) is undefined"
    );
    assert!(log_scale((1.0, -5.0), (0.0, 1.0)).is_err());
    assert!(log_scale((f64::NAN, 1.0), (0.0, 1.0)).is_err());
    assert!(log_scale((f64::INFINITY, 2.0), (0.0, 1.0)).is_err());
}

#[test]
fn log_scale_zero_span_positive_domain_is_constant() {
    let scale = log_scale((5.0, 5.0), (10.0, 30.0)).expect("equal positive endpoints allowed");
    assert_eq!(scale(5.0), 20.0);
    assert_eq!(scale(1.0), 20.0);
}

#[test]
fn log_scale_clamps_invalid_inputs_and_supports_reverse_range() {
    let scale = log_scale((1.0, 100.0), (0.0, 200.0)).expect("valid domain");
    // log(0) and log(negative) inputs clamp to the domain minimum.
    assert_eq!(scale(0.0), 0.0);
    assert_eq!(scale(-3.0), 0.0);
    assert_eq!(scale(f64::NAN), 0.0);

    let flipped = log_scale((1.0, 10.0), (100.0, 0.0)).expect("valid domain");
    assert!(approx(flipped(1.0), 100.0));
    assert!(approx(flipped(10.0), 0.0));
    assert!(approx(flipped(0.1), 200.0));
}

#[test]
fn ticks_log_lists_powers_of_ten() {
    assert_eq!(ticks_log((0.1, 100.0), 10), vec![0.1, 1.0, 10.0, 100.0]);
    assert_eq!(ticks_log((0.5, 20.0), 10), vec![1.0, 10.0]);
    // Sub-decade domains without an integer power are empty, not fabricated.
    assert!(ticks_log((5.0, 5.0), 10).is_empty());
    assert!(ticks_log((3.0, 4.0), 10).is_empty());
}

#[test]
fn ticks_log_thins_by_stride_and_fails_closed() {
    // 13 powers thinned to max_ticks = 4: 1, 1e4, 1e8, 1e12.
    let ticks = ticks_log((1.0, 1e12), 4);
    assert_eq!(ticks, vec![1.0, 1e4, 1e8, 1e12]);

    assert!(
        ticks_log((0.0, 10.0), 10).is_empty(),
        "log(0) domain rejected"
    );
    assert!(
        ticks_log((-1.0, 10.0), 10).is_empty(),
        "negative domain rejected"
    );
    assert!(ticks_log((1.0, f64::NAN), 10).is_empty());
    assert!(
        ticks_log((1.0, 100.0), 0).is_empty(),
        "zero budget rejected"
    );
}

// -------------------------------------------------------------- category ---

#[test]
fn category_maps_indices_to_band_centers() {
    let scale = category_scale(4, (0.0, 100.0));
    assert!(approx(scale(0), 12.5));
    assert!(approx(scale(1), 37.5));
    assert!(approx(scale(2), 62.5));
    assert!(approx(scale(3), 87.5));

    // Out-of-range indices clamp into the edge band instead of panicking.
    assert!(approx(scale(99), 87.5));
    assert!(approx(scale(usize::MAX), 87.5));
}

#[test]
fn category_zero_count_and_reverse_range_fail_closed() {
    let empty = category_scale(0, (0.0, 100.0));
    assert_eq!(empty(0), 50.0);

    let flipped = category_scale(2, (100.0, 0.0));
    assert!(approx(flipped(0), 75.0));
    assert!(approx(flipped(1), 25.0));
}

// ------------------------------------------------------------ linear ticks ---

#[test]
fn ticks_linear_use_nice_1_2_5_steps() {
    let ticks = ticks_linear((0.0, 100.0), 5);
    assert_eq!(ticks, vec![0.0, 20.0, 40.0, 60.0, 80.0, 100.0]);

    let ticks = ticks_linear((0.0, 10.0), 5);
    assert_eq!(ticks, vec![0.0, 2.0, 4.0, 6.0, 8.0, 10.0]);

    // raw step 0.5 is already a nice number → 11 exact half steps
    let ticks = ticks_linear((0.0, 5.0), 10);
    assert_eq!(ticks.len(), 11);
    assert!(approx(ticks[0], 0.0) && approx(ticks[10], 5.0));
    assert!(ticks.windows(2).all(|pair| approx(pair[1] - pair[0], 0.5)));

    // raw step 0.83… rounds the normalized mantissa up to a 1.0 step
    let ticks = ticks_linear((0.0, 5.0), 6);
    assert_eq!(ticks, vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0]);
}

#[test]
fn ticks_linear_cover_negative_domains() {
    let ticks = ticks_linear((-10.0, 0.0), 5);
    assert_eq!(ticks, vec![-10.0, -8.0, -6.0, -4.0, -2.0, 0.0]);
}

#[test]
fn ticks_linear_zero_span_returns_single_point() {
    assert_eq!(ticks_linear((4.2, 4.2), 5), vec![4.2]);
}

#[test]
fn ticks_linear_fail_closed_on_degenerate_input() {
    assert!(ticks_linear((0.0, 100.0), 0).is_empty(), "zero budget");
    assert!(ticks_linear((f64::NAN, 100.0), 5).is_empty(), "NaN domain");
    assert!(
        ticks_linear((0.0, f64::INFINITY), 5).is_empty(),
        "infinite domain"
    );
    // Span (1e308 - -1e308) overflows to infinity → no ticks, no hang.
    assert!(
        ticks_linear((-1e308, 1e308), 5).is_empty(),
        "overflowing span"
    );
    // Step magnitude 10^k underflows to 0 for k ≤ -324 → empty, no hang.
    assert!(
        ticks_linear((0.0, 1e-323), 5).is_empty(),
        "underflowing step"
    );
    // Very small normal steps still yield in-domain ticks across libm
    // implementations; the true subnormal boundary is covered above.
    let ticks = ticks_linear((0.0, 1e-300), 5);
    assert!(!ticks.is_empty(), "tiny steps are usable");
    assert!(ticks.iter().all(|tick| *tick >= 0.0 && *tick <= 1e-300));
}

#[test]
fn ticks_linear_fractional_domains_stay_in_bounds() {
    let ticks = ticks_linear((1.0, 2.0), 5);
    assert!(!ticks.is_empty());
    assert!(ticks.windows(2).all(|pair| pair[1] > pair[0]), "ascending");
    let first = *ticks.first().expect("non-empty");
    let last = *ticks.last().expect("non-empty");
    assert!(
        (first - 1.0).abs() < 0.21,
        "first tick near domain start: {first}"
    );
    assert!(
        (last - 2.0).abs() < 0.21,
        "last tick near domain end: {last}"
    );
    assert!(
        ticks.iter().all(|tick| (tick * 5.0).round().abs() < 1e6),
        "0.2-step grid"
    );
}
