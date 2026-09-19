use super::{SLOT_STRIDE, TS_SLOTS, WARMUP};
use serde_json::{Value, json};

pub(super) struct GpuTiming {
    pub(super) query_set: wgpu::QuerySet,
    pub(super) resolve: wgpu::Buffer,
    pub(super) frame: usize,
}

impl GpuTiming {
    pub(super) fn new(device: &wgpu::Device) -> Self {
        let query_set = device.create_query_set(&wgpu::QuerySetDescriptor {
            label: Some("chart e2e perf frame timestamps"),
            ty: wgpu::QueryType::Timestamp,
            count: 2,
        });
        let resolve = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("chart e2e perf timestamp ring"),
            size: TS_SLOTS as u64 * SLOT_STRIDE,
            usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        Self {
            query_set,
            resolve,
            frame: 0,
        }
    }

    /// 场景结束读回 [from, to) 帧的 GPU 时长(ms);帧序号即 ring 槽位。
    pub(super) fn collect(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        period_ns: f64,
        from: usize,
        to: usize,
    ) -> Vec<f64> {
        let size = TS_SLOTS as u64 * SLOT_STRIDE;
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("chart e2e perf timestamp readback"),
            size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(&self.resolve, 0, &staging, 0, size);
        queue.submit([encoder.finish()]);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        staging.map_async(wgpu::MapMode::Read, .., move |result| {
            let _ = sender.send(result);
        });
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("timestamp poll");
        receiver
            .recv()
            .expect("timestamp map callback")
            .expect("timestamp map");
        let mapped = staging.get_mapped_range(..).expect("timestamp view");
        let read = |frame: usize| {
            let base = frame * SLOT_STRIDE as usize;
            let start = u64::from_le_bytes(mapped[base..base + 8].try_into().unwrap());
            let end = u64::from_le_bytes(mapped[base + 8..base + 16].try_into().unwrap());
            end.wrapping_sub(start) as f64 * period_ns / 1e6
        };
        let samples: Vec<f64> = (from..to.min(TS_SLOTS)).map(read).collect();
        drop(mapped);
        staging.unmap();
        samples
    }
}

pub(super) struct Sample {
    pub(super) cpu_prepare_ms: f64,
    pub(super) present_delay_ms: Option<f64>,
    pub(super) uploaded_bytes: usize,
    pub(super) staged: bool,
    pub(super) est_vram_bytes: usize,
}

fn percentile(sorted: &[f64], p: u32) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((p as f64 / 100.0) * (sorted.len() - 1) as f64).round() as usize]
}

pub(super) fn scenario_row(
    name: &str,
    samples: Vec<Sample>,
    gpu_ms: Option<Vec<f64>>,
    ts_supported: bool,
) -> Value {
    if let Some(gpu) = &gpu_ms {
        assert_eq!(
            gpu.len(),
            samples.len(),
            "GPU and CPU must exclude identical warmup frames"
        );
    }
    let raw: Vec<Value> = samples
        .iter()
        .enumerate()
        .map(|(index, sample)| {
            json!({
                "cpu_prepare_ms": sample.cpu_prepare_ms,
                "present_delay_ms": sample.present_delay_ms,
                "gpu_frame_ms": gpu_ms.as_ref().map(|values| values[index]),
                "uploaded_bytes": sample.uploaded_bytes,
                "staged": sample.staged,
                "est_vram_bytes": sample.est_vram_bytes,
            })
        })
        .collect();
    let mut cpu: Vec<f64> = samples.iter().map(|s| s.cpu_prepare_ms).collect();
    cpu.sort_by(f64::total_cmp);
    let mut present: Vec<f64> = samples.iter().filter_map(|s| s.present_delay_ms).collect();
    present.sort_by(f64::total_cmp);
    let mut gpu = gpu_ms;
    if let Some(g) = &mut gpu {
        g.sort_by(f64::total_cmp);
    }
    let staged: Vec<&Sample> = samples.iter().filter(|s| s.staged).collect();
    let (p, g) = (percentile, gpu.as_deref());
    let uploads: usize = staged.iter().map(|s| s.uploaded_bytes).sum();
    json!({
        "measurement_schema": 2,
        "raw_samples": raw,
        "scenario": name, "colors": 8, "samples": samples.len(), "warmup": WARMUP, "unit": "ms",
        "cpu_prepare_p50_ms": p(&cpu, 50), "cpu_prepare_p95_ms": p(&cpu, 95), "cpu_prepare_p99_ms": p(&cpu, 99),
        "present_delay_p50_ms": p(&present, 50), "present_delay_p95_ms": p(&present, 95), "present_delay_p99_ms": p(&present, 99),
        "gpu_frame_p50_ms": g.map(|v| p(v, 50)), "gpu_frame_p95_ms": g.map(|v| p(v, 95)), "gpu_frame_p99_ms": g.map(|v| p(v, 99)),
        "uploaded_bytes_avg_per_stage": uploads.checked_div(staged.len().max(1)).unwrap_or(0), "staged_frames": staged.len(),
        "est_vram_peak_bytes": samples.iter().map(|s| s.est_vram_bytes).max().unwrap_or(0),
        "gpu_timestamps": if ts_supported { "available" } else {
            "degraded: timestamp-query unsupported; gpu_frame 省略, present_delay 为 CPU+present 口径" },
    })
}

#[test]
fn raw_samples_preserve_order_while_percentiles_sort_copies() {
    let samples = [3.0, 1.0, 2.0]
        .map(|ms| Sample {
            cpu_prepare_ms: ms,
            present_delay_ms: Some(ms),
            uploaded_bytes: 0,
            staged: false,
            est_vram_bytes: 16,
        })
        .into_iter()
        .collect();
    let row = scenario_row("unit", samples, Some(vec![6.0, 2.0, 4.0]), true);
    assert_eq!(row["cpu_prepare_p50_ms"], 2.0);
    assert_eq!(row["gpu_frame_p50_ms"], 4.0);
    assert_eq!(row["raw_samples"][0]["cpu_prepare_ms"], 3.0);
    assert_eq!(row["raw_samples"][0]["gpu_frame_ms"], 6.0);
}

#[test]
fn unavailable_gpu_timestamps_remain_null_not_zero() {
    let sample = Sample {
        cpu_prepare_ms: 1.0,
        present_delay_ms: None,
        uploaded_bytes: 0,
        staged: false,
        est_vram_bytes: 16,
    };
    let row = scenario_row("degraded", vec![sample], None, false);
    assert!(row["gpu_frame_p50_ms"].is_null());
    assert!(row["raw_samples"][0]["gpu_frame_ms"].is_null());
    assert!(
        row["gpu_timestamps"]
            .as_str()
            .unwrap()
            .starts_with("degraded:")
    );
}

#[test]
#[should_panic(expected = "GPU and CPU must exclude identical warmup frames")]
fn mismatched_gpu_warmup_range_is_rejected() {
    scenario_row("bad-range", vec![], Some(vec![1.0]), true);
}
