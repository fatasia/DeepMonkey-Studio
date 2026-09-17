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

#[cfg(not(windows))]
pub fn run() -> Result<(), String> {
    Err("X worker/LPAC verification is Windows-only".into())
}
