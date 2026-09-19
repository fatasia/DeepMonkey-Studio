//! Opt-in, fixed-window telemetry for one native renderer/device epoch.

use std::{collections::BTreeMap, time::Instant};

use serde::Serialize;

use crate::telemetry_gpu::{GpuFrameTiming, GpuReadback};

#[path = "telemetry_sample_window.rs"]
mod sample_window;

pub const RING_CAPACITY: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CpuSegment {
    Acquire,
    SceneResources,
    Shadow,
    Opaque,
    Transparent,
    Deep2d,
    Postprocess,
    SubmitPresent,
    /// R6-2 细分:一次 packet 更新在 staging 阶段的纯 CPU 场景准备
    /// (校验/遍历/批处理/派生数据/阴影相关分类)。与 `ResourcePrepare`
    /// 的分界线是 GPU 资源创建开始之处。样本按"已提交的 packet 更新"
    /// 计,不按帧计。
    SceneUpdate,
    /// R6-2 细分:同一 packet 更新的 GPU 资源准备(缓冲区创建/上传暂存/
    /// 材质绑定重建/culling+lod 资源),即 `stage_scoped` 闭包与错误域
    /// pop 的整体。与 `SceneUpdate` 同批记录。
    ResourcePrepare,
    /// R6-2 细分:Deep2D(文字/二维管线)staging 准备。A1(文字驱逐)
    /// 证据通道;无 Deep2D 的场景保持零样本,属如实降级。
    Deep2dPrepare,
}

