use super::*;
use crate::runtime_package::RuntimeContentHash;

fn context() -> XExecutionContext {
    XExecutionContext {
        current_epoch: 4,
        now_ms: 100,
        cancelled: false,
    }
}
fn content() -> XDynamicContent {
    let request = XRequest {
        schema_version: 1,
        expected_epoch: 4,
        started_at_ms: 100,
        random_seed: 7,
        resources: vec![],
        events: vec![],
        calls: vec![XCall::EmitNumber(42.0)],
    };
    let content_hash = RuntimeContentHash {
        algorithm: "sha256".into(),
        value: runtime_content_sha256(&serde_json::to_value(&request).unwrap()),
    };
    XDynamicContent {
        schema_version: 1,
        lane: CompatibilityLane::ExperimentalX,
        request,
        content_hash,
    }
}
fn enabled() -> XContentScheduler {
    XContentScheduler::new(XProcessConfig {
        enabled: true,
        ..Default::default()
    })
    .unwrap()
}
fn worker(
    config: XProcessConfig,
    request: &XRequest,
    context: &mut dyn FnMut() -> XExecutionContext,
) -> Result<XCandidate, XProcessError> {
    XCompatibilityHost::new(true, config.budget)
        .unwrap()
        .evaluate(config.lane, request, context())
        .map_err(XProcessError::Rejected)
}

#[test]
fn disabled_n0_schema_and_hash_reject_before_worker() {
    let reject_worker =
        |_,
         _: &XRequest,
         _: &mut dyn FnMut() -> XExecutionContext|
         -> Result<XCandidate, XProcessError> { panic!("worker must not launch") };
    assert_eq!(
        XContentScheduler::default().dispatch_with(&content(), &mut context, reject_worker),
        Err(XProcessError::Rejected(XRejection::Disabled))
    );
    for mutation in 0..4 {
        let mut input = content();
        match mutation {
            0 => input.lane = CompatibilityLane::NativeN0,
            1 => input.schema_version = 2,
            2 => input.request.schema_version = 2,
            _ => input.content_hash.value = "0".repeat(64),
        }
        assert!(
            enabled()
                .dispatch_with(&input, &mut context, reject_worker)
                .is_err()
        );
    }
}

#[test]
fn failed_dispatch_and_final_epoch_race_keep_last_known_good() {
    let mut scheduler = enabled();
    scheduler
        .dispatch_with(&content(), &mut context, worker)
        .unwrap();
    let old = scheduler.last_known_good().cloned().unwrap();
    for failure in [
        XProcessError::Crashed,
        XProcessError::InvalidReceipt,
        XProcessError::Rejected(XRejection::WallClockBudgetExceeded),
    ] {
        assert!(
            scheduler
                .dispatch_with(&content(), &mut context, |_, _, _| Err(failure))
                .is_err()
        );
        assert_eq!(scheduler.last_known_good(), Some(&old));
    }
    let mut calls = 0;
    let mut changed = || {
        calls += 1;
        XExecutionContext {
            current_epoch: if calls >= 3 { 5 } else { 4 },
            ..context()
        }
    };
    assert!(matches!(
        scheduler.dispatch_with(&content(), &mut changed, worker),
        Err(XProcessError::Rejected(XRejection::StaleEpoch { .. }))
    ));
    assert_eq!(scheduler.last_known_good(), Some(&old));
}

#[test]
fn content_cannot_supply_paths_scripts_switches_or_budgets() {
    for key in ["workerPath", "script", "enabled", "budget"] {
        let mut value = serde_json::to_value(content()).unwrap();
        value[key] = serde_json::json!("untrusted");
        assert!(serde_json::from_value::<XDynamicContent>(value).is_err());
    }
    let mut value = serde_json::to_value(content()).unwrap();
    value["request"]["script"] = serde_json::json!("arbitrary()");
    assert!(serde_json::from_value::<XDynamicContent>(value).is_err());
}

#[test]
fn pre_cancel_and_message_budget_keep_output() {
    let mut scheduler = enabled();
    scheduler
        .dispatch_with(&content(), &mut context, worker)
        .unwrap();
    let old = scheduler.last_known_good().cloned();
    let mut cancelled = || XExecutionContext {
        cancelled: true,
        ..context()
    };
    assert_eq!(
        scheduler.dispatch_with(&content(), &mut cancelled, worker),
        Err(XProcessError::Rejected(XRejection::Cancelled))
    );
    let mut input = content();
    input.request.calls = vec![XCall::ReadClock; 1025];
    input.content_hash.value =
        runtime_content_sha256(&serde_json::to_value(&input.request).unwrap());
    assert!(matches!(
        scheduler.dispatch_with(&input, &mut context, worker),
        Err(XProcessError::Rejected(XRejection::MessageBudgetExceeded))
    ));
    assert_eq!(scheduler.last_known_good(), old.as_ref());
}

#[test]
fn oversized_and_deep_inputs_never_launch_worker() {
    let reject_worker =
        |_,
         _: &XRequest,
         _: &mut dyn FnMut() -> XExecutionContext|
         -> Result<XCandidate, XProcessError> { panic!("worker must not launch") };
    let mut input = content();
    input.request.resources.push(XResource {
        id: "large".into(),
        bytes: vec![255; process::MAX_IPC_BYTES],
    });
    assert_eq!(
        enabled().dispatch_with(&input, &mut context, reject_worker),
        Err(XProcessError::IpcBudgetExceeded)
    );
    let mut input = content();
    let mut call = XCall::ReadClock;
    for _ in 0..17 {
        call = XCall::Sequence(vec![call]);
    }
    input.request.calls = vec![call];
    assert_eq!(
        enabled().dispatch_with(&input, &mut context, reject_worker),
        Err(XProcessError::Rejected(XRejection::CallDepthExceeded))
    );
}
