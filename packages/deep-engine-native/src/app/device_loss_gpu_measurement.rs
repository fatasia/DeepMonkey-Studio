//! Optional test observer of production telemetry on both actual recovery devices.
use super::*;
use serde_json::{Value, json};

thread_local! {
    static BEFORE: std::cell::RefCell<Option<Value>> = const { std::cell::RefCell::new(None) };
}

pub(super) fn enabled() -> bool {
    std::env::var("J3_WINDOW_GPU_TIMING").as_deref() == Ok("on")
}

fn validate(report: &Value, epoch: u64) -> Result<(), &'static str> {
    let metrics = &report["metrics"];
    if metrics["schema"] != "deep-engine.native-telemetry"
        || metrics["device_epoch"].as_u64() != Some(epoch)
    {
        return Err("wrong production telemetry identity");
    }
    if metrics["gpu"]["status"] != "supported"
        || metrics["gpu"]["samples"].as_u64().unwrap_or(0) < 12
        || metrics["gpu"]["segments"]["frame"]["samples"]
            .as_u64()
            .unwrap_or(0)
            < 12
        || metrics["gpu"]["segments"]["frame"]["p50_ns"]
            .as_u64()
            .unwrap_or(0)
            == 0
        || metrics["frames"]["presented"].as_u64().unwrap_or(0) < 12
    {
        return Err("actual GPU frame window is incomplete");
    }
    Ok(())
}

fn capture(probe: &mut Probe, event_loop: &ActiveEventLoop) -> Value {
    for _ in 0..12 {
        probe.redraw(event_loop);
    }
    let renderer = probe.app.renderer.as_ref().unwrap();
    let report = renderer
        .telemetry_report()
        .expect("production telemetry enabled");
    validate(&report, renderer.id()).expect("actual production GPU timestamps required");
    report
}

pub(super) fn before(probe: &mut Probe, event_loop: &ActiveEventLoop) {
    if enabled() {
        let report = capture(probe, event_loop);
        BEFORE.with(|slot| *slot.borrow_mut() = Some(report));
    }
}

pub(super) fn after(probe: &mut Probe, event_loop: &ActiveEventLoop) -> Option<Value> {
    if !enabled() {
        return None;
    }
    let after = capture(probe, event_loop);
    let before = BEFORE
        .with(|slot| slot.borrow_mut().take())
        .expect("old device sampled before loss");
    assert_ne!(
        before["metrics"]["device_epoch"],
        after["metrics"]["device_epoch"]
    );
    Some(
        json!({"measurementPassed":true,"gateEClosed":false,"additionalRedrawsPerDevice":12,
        "scope":"original NativeApp actual presented frames and production timestamp-query reports",
        "before":before,"after":after,"performanceBudgetMilliseconds":null,
        "actualUnknownDriverFault":false}),
    )
}

pub(super) fn attach(evidence: &mut Value, measurement: Value, window_events: bool) {
    if window_events {
        evidence["windowEvents"]["gpuTimestamp"] = json!({"availability":"measured",
            "source":"gpuMeasurement.before/after.metrics.gpu",
            "scope":"production timestamp-query frame windows"});
    }
    evidence["gpuMeasurement"] = measurement;
}

#[cfg(test)]
mod validation_tests {
    use super::*;
    fn report() -> Value {
        json!({"metrics":{"schema":"deep-engine.native-telemetry","device_epoch":7,
            "frames":{"presented":12},"gpu":{"status":"supported","samples":12,
                "segments":{"frame":{"samples":12,"p50_ns":1000}}}}})
    }
    #[test]
    fn rejects_cross_device_report() {
        assert!(validate(&report(), 8).is_err());
    }
    #[test]
    fn rejects_missing_or_zero_timestamps() {
        for value in [json!(null), json!(0)] {
            let mut input = report();
            input["metrics"]["gpu"]["segments"]["frame"]["p50_ns"] = value;
            assert!(validate(&input, 7).is_err());
        }
    }
    #[test]
    fn rejects_unpresented_and_incomplete_windows() {
        for pointer in [
            "/metrics/gpu/samples",
            "/metrics/gpu/segments/frame/samples",
            "/metrics/frames/presented",
        ] {
            let mut input = report();
            *input.pointer_mut(pointer).unwrap() = json!(11);
            assert!(validate(&input, 7).is_err());
        }
        assert!(validate(&report(), 7).is_ok());
    }
}
