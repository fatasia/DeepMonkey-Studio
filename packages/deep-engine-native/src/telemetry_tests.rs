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
        submitted_frames: 0,
        packet_updates: 0,
        deep2d_updates: 0,
        late_samples: 0,
        window_started_at: Instant::now(),
        last_presented_at: None,
        frame_intervals: SegmentRing::new(),
        gpu_unavailable_reason: Some("test"),
        gpu: None,
        stage_activity: std::array::from_fn(|_| StageActivity::default()),
        current_stage_mask: 0,
        current_skip_reasons: [None; GpuSegment::ALL.len()],
    };
    telemetry.record(old, CpuSegment::Acquire, Some(Instant::now()));
    assert_eq!(telemetry.late_samples, 1);
    assert_eq!(
        telemetry.rings[CpuSegment::Acquire.index()].samples.len(),
        1
    );
    telemetry.reset_barrier();
    assert!(telemetry.rings.iter().all(|ring| ring.samples.is_empty()));
    assert_eq!(telemetry.submitted_frames, 0);
    assert!(
        telemetry
            .stage_activity
            .iter()
            .all(|activity| { activity.executed_frames == 0 && activity.skipped_frames == 0 })
    );
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

#[test]
fn packet_prepare_samples_are_counted_and_reset_with_the_window() {
    let mut telemetry = FrameTelemetry {
        device_epoch: 1,
        reset_generation: 0,
        rings: std::array::from_fn(|_| SegmentRing::new()),
        frames: FrameCounts::default(),
        submitted_frames: 0,
        packet_updates: 0,
        deep2d_updates: 0,
        late_samples: 0,
        window_started_at: Instant::now(),
        last_presented_at: None,
        frame_intervals: SegmentRing::new(),
        gpu_unavailable_reason: Some("test"),
        gpu: None,
        stage_activity: std::array::from_fn(|_| StageActivity::default()),
        current_stage_mask: 0,
        current_skip_reasons: [None; GpuSegment::ALL.len()],
    };
    telemetry.record_packet_prepare(120_000_000, 40_000_000);
    telemetry.record_packet_prepare(140_000_000, 60_000_000);
    telemetry.record_deep2d_prepare(8_000_000);
    assert_eq!((telemetry.packet_updates, telemetry.deep2d_updates), (2, 1));
    assert_eq!(
        telemetry.rings[CpuSegment::SceneUpdate.index()]
            .samples
            .iter()
            .copied()
            .collect::<Vec<_>>(),
        vec![120_000_000, 140_000_000]
    );
    assert_eq!(
        telemetry.rings[CpuSegment::ResourcePrepare.index()]
            .samples
            .iter()
            .copied()
            .collect::<Vec<_>>(),
        vec![40_000_000, 60_000_000]
    );
    telemetry.reset_barrier();
    assert_eq!((telemetry.packet_updates, telemetry.deep2d_updates), (0, 0));
    assert!(
        telemetry.rings[CpuSegment::SceneUpdate.index()]
            .samples
            .is_empty()
    );
}

#[test]
fn frame_pass_receipt_reports_execution_and_unavailable_timing_separately() {
    let mut activity: [StageActivity; GpuSegment::ALL.len()] =
        std::array::from_fn(|_| StageActivity::default());
    activity[GpuSegment::Frame.index()].executed_frames = 2;
    activity[GpuSegment::Shadow.index()].skipped_frames = 2;
    activity[GpuSegment::Shadow.index()]
        .skip_reasons
        .insert("shadow_cache_clean", 2);
    activity[GpuSegment::Transparent.index()].executed_frames = 1;
    activity[GpuSegment::Transparent.index()].skipped_frames = 1;
    activity[GpuSegment::Transparent.index()]
        .skip_reasons
        .insert("no_transparent_geometry", 1);

    let gpu = GpuReadback::degraded("timestamp_query_unsupported");
    let receipt = frame_pass_receipt(2, &activity, &gpu);
    let stages = receipt["stages"].as_array().unwrap();
    let stage = |id| stages.iter().find(|stage| stage["id"] == id).unwrap();

    assert_eq!(receipt["schema"], "deep-engine.native-frame-pass-receipt");
    assert_eq!(stage("frame")["execution"]["status"], "executed");
    assert_eq!(stage("frame")["timing"]["availability"], "unavailable");
    assert_eq!(
        stage("frame")["timing"]["reason"],
        "timestamp_query_unsupported"
    );
    assert_eq!(stage("shadow")["execution"]["status"], "skipped");
    assert_eq!(
        stage("shadow")["execution"]["skipReasons"]["shadow_cache_clean"],
        2
    );
    assert_eq!(
        stage("shadow")["timing"]["reason"],
        "stage_not_executed_in_window"
    );
    assert_eq!(stage("transparent")["execution"]["status"], "mixed");
}

