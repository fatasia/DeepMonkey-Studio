//! Two isolated real windows per registered synthetic unknown cell.
use super::*;
use serde_json::Value;

pub(super) fn parent_run(mode: Mode) -> bool {
    const CHILD: &str = "DEEP_UNKNOWN_LOSS_CHILD";
    if std::env::var_os(CHILD).is_some() {
        return false;
    }
    let test = match mode {
        Mode::Once => "j3_gate_e_unknown_once",
        Mode::Retry => "j3_gate_e_unknown_retry",
        Mode::PrePresent => "j3_gate_e_unknown_pre_present",
        Mode::Exhaustion => "j3_gate_e_unknown_exhaustion",
    };
    let name = format!("app::device_loss_probe_tests::unknown_matrix::{test}");
    for round in 1..=2 {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &name, "--ignored", "--nocapture"])
            .env(CHILD, round.to_string())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        println!("{}", String::from_utf8_lossy(&result.stdout));
    }
    true
}
fn domains(probe: &UnknownProbe, recovered: bool) -> Value {
    let camera = probe.app.state.view == probe.view;
    let package = probe
        .app
        .content
        .active()
        .runtime_package()
        .unwrap()
        .package_hash
        == probe.package_hash;
    let selection = probe.app.state.selected.as_deref() == Some("j3-unknown-preserved-selection");
    assert!(camera && package && selection);
    let channel = "engine-channel-readback";
    json!({
        "camera-pose-mode-avatar":{"verified":camera,"method":channel,"scope":"Native author view"},
        "model-primitive-pose-author-material":{"verified":package,"method":channel,"scope":"retained runtime package hash; HDR separately measured only when recovery presents"},
        "environment-lights-weather-floors-postfx-physics-section-axis":{"verified":package,"method":channel,"scope":"Native packaged environment; retained content channel"},
        "selection-model-layer-annotation":{"verified":selection,"method":"NativeApp state selected"},
        "scene-name-project":{"verified":package,"method":"Native runtime package identity; no Web editor rename API"},
        "native-ui-domains":{"verified":camera && package && selection,"method":"NativeApp view/selection/package only"},
        "gpuRecoveryPresented":{"verified":false,"note":format!("separate present field: {recovered}; not a registered editor domain")}
    })
}
pub(super) fn write(
    probe: &UnknownProbe,
    success: Option<(u64, f64, f64)>,
    manual: Option<(u64, String)>,
) {
    let callbacks = if probe.mode == Mode::PrePresent { 2 } else { 1 };
    assert_eq!(probe.callbacks, callbacks);
    let final_attempt = probe.app.next_renderer_id - 1;
    let fatal = probe.mode == Mode::Exhaustion;
    let after_identity = success.map(|value| value.0).unwrap_or(final_attempt);
    let mut editor_domains = domains(probe, success.is_some());
    editor_domains
        .as_object_mut()
        .unwrap()
        .remove("gpuRecoveryPresented");
    let mut evidence = json!({"rowId":probe.mode.row(),"host":"native-wgpu-vulkan","status":"measured",
        "passed":true,"round":std::env::var("DEEP_UNKNOWN_LOSS_CHILD").unwrap(),
        "actualDriverFault":false,"actualLostCallbacks":0,"stimulus":"synthetic GpuEvent::DeviceLost unknown",
        "strategy":if fatal {"retry-budget-exhausted-manual-r-preserved"} else {"window-retry-auto-rebuild"},
        "identityBefore":format!("renderer-{}",probe.old_id),"identityAfter":format!("renderer-{after_identity}"),
        "lossCallbacks":probe.callbacks,"recoveryAttempts":probe.mode.attempts(),"presentedAfterRecovery":success.is_some(),
        "staleEventsRejected":true,"editorDomains":editor_domains,"packageHash":probe.package_hash,
        "beforeHdr":probe.before_hdr,"hostRecoveryElapsedMs":probe.loss_started.unwrap().elapsed().as_secs_f64()*1000.0,
        "clock":"host-monotonic","gpuUploadTimeNs":null,
        "sourceHash":deep_engine_native::runtime_package::runtime_content_sha256(&json!([
            include_str!("device_loss_unknown_matrix.rs"),include_str!("device_loss_unknown_receipt.rs"),
            include_str!("recovery.rs"),include_str!("recovery_retry.rs"),include_str!("renderer_lifecycle.rs"),
            include_str!("window_events.rs"),include_str!("window_events/redraw.rs"),include_str!("device_loss_probe_fresh.rs")
        ])),"hashEncoding":"canonical-json-unknown-window-consumed-sources"});
    if let Some((id, hdr, relative)) = success {
        evidence["newRenderer"] = json!(id);
        evidence["afterHdr"] = json!(hdr);
        evidence["relativeHdrDrift"] = json!(relative);
    }
    if let Some(id) = probe.pre_present_id {
        evidence["prePresentCandidate"] =
            json!({"rendererId":id,"presented":false,"budgetBeforeSecondLoss":1});
    }
    if let Some((id, failure)) = manual {
        evidence["terminalState"] = json!("failure-diagnostic-and-manual-r-preserved");
        evidence["lateLossDidNotRevive"] = json!(true);
        evidence["failureDiagnostic"] = json!(failure);
        evidence["identityAfterKind"] =
            json!("manual-negative-control renderer, outside automatic exhaustion outcome");
        evidence["manualRebuildNegativeControl"] = json!({"target":"KeyR production initialize_renderer",
            "rendererId":id,"presented":true,"automaticAttemptsBeforeManual":3});
    }
    if let Some(output) = std::env::var_os("J3_UNKNOWN_NATIVE_OUTPUT") {
        std::fs::create_dir_all(&output).unwrap();
        std::fs::write(
            PathBuf::from(output).join(format!(
                "{}-round-{}.json",
                probe.mode.row(),
                std::env::var("DEEP_UNKNOWN_LOSS_CHILD").unwrap()
            )),
            evidence.to_string(),
        )
        .unwrap();
    }
    println!("J3_UNKNOWN_WINDOW {evidence}");
}
