#[cfg(windows)]
pub fn run() -> Result<(), String> {
    use deep_engine_native::compat_x::{
        CompatibilityLane, X_COMPATIBILITY_SCHEMA_VERSION, XBudget, XCall, XExecutionContext,
        XRequest,
        process::{XProcessConfig, lpac},
    };
    let player =
        std::env::current_exe().map_err(|error| format!("X worker/current-exe: {error}"))?;
    let worker = player
        .parent()
        .ok_or("X worker/player has no parent directory")?
        .join("deep2d-x-worker.exe");
    if !worker.is_file() {
        return Err(format!(
            "X worker/missing packaged worker: {}",
            worker.display()
        ));
    }
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
    let candidate = lpac::evaluate(
        &worker,
        XProcessConfig {
            enabled: true,
            lane: CompatibilityLane::ExperimentalX,
            budget: XBudget::default(),
            ..Default::default()
        },
        &request,
        context,
    )
    .map_err(|error| format!("X worker/LPAC verification failed: {error:?}"))?;
    println!(
        "Deep2D X compatibility worker OK: schema={} messages={} request_hash={} output_hash={}",
        X_COMPATIBILITY_SCHEMA_VERSION,
        candidate.messages().len(),
        candidate.request_hash(),
        candidate.output_hash()
    );
    Ok(())
}

#[cfg(not(windows))]
pub fn run() -> Result<(), String> {
    Err("X worker/LPAC verification is Windows-only".into())
}