#[test]
fn frame_pass_receipt_marks_only_nonempty_timestamp_segments_measured() {
    let mut activity: [StageActivity; GpuSegment::ALL.len()] =
        std::array::from_fn(|_| StageActivity::default());
    activity[GpuSegment::Frame.index()].executed_frames = 2;
    let mut gpu = GpuReadback::degraded("timestamp_results_unavailable");
    gpu.segments.insert(
        "frame",
        SegmentStats {
            samples: 2,
            dropped: 0,
            coverage_ppm: 1_000_000,
            p50_ns: 10,
            p95_ns: 19,
            p99_ns: 19,
            max_ns: 20,
        },
    );
    let receipt = frame_pass_receipt(2, &activity, &gpu);
    let frame = receipt["stages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|stage| stage["id"] == "frame")
        .unwrap();
    assert_eq!(frame["timing"]["availability"], "measured");
    assert_eq!(frame["timing"]["sampleCount"], 2);
    assert_eq!(frame["timing"]["p50Ns"], 10);
    assert_eq!(
        receipt["stages"][1]["timing"]["reason"],
        "stage_not_executed_in_window"
    );
}

#[test]
fn frame_pass_receipt_explains_missing_stage_timing_in_an_observed_gpu_window() {
    let mut activity: [StageActivity; GpuSegment::ALL.len()] =
        std::array::from_fn(|_| StageActivity::default());
    activity[GpuSegment::Frame.index()].executed_frames = 1;
    let gpu = GpuReadback::supported_for_test(vec![1.0]);
    let receipt = frame_pass_receipt(1, &activity, &gpu);
    let frame = receipt["stages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|stage| stage["id"] == "frame")
        .unwrap();
    assert_eq!(frame["timing"]["availability"], "unavailable");
    assert_eq!(
        frame["timing"]["reason"],
        "no_stage_timestamp_samples_in_window"
    );
}

#[test]
fn frame_stage_activity_is_committed_only_after_command_submission() {
    let mut telemetry = FrameTelemetry {
        device_epoch: 1,
        reset_generation: 0,
        rings: std::array::from_fn(|_| SegmentRing::new()),
        frames: FrameCounts::default(),
        submitted_frames: 0,
        packet_updates: 0,
        deep2d_updates: 0,
        late_samples: 0,
        window_started_at: Instant::now(),
        last_presented_at: None,
        frame_intervals: SegmentRing::new(),
        gpu_unavailable_reason: Some("test"),
        gpu: None,
        stage_activity: std::array::from_fn(|_| StageActivity::default()),
        current_stage_mask: 0,
        current_skip_reasons: [None; GpuSegment::ALL.len()],
    };

    let failed_token = telemetry.begin_frame();
    telemetry.mark_stage_executed(GpuSegment::Frame);
    telemetry.finish_frame(failed_token, FrameResult::Failed);
    assert_eq!(telemetry.submitted_frames, 0);
    assert_eq!(
        telemetry.stage_activity[GpuSegment::Frame.index()].executed_frames,
        0
    );

    telemetry.begin_frame();
    telemetry.mark_stage_executed(GpuSegment::Frame);
    telemetry.mark_stage_skipped(GpuSegment::Shadow, "shadow_cache_clean");
    telemetry.gpu_submitted_frame();
    assert_eq!(telemetry.submitted_frames, 1);
    assert_eq!(
        telemetry.stage_activity[GpuSegment::Frame.index()].executed_frames,
        1
    );
    assert_eq!(
        telemetry.stage_activity[GpuSegment::Shadow.index()].skipped_frames,
        1
    );
}
