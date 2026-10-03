//! Fresh subprocess isolation shared by the device-loss window probes.

use super::super::{NativeAppSetup, RendererFeatures};

pub(super) fn setup() -> NativeAppSetup {
    NativeAppSetup {
        smoke_frame: false,
        features: RendererFeatures {
            bloom: Default::default(),
            fog: deep_engine_native::fog::FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: super::gpu_measurement::enabled(),
        },
        occlusion_probe: false,
        dynamic_playback: None,
        state_ops: None,
        shadow_update_probe: None,
        packet_live_probe: None,
        packet_live_transport: None,
        package_live_transport: None,
        telemetry_prepare_replay: None,
        telemetry_report: false,
        selection_probe: false,
        section_probe: false,
        chart_key_probe: false,
    }
}

pub(super) fn parent_run(retry: bool, window_events: bool) -> bool {
    const CHILD: &str = "DEEP_WINDOW_LOSS_CHILD";
    if std::env::var_os(CHILD).is_some() {
        return false;
    }
    let test = match (retry, window_events) {
        (false, false) => "app::device_loss_probe_tests::j3_gate_e_actual_window_device_loss",
        (true, false) => "app::device_loss_probe_tests::j3_gate_e_actual_window_device_loss_retry",
        (false, true) => "app::device_loss_probe_tests::j3_gate_e_window_events_present",
        (true, true) => "app::device_loss_probe_tests::j3_gate_e_window_events_present_retry",
    };
    for round in 1..=2 {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--ignored", "--nocapture"])
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
