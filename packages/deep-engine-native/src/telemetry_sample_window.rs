//! DE26/A03 benchmark window adapter. Window bounds always use the native
//! host-monotonic epoch; `clockId` on each channel identifies its duration source.

use serde::Serialize;

use crate::telemetry_gpu::GpuReadback;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelSample {
    channel: &'static str,
    clock_id: &'static str,
    samples_ms: Vec<f64>,
    sample_count: usize,
    window_start_ms: f64,
    window_end_ms: f64,
    availability: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable_reason: Option<String>,
}

impl ChannelSample {
    fn measured_or_unavailable(
        channel: &'static str,
        clock_id: &'static str,
        samples_ms: Vec<f64>,
        window_start_ms: f64,
        window_end_ms: f64,
        empty_reason: impl Into<String>,
    ) -> Self {
        let sample_count = samples_ms.len();
        Self {
            channel,
            clock_id,
            samples_ms,
            sample_count,
            window_start_ms,
            window_end_ms,
            availability: if sample_count == 0 {
                "unavailable"
            } else {
                "measured"
            },
            unavailable_reason: (sample_count == 0).then(|| empty_reason.into()),
        }
    }

    fn unavailable(
        channel: &'static str,
        window_start_ms: f64,
        window_end_ms: f64,
        reason: &'static str,
    ) -> Self {
        Self {
            channel,
            clock_id: "host-monotonic",
            samples_ms: Vec::new(),
            sample_count: 0,
            window_start_ms,
            window_end_ms,
            availability: "unavailable",
            unavailable_reason: Some(reason.to_owned()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SampleWindow {
    schema: &'static str,
    schema_version: u8,
    run_id: String,
    clock_id: &'static str,
    window_start_ms: f64,
    window_end_ms: f64,
    channels: Vec<ChannelSample>,
}

pub(crate) fn build(
    run_id: String,
    window_end_ms: f64,
    cpu_submit_ns: impl Iterator<Item = u64>,
    frame_interval_ns: impl Iterator<Item = u64>,
    scene_update_ns: impl Iterator<Item = u64>,
    resource_upload_ns: impl Iterator<Item = u64>,
    gpu: &GpuReadback,
) -> SampleWindow {
    let start = 0.0;
    // TS v1 requires a strict positive window. Preserve that invariant even if
    // a failure report is requested in the same clock tick as telemetry setup.
    let window_end_ms = window_end_ms.max(f64::EPSILON);
    let cpu_submit = cpu_submit_ns.map(ns_to_ms).collect();
    let frame_interval = frame_interval_ns.map(ns_to_ms).collect();
    let scene_update = scene_update_ns.map(ns_to_ms).collect();
    let resource_upload = resource_upload_ns.map(ns_to_ms).collect();
    let gpu_samples = gpu.frame_samples_ms().to_vec();
    let gpu_reason = gpu.sample_window_reason();
    SampleWindow {
        schema: "deep-engine.benchmark-sample-window",
        schema_version: 1,
        run_id,
        clock_id: "host-monotonic",
        window_start_ms: start,
        window_end_ms,
        channels: vec![
            ChannelSample::unavailable(
                "authoring-bridge",
                start,
                window_end_ms,
                "native_runtime_has_no_authoring_bridge_boundary",
            ),
            // R6-2 细分埋点:packet 更新的两段准备已在 stage/publish 真实计时,
            // 窗口内无更新时如实降级为"无样本",不再报"未隔离"。
            ChannelSample::measured_or_unavailable(
                "scene-update",
                "host-monotonic",
                scene_update,
                start,
                window_end_ms,
                "no_packet_scene_update_samples_in_window",
            ),
            ChannelSample::measured_or_unavailable(
                "upload",
                "host-monotonic",
                resource_upload,
                start,
                window_end_ms,
                "no_packet_resource_upload_samples_in_window",
            ),
            ChannelSample::measured_or_unavailable(
                "cpu-submit",
                "host-monotonic",
                cpu_submit,
                start,
                window_end_ms,
                "no_cpu_submit_samples_in_window",
            ),
            ChannelSample::measured_or_unavailable(
                "gpu-timestamp",
                "gpu-timestamp",
                gpu_samples,
                start,
                window_end_ms,
                gpu_reason,
            ),
            ChannelSample::unavailable(
                "present",
                start,
                window_end_ms,
                "wgpu_surface_present_has_no_compositor_completion_timestamp",
            ),
            ChannelSample::measured_or_unavailable(
                "frame-interval",
                "host-monotonic",
                frame_interval,
                start,
                window_end_ms,
                "fewer_than_two_presented_frames_in_window",
            ),
            ChannelSample::unavailable(
                "input-latency",
                start,
                window_end_ms,
                "input_event_timestamp_is_not_connected_to_frame_telemetry",
            ),
        ],
    }
}

fn ns_to_ms(value: u64) -> f64 {
    value as f64 / 1_000_000.0
}

#[cfg(test)]
#[path = "telemetry_sample_window_tests.rs"]
mod tests;