impl CpuSegment {
    const ALL: [Self; 11] = [
        Self::Acquire,
        Self::SceneResources,
        Self::Shadow,
        Self::Opaque,
        Self::Transparent,
        Self::Deep2d,
        Self::Postprocess,
        Self::SubmitPresent,
        Self::SceneUpdate,
        Self::ResourcePrepare,
        Self::Deep2dPrepare,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::Acquire => "acquire",
            Self::SceneResources => "scene_update_resource_preparation",
            Self::Shadow => "shadow",
            Self::Opaque => "opaque",
            Self::Transparent => "transparent",
            Self::Deep2d => "deep2d",
            Self::Postprocess => "postprocess",
            Self::SubmitPresent => "queue_submit_present",
            Self::SceneUpdate => "packet_scene_update",
            Self::ResourcePrepare => "packet_resource_upload",
            Self::Deep2dPrepare => "packet_deep2d_prepare",
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameResult {
    Presented,
    Skipped,
    Recover,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SampleToken {
    pub device_epoch: u64,
    pub reset_generation: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct FrameCounts {
    pub attempted: u64,
    pub presented: u64,
    pub skipped: u64,
    pub recoveries: u64,
    pub failed: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct SegmentStats {
    pub samples: usize,
    pub dropped: u64,
    pub coverage_ppm: u64,
    pub p50_ns: u64,
    pub p95_ns: u64,
    pub p99_ns: u64,
    pub max_ns: u64,
}

#[derive(Debug)]
struct SegmentRing {
    samples: std::collections::VecDeque<u64>,
    dropped: u64,
}

impl SegmentRing {
    fn new() -> Self {
        Self {
            samples: std::collections::VecDeque::with_capacity(RING_CAPACITY),
            dropped: 0,
        }
    }

    fn record(&mut self, duration_ns: u64) {
        if self.samples.len() == RING_CAPACITY {
            self.samples.pop_front();
            self.dropped += 1;
        }
        self.samples.push_back(duration_ns);
    }

    fn clear(&mut self) {
        self.samples.clear();
        self.dropped = 0;
    }

    fn snapshot(&self, expected: u64) -> SegmentStats {
        stats_from(self.samples.iter().copied(), self.dropped, expected)
    }
}

pub struct FrameTelemetry {
    device_epoch: u64,
    reset_generation: u64,
    rings: [SegmentRing; CpuSegment::ALL.len()],
    frames: FrameCounts,
    /// 已提交(commit)的 packet 更新数;`SceneUpdate`/`ResourcePrepare`
    /// 环的 coverage 分母。
    packet_updates: u64,
    /// 已提交的 Deep2D staging 数;`Deep2dPrepare` 环的 coverage 分母。
    deep2d_updates: u64,
    late_samples: u64,
    window_started_at: Instant,
    last_presented_at: Option<Instant>,
    frame_intervals: SegmentRing,
    gpu_unavailable_reason: Option<&'static str>,
    gpu: Option<GpuFrameTiming>,
}

impl FrameTelemetry {
    pub fn for_device(device: &wgpu::Device, queue: &wgpu::Queue, device_epoch: u64) -> Self {
        let required =
            wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS;
        let supported = device.features().contains(required);
        Self {
            device_epoch,
            reset_generation: 0,
            rings: std::array::from_fn(|_| SegmentRing::new()),
            frames: FrameCounts::default(),
            packet_updates: 0,
            deep2d_updates: 0,
            late_samples: 0,
            window_started_at: Instant::now(),
            last_presented_at: None,
            frame_intervals: SegmentRing::new(),
            gpu_unavailable_reason: (!supported).then_some("timestamp_query_unsupported"),
            gpu: supported.then(|| GpuFrameTiming::new(device, queue, device_epoch)),
        }
    }

    pub fn begin_frame(&mut self) -> SampleToken {
        self.frames.attempted += 1;
        self.token()
    }

    pub fn record(&mut self, token: SampleToken, segment: CpuSegment, start: Option<Instant>) {
        let Some(start) = start else { return };
        if token != self.token() {
            self.late_samples += 1;
            return;
        }
        let ns = u64::try_from(start.elapsed().as_nanos()).unwrap_or(u64::MAX);
        self.rings[segment.index()].record(ns);
    }

    /// 记录一次已提交的 packet 更新的两段准备耗时。publish 只发生在渲染
    /// 线程当前 epoch(与帧路径同一 `&mut self` 借用点),无需帧 token
    /// 校验;失败被拒的 staging 不产生样本。
    pub fn record_packet_prepare(&mut self, scene_update_ns: u64, resource_upload_ns: u64) {
        self.packet_updates += 1;
        self.rings[CpuSegment::SceneUpdate.index()].record(scene_update_ns);
        self.rings[CpuSegment::ResourcePrepare.index()].record(resource_upload_ns);
    }

    /// 记录一次已提交的 Deep2D staging 准备耗时(文字/二维管线)。
    pub fn record_deep2d_prepare(&mut self, prepare_ns: u64) {
        self.deep2d_updates += 1;
        self.rings[CpuSegment::Deep2dPrepare.index()].record(prepare_ns);
    }

    pub fn finish_frame(&mut self, token: SampleToken, result: FrameResult) {
        if token != self.token() {
            self.late_samples += 1;
            return;
        }
        match result {
            FrameResult::Presented => {
                self.frames.presented += 1;
                let now = Instant::now();
                if let Some(previous) = self.last_presented_at.replace(now) {
                    self.frame_intervals.record(duration_ns(previous, now));
                }
            }
            FrameResult::Skipped => self.frames.skipped += 1,
            FrameResult::Recover => self.frames.recoveries += 1,
            FrameResult::Failed => self.frames.failed += 1,
        }
    }

    pub fn gpu_begin_frame(&mut self, token: SampleToken, encoder: &mut wgpu::CommandEncoder) {
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.begin_frame(token, encoder);
        }
    }

    pub fn gpu_begin(
        &self,
        segment: crate::telemetry_gpu::GpuSegment,
        encoder: &mut wgpu::CommandEncoder,
    ) {
        if let Some(gpu) = &self.gpu {
            gpu.begin(segment, encoder);
        }
    }

    pub fn gpu_end(
        &mut self,
        segment: crate::telemetry_gpu::GpuSegment,
        active: bool,
        encoder: &mut wgpu::CommandEncoder,
    ) {
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.end(segment, active, encoder);
        }
    }

    pub fn gpu_finish_frame(&mut self, token: SampleToken, encoder: &mut wgpu::CommandEncoder) {
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.finish_frame(token, encoder);
        }
    }

    pub fn reset_barrier(&mut self) {
        self.reset_generation = self.reset_generation.wrapping_add(1);
        self.frames = FrameCounts::default();
        self.packet_updates = 0;
        self.deep2d_updates = 0;
        self.late_samples = 0;
        self.window_started_at = Instant::now();
        self.last_presented_at = None;
        self.frame_intervals.clear();
        for ring in &mut self.rings {
            ring.clear();
        }
        let token = self.token();
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.reset(token);
        }
    }

    pub fn report(&self, device: &wgpu::Device, queue: &wgpu::Queue) -> serde_json::Value {
        let mut cpu = BTreeMap::new();
        for segment in CpuSegment::ALL {
            let expected = match segment {
                CpuSegment::Acquire => self.frames.attempted,
                // Packet 级细分按"已提交更新数"计 coverage,不与帧混淆。
                CpuSegment::SceneUpdate | CpuSegment::ResourcePrepare => self.packet_updates,
                CpuSegment::Deep2dPrepare => self.deep2d_updates,
                _ => self.frames.presented,
            };
            cpu.insert(
                segment.name(),
                self.rings[segment.index()].snapshot(expected),
            );
        }
        let gpu = self.gpu.as_ref().map_or_else(
            || {
                GpuReadback::degraded(
                    self.gpu_unavailable_reason
                        .unwrap_or("timestamp_query_unavailable"),
                )
            },
            |timing| timing.readback(device, queue, self.token()),
        );
        let benchmark_sample_window = sample_window::build(
            format!(
                "native.device-{}.reset-{}",
                self.device_epoch, self.reset_generation
            ),
            self.window_started_at.elapsed().as_secs_f64() * 1_000.0,
            self.rings[CpuSegment::SubmitPresent.index()]
                .samples
                .iter()
                .copied(),
            self.frame_intervals.samples.iter().copied(),
            self.rings[CpuSegment::SceneUpdate.index()]
                .samples
                .iter()
                .copied(),
            self.rings[CpuSegment::ResourcePrepare.index()]
                .samples
                .iter()
                .copied(),
            &gpu,
        );
        serde_json::json!({
            "schema": "deep-engine.native-telemetry", "version": 1,
            "device_epoch": self.device_epoch, "reset_generation": self.reset_generation,
            "window_capacity": RING_CAPACITY, "frames": self.frames,
            "packet_updates": self.packet_updates, "deep2d_updates": self.deep2d_updates,
            "late_cpu_samples": self.late_samples, "cpu": cpu, "gpu": gpu,
            "benchmark_sample_window": benchmark_sample_window,
        })
    }

    fn token(&self) -> SampleToken {
        SampleToken {
            device_epoch: self.device_epoch,
            reset_generation: self.reset_generation,
        }
    }
}

fn duration_ns(start: Instant, end: Instant) -> u64 {
    u64::try_from(end.duration_since(start).as_nanos()).unwrap_or(u64::MAX)
}

pub(crate) fn stats_from(
    samples: impl Iterator<Item = u64>,
    dropped: u64,
    expected: u64,
) -> SegmentStats {
    let mut sorted = samples.collect::<Vec<_>>();
    sorted.sort_unstable();
    let at = |fraction: usize| -> u64 {
        if sorted.is_empty() {
            return 0;
        }
        let index = (sorted.len() * fraction).div_ceil(100).saturating_sub(1);
        sorted[index.min(sorted.len() - 1)]
    };
    SegmentStats {
        samples: sorted.len(),
        dropped,
        coverage_ppm: if expected == 0 {
            0
        } else {
            (sorted.len() as u64)
                .saturating_mul(1_000_000)
                .checked_div(expected)
                .unwrap_or(0)
                .min(1_000_000)
        },
        p50_ns: at(50),
        p95_ns: at(95),
        p99_ns: at(99),
        max_ns: sorted.last().copied().unwrap_or(0),
    }
}

#[cfg(test)]
#[path = "telemetry_tests.rs"]
mod tests;
