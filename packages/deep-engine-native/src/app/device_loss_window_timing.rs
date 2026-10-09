//! Test-only window lifecycle measurement and receipt serialization.
use super::window_events_support::{
    WindowEventExpectations, WindowEventKind, WindowEventTimeline, validate_window_events,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

struct WindowMeasurement {
    timeline: WindowEventTimeline,
    recovery_candidate: Option<u64>,
}

thread_local! {
    static WINDOW_MEASUREMENT: std::cell::RefCell<Option<WindowMeasurement>> = const { std::cell::RefCell::new(None) };
}

/// Only the named timing probe enables this observer; ordinary cfg(test) frames avoid a timer.
pub(super) fn begin_present_measurement() -> Option<Instant> {
    WINDOW_MEASUREMENT.with(|measurement| measurement.borrow().as_ref().map(|_| Instant::now()))
}

pub(super) fn observe_present(renderer_id: u64, elapsed: Duration) {
    WINDOW_MEASUREMENT.with(|measurement| {
        if let Some(measurement) = measurement.borrow_mut().as_mut() {
            let kind = if measurement.recovery_candidate == Some(renderer_id) {
                WindowEventKind::RecoveryPresented
            } else {
                WindowEventKind::Presented
            };
            measurement
                .timeline
                .record_present(kind, renderer_id, elapsed);
        }
    });
}

pub(super) fn record_event(kind: WindowEventKind, renderer_id: u64) {
    WINDOW_MEASUREMENT.with(|measurement| {
        if let Some(measurement) = measurement.borrow_mut().as_mut() {
            if kind == WindowEventKind::RecoveryCandidateCreated {
                measurement.recovery_candidate = Some(renderer_id);
            }
            measurement.timeline.record(kind, renderer_id);
        }
    });
}

pub(super) fn start() {
    WINDOW_MEASUREMENT.with(|measurement| {
        *measurement.borrow_mut() = Some(WindowMeasurement {
            timeline: WindowEventTimeline::start(),
            recovery_candidate: None,
        });
    });
}

pub(super) fn clear() {
    WINDOW_MEASUREMENT.with(|measurement| *measurement.borrow_mut() = None);
}

pub(super) fn evidence(old_id: u64, new_id: u64) -> Value {
    WINDOW_MEASUREMENT.with(|measurement| {
    let measurement = measurement.borrow();
    let timeline = &measurement.as_ref().expect("timing probe enabled").timeline;
    let findings = validate_window_events(timeline, old_id, new_id, &WindowEventExpectations {
        loss_callbacks: 1,
        require_recovery_present: true,
        require_present_timing: true,
        timeout: Duration::from_secs(45),
    }).expect("real window timeline must match registered lifecycle");
    json!({
        "clock": "host-monotonic",
        "origin": "resumed-before-window-creation",
        "scope": "production-app-redraw-render-return",
        "sourceHash": deep_engine_native::runtime_package::runtime_content_sha256(&json!([
            include_str!("device_loss_probe_tests.rs"),
                        include_str!("device_loss_probe_fresh.rs"),
                        include_str!("device_loss_probe_input.rs"),
                        include_str!("device_loss_gpu_measurement.rs"),
                        include_str!("device_loss_window_timing.rs"),
            include_str!("window_events/redraw.rs"),
            include_str!("../../tests/support/j3_window_events.rs"),
                        include_str!("../../tests/support/j3_window_events_validation.rs"),
        ])),
        "hashEncoding": "canonical-json-window-probe-sources",
        "records": timeline.records().iter().map(|event| json!({
            "kind": event.kind.label(), "rendererId": event.renderer_id,
            "offsetMs": event.at.as_secs_f64() * 1_000.0,
        })).collect::<Vec<_>>(),
        "presentSamples": timeline.present_samples().iter().map(|sample| json!({
            "kind": sample.kind.label(), "rendererId": sample.renderer_id,
            "offsetMs": sample.at.as_secs_f64() * 1_000.0,
            "hostRenderPresentDurationMs": sample.duration.as_secs_f64() * 1_000.0,
        })).collect::<Vec<_>>(),
        "presentOffsetsMs": timeline.present_offsets_ms(),
        "presentsBeforeLoss": findings.presents_before_loss,
        "presentsAfterRecovery": findings.presents_after_recovery,
        "lossCallbacks": findings.loss_callbacks, "staleRejections": findings.stale_rejections,
        "recoveryDurationMs": findings.recovery_duration.map(|duration| duration.as_secs_f64() * 1_000.0),
        "totalMs": findings.total.as_secs_f64() * 1_000.0,
        "gpuTimestamp": { "availability": "unavailable", "reason": "this window probe does not collect timestamp-query samples" },
        "actualUnknownDriverFault": false,
    })
})
}

pub(super) fn write_evidence(evidence: &Value, retry: bool, window_events: bool) {
    if let Some(output) = std::env::var_os("J3_WINDOW_NATIVE_OUTPUT") {
        std::fs::create_dir_all(&output).unwrap();
        let prefix = match (retry, window_events) {
            (false, false) => "",
            (true, false) => "retry-",
            (false, true) => "events-",
            (true, true) => "events-retry-",
        };
        std::fs::write(
            std::path::PathBuf::from(output).join(format!(
                "{}round-{}.json",
                prefix,
                std::env::var("DEEP_WINDOW_LOSS_CHILD").unwrap()
            )),
            evidence.to_string(),
        )
        .unwrap();
    }
}
