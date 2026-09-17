#[cfg(windows)]
pub fn run() -> Result<(), String> {
    use deep_engine_native::compat_x::{
        CompatibilityLane, X_COMPATIBILITY_SCHEMA_VERSION, XBudget, XCall, XExecutionContext,
        XRequest,
        process::XProcessConfig,
        scheduler::{XContentScheduler, XDynamicContent},
    };
    use deep_engine_native::runtime_package::{RuntimeContentHash, runtime_content_sha256};
    let request = XRequest {
        schema_version: X_COMPATIBILITY_SCHEMA_VERSION,
        expected_epoch: 1,
        started_at_ms: 100,
        random_seed: 0x4450_5831,
        resources: Vec::new(),
        events: Vec::new(),
        calls: vec![XCall::ReadClock, XCall::DrawRandom],
    };
    let context = || XExecutionContext {
        current_epoch: 1,
        now_ms: 100,
        cancelled: false,
    };
    let content = XDynamicContent {
        schema_version: X_COMPATIBILITY_SCHEMA_VERSION,
        lane: CompatibilityLane::ExperimentalX,
        content_hash: RuntimeContentHash {
            algorithm: "sha256".into(),
            value: runtime_content_sha256(
                &serde_json::to_value(&request).map_err(|error| error.to_string())?,
            ),
        },
        request,
    };
    let mut scheduler = XContentScheduler::new(XProcessConfig {
        enabled: true,
        lane: CompatibilityLane::ExperimentalX,
        budget: XBudget::default(),
        ..Default::default()
    })
    .map_err(|error| format!("X worker/config: {error:?}"))?;
    let candidate = scheduler
        .dispatch(&content, context)
        .map_err(|error| format!("X worker/LPAC verification failed: {error:?}"))?;
    println!(
        "Deep2D X compatibility worker OK: schema={} messages={} request_hash={} output_hash={}",
        X_COMPATIBILITY_SCHEMA_VERSION,
        candidate.messages.len(),
        candidate.request_hash,
        candidate.output_hash
    );
    Ok(())
}

#[cfg(windows)]
pub fn run_package(path: &std::path::Path) -> Result<(), String> {
    use deep_engine_native::compat_x::{
        CompatibilityLane, XBudget, XExecutionContext, process::XProcessConfig,
        scheduler::XContentScheduler,
    };
    use deep_engine_native::runtime_package::parse_and_validate_x_runtime_package;

    let bytes = std::fs::read(path)
        .map_err(|error| format!("cannot read X runtime package {}: {error}", path.display()))?;
    let loaded = parse_and_validate_x_runtime_package(&bytes)
        .map_err(|error| format!("X runtime package preflight failed: {error}"))?;
    let epoch = loaded.content.request.expected_epoch;
    let now_ms = loaded.content.request.started_at_ms;
    let mut scheduler = XContentScheduler::new(XProcessConfig {
        enabled: true,
        lane: CompatibilityLane::ExperimentalX,
        budget: XBudget::default(),
        ..Default::default()
    })
    .map_err(|error| format!("X worker/config: {error:?}"))?;
    let published = scheduler
        .dispatch(&loaded.content, || XExecutionContext {
            current_epoch: epoch,
            now_ms,
            cancelled: false,
        })
        .map_err(|error| format!("X runtime package dispatch failed: {error:?}"))?;
    let receipt = serde_json::json!({
        "schemaVersion": 1,
        "packageId": loaded.base.package_id,
        "resourceId": loaded.resource_id,
        "revision": loaded.revision,
        "epoch": published.epoch,
        "requestHash": published.request_hash,
        "outputHash": published.output_hash,
        "messages": published.messages,
    });
    println!(
        "Deep2D X runtime package OK: {}",
        serde_json::to_string(&receipt).map_err(|error| error.to_string())?
    );
    Ok(())
}

#[cfg(not(windows))]
pub fn run() -> Result<(), String> {
    Err("X worker/LPAC verification is Windows-only".into())
}

#[cfg(not(windows))]
pub fn run_package(_path: &std::path::Path) -> Result<(), String> {
    Err("X runtime package execution is Windows-only".into())
}
