use std::time::Instant;

use super::*;

#[test]
fn ring_is_bounded_and_percentiles_are_exact() {
    let mut ring = SegmentRing::new();
    for value in 0..600_u64 {
        ring.record(value);
    }
    let stats = ring.snapshot(600);
    assert_eq!((stats.samples, stats.dropped), (512, 88));
    assert_eq!(
        (stats.p50_ns, stats.p95_ns, stats.p99_ns, stats.max_ns),
        (343, 574, 594, 599)
    );
    assert_eq!(stats.coverage_ppm, 853_333);
}

#[test]
fn reset_barrier_rejects_old_epoch_sample() {
    let old = SampleToken {
        device_epoch: 7,
        reset_generation: 0,
    };
    let mut rings = std::array::from_fn(|_| SegmentRing::new());
    rings[CpuSegment::Acquire.index()].record(5);
    let mut telemetry = FrameTelemetry {
        device_epoch: 7,
        reset_generation: 1,
        rings,
        frames: FrameCounts::default(),
        late_samples: 0,
        gpu_unavailable_reason: Some("test"),
        gpu: None,
    };
    telemetry.record(old, CpuSegment::Acquire, Some(Instant::now()));
    assert_eq!(telemetry.late_samples, 1);
    assert_eq!(
        telemetry.rings[CpuSegment::Acquire.index()].samples.len(),
        1
    );
    telemetry.reset_barrier();
    assert!(telemetry.rings.iter().all(|ring| ring.samples.is_empty()));
    telemetry.record(old, CpuSegment::Acquire, Some(Instant::now()));
    telemetry.record(
        SampleToken {
            device_epoch: 6,
            reset_generation: 2,
        },
        CpuSegment::Acquire,
        Some(Instant::now()),
    );
    assert_eq!(telemetry.late_samples, 2);
}
