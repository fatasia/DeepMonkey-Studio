use super::*;

#[test]
fn adapter_emits_ts_v1_shape_without_fake_zeroes() {
    let gpu = GpuReadback::degraded("timestamp_query_unsupported");
    let value = serde_json::to_value(build(
        "native.device-7.reset-2".into(),
        25.0,
        [2_000_000, 4_000_000].into_iter(),
        std::iter::empty(),
        std::iter::empty(),
        std::iter::empty(),
        &gpu,
    ))
    .unwrap();

    assert_eq!(value["schema"], "deep-engine.benchmark-sample-window");
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["clockId"], "host-monotonic");
    assert_eq!(value["windowStartMs"], 0.0);
    assert_eq!(value["windowEndMs"], 25.0);
    let channels = value["channels"].as_array().unwrap();
    assert_eq!(channels.len(), 8);
    for entry in channels {
        assert_eq!(entry["windowStartMs"], 0.0);
        assert_eq!(entry["windowEndMs"], 25.0);
        if entry["availability"] == "unavailable" {
            assert_eq!(entry["samplesMs"], serde_json::json!([]));
            assert_eq!(entry["sampleCount"], 0);
            assert!(!entry["unavailableReason"].as_str().unwrap().is_empty());
        }
    }

    let cpu = channel(channels, "cpu-submit");
    assert_eq!(cpu["availability"], "measured");
    assert_eq!(cpu["samplesMs"], serde_json::json!([2.0, 4.0]));
    assert_eq!(cpu["sampleCount"], 2);
    assert!(cpu.get("unavailableReason").is_none());

    let gpu = channel(channels, "gpu-timestamp");
    assert_eq!(gpu["clockId"], "gpu-timestamp");
    assert_eq!(gpu["availability"], "unavailable");
    assert_eq!(gpu["samplesMs"], serde_json::json!([]));
    assert_eq!(gpu["sampleCount"], 0);
    assert_eq!(gpu["unavailableReason"], "timestamp_query_unsupported");

    let input = channel(channels, "input-latency");
    assert_eq!(input["availability"], "unavailable");
    assert_ne!(input["unavailableReason"], "");
}

#[test]
fn scene_update_and_upload_are_measured_only_with_real_samples() {
    let gpu = GpuReadback::degraded("timestamp_query_unsupported");
    // 无 packet 更新的窗口:两通道如实降级为"无样本",不再报"未隔离"。
    let value = serde_json::to_value(build(
        "native.device-1.reset-0".into(),
        25.0,
        std::iter::empty(),
        std::iter::empty(),
        std::iter::empty(),
        std::iter::empty(),
        &gpu,
    ))
    .unwrap();
    let channels = value["channels"].as_array().unwrap();
    let scene_update = channel(channels, "scene-update");
    assert_eq!(scene_update["availability"], "unavailable");
    assert_eq!(
        scene_update["unavailableReason"],
        "no_packet_scene_update_samples_in_window"
    );
    let upload = channel(channels, "upload");
    assert_eq!(upload["availability"], "unavailable");
    assert_eq!(
        upload["unavailableReason"],
        "no_packet_resource_upload_samples_in_window"
    );

    // 有真实 packet 更新的窗口:两通道 measured,毫秒换算正确。
    let value = serde_json::to_value(build(
        "native.device-1.reset-0".into(),
        25.0,
        std::iter::empty(),
        std::iter::empty(),
        [120_000_000_u64, 140_500_000].into_iter(),
        [40_000_000_u64].into_iter(),
        &gpu,
    ))
    .unwrap();
    let channels = value["channels"].as_array().unwrap();
    let scene_update = channel(channels, "scene-update");
    assert_eq!(scene_update["availability"], "measured");
    assert_eq!(scene_update["samplesMs"], serde_json::json!([120.0, 140.5]));
    assert!(scene_update.get("unavailableReason").is_none());
    let upload = channel(channels, "upload");
    assert_eq!(upload["availability"], "measured");
    assert_eq!(upload["samplesMs"], serde_json::json!([40.0]));
}

#[test]
fn gpu_and_frame_interval_are_measured_only_with_real_samples() {
    let gpu = GpuReadback::supported_for_test(vec![1.25, 1.5]);
    let value = serde_json::to_value(build(
        "native.device-1.reset-0".into(),
        40.0,
        std::iter::empty(),
        [16_000_000, 17_000_000].into_iter(),
        std::iter::empty(),
        std::iter::empty(),
        &gpu,
    ))
    .unwrap();
    let channels = value["channels"].as_array().unwrap();
    let gpu = channel(channels, "gpu-timestamp");
    assert_eq!(gpu["availability"], "measured");
    assert_eq!(gpu["samplesMs"], serde_json::json!([1.25, 1.5]));
    let interval = channel(channels, "frame-interval");
    assert_eq!(interval["availability"], "measured");
    assert_eq!(interval["samplesMs"], serde_json::json!([16.0, 17.0]));

    let cpu = channel(channels, "cpu-submit");
    assert_eq!(cpu["availability"], "unavailable");
    assert_eq!(cpu["samplesMs"], serde_json::json!([]));
    assert_eq!(cpu["unavailableReason"], "no_cpu_submit_samples_in_window");
}

#[test]
fn immediate_failure_report_still_has_a_valid_positive_window() {
    let gpu = GpuReadback::degraded("timestamp_query_unsupported");
    let value = serde_json::to_value(build(
        "native.device-1.reset-0".into(),
        0.0,
        std::iter::empty(),
        std::iter::empty(),
        std::iter::empty(),
        std::iter::empty(),
        &gpu,
    ))
    .unwrap();
    assert_eq!(value["windowStartMs"], 0.0);
    assert!(value["windowEndMs"].as_f64().unwrap() > 0.0);
}

fn channel<'a>(channels: &'a [serde_json::Value], name: &str) -> &'a serde_json::Value {
    channels
        .iter()
        .find(|entry| entry["channel"] == name)
        .expect("channel exists")
}
