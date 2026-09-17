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
    run_package_ticks(path, 1)
}

#[cfg(windows)]
pub fn run_package_ticks(path: &std::path::Path, tick_count: usize) -> Result<(), String> {
    use deep_engine_native::compat_x::{
        CompatibilityLane, XBudget, XExecutionContext,
        process::XProcessConfig,
        scheduler::{XContentScheduler, XTickBinding},
    };
    use deep_engine_native::runtime_package::{
        parse_and_validate_x_runtime_package, read_runtime_package_bytes,
    };

    let store = crate::runtime_lkg::Store::local(path);
    let primary = read_runtime_package_bytes(path)
        .map_err(|error| error.to_string())
        .and_then(|bytes| {
            let loaded = parse_and_validate_x_runtime_package(&bytes)
                .map_err(|error| format!("X runtime package preflight failed: {error}"))?;
            Ok((loaded, bytes))
        });
    let (loaded, bytes, active, primary_rejection) = match primary {
        Ok((loaded, bytes)) => (loaded, bytes, "primary", None),
        Err(primary_error) => {
            let bytes = store
                .as_ref()
                .map_err(|reason| format!("primary rejected: {primary_error}; {reason}"))?
                .restore_x()
                .map_err(|reason| format!("primary rejected: {primary_error}; {reason}"))?;
            let loaded = parse_and_validate_x_runtime_package(&bytes)
                .map_err(|error| format!("X LKG package invalid: {error}"))?;
            (loaded, bytes, "last-known-good", Some(primary_error))
        }
    };
    if !(1..=1_024).contains(&tick_count) {
        return Err("X tick count must be an integer from 1 through 1024".into());
    }
    let mut scheduler = XContentScheduler::new(XProcessConfig {
        enabled: true,
        lane: CompatibilityLane::ExperimentalX,
        budget: XBudget::default(),
        ..Default::default()
    })
    .map_err(|error| format!("X worker/config: {error:?}"))?;
    let template = loaded.content.clone();
    let mut ticks = Vec::with_capacity(tick_count);
    for index in 0..tick_count {
        let offset = u64::try_from(index).map_err(|_| "X tick index overflow")?;
        let epoch = template
            .request
            .expected_epoch
            .checked_add(offset)
            .ok_or("X tick epoch overflow")?;
        let now_ms = template
            .request
            .started_at_ms
            .checked_add(offset.checked_mul(16).ok_or("X tick time overflow")?)
            .ok_or("X tick time overflow")?;
        let random_seed = template
            .request
            .random_seed
            .checked_add(offset)
            .ok_or("X tick random seed overflow")?;
        let published = scheduler
            .dispatch_tick(
                &template,
                XTickBinding {
                    epoch,
                    started_at_ms: now_ms,
                    random_seed,
                    events: template.request.events.clone(),
                },
                || XExecutionContext {
                    current_epoch: epoch,
                    now_ms,
                    cancelled: false,
                },
            )
            .map_err(|error| format!("X runtime package tick {index} failed: {error:?}"))?;
        ticks.push(published_receipt(published)?);
    }
    let receipt = if tick_count == 1 {
        let mut receipt = ticks.pop().expect("one tick was published");
        let object = receipt.as_object_mut().expect("tick receipt is an object");
        object.insert("schemaVersion".into(), serde_json::json!(1));
        object.insert("active".into(), serde_json::json!(active));
        object.insert(
            "packageId".into(),
            serde_json::json!(loaded.base.package_id),
        );
        object.insert("resourceId".into(), serde_json::json!(loaded.resource_id));
        object.insert("revision".into(), serde_json::json!(loaded.revision));
        object.insert(
            "primaryRejection".into(),
            serde_json::json!(primary_rejection),
        );
        receipt
    } else {
        serde_json::json!({
            "schemaVersion": 1,
            "active": active,
            "packageId": loaded.base.package_id,
            "resourceId": loaded.resource_id,
            "revision": loaded.revision,
            "tickCount": tick_count,
            "ticks": ticks,
            "primaryRejection": primary_rejection,
        })
    };
    match store {
        Ok(store) => {
            if let Err(error) = store.commit_x(&bytes, &loaded.base.package_hash) {
                eprintln!(
                    "Deep2D X recovery checkpoint failed; published output retained: {error}"
                );
            }
        }
        Err(error) => {
            eprintln!("Deep2D X recovery cache unavailable; published output retained: {error}");
        }
    }
    println!(
        "Deep2D X runtime package OK: {}",
        serde_json::to_string(&receipt).map_err(|error| error.to_string())?
    );
    Ok(())
}

#[cfg(windows)]
fn published_receipt(
    published: &deep_engine_native::compat_x::scheduler::XPublishedOutput,
) -> Result<serde_json::Value, String> {
    let deep2d = published
        .display_list()
        .map_err(|error| format!("X display publication rejected: {error}"))?
        .map(|display_list| {
            let prepared = deep_engine_native::deep2d::prepare_display_list(display_list)
                .map_err(|error| format!("X Deep2D painter preparation failed: {error:?}"))?;
            Ok::<_, String>(serde_json::json!({
                "commands": prepared.summary.commands,
                "pathSegments": prepared.summary.path_segments,
                "fillTriangles": prepared.summary.fill_triangles,
                "strokeTriangles": prepared.summary.stroke_triangles,
                "vertices": prepared.summary.vertices,
            }))
        })
        .transpose()?;
    Ok(serde_json::json!({
        "epoch": published.epoch,
        "requestHash": published.request_hash,
        "outputHash": published.output_hash,
        "messages": published.messages,
        "deep2d": deep2d,
    }))
}

#[cfg(not(windows))]
pub fn run() -> Result<(), String> {
    Err("X worker/LPAC verification is Windows-only".into())
}

#[cfg(not(windows))]
pub fn run_package(_path: &std::path::Path) -> Result<(), String> {
    Err("X runtime package execution is Windows-only".into())
}

#[cfg(not(windows))]
pub fn run_package_ticks(_path: &std::path::Path, _tick_count: usize) -> Result<(), String> {
    Err("X runtime package execution is Windows-only".into())
}
