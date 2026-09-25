//! Opt-in, fixed-window telemetry for one native renderer/device epoch.

use std::collections::BTreeMap;
use web_time::Instant;

use serde::Serialize;

use crate::telemetry_gpu::{GpuFrameTiming, GpuReadback, GpuSegment};

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
    /// R4 生产接线:MSAA 深度 resolve → HiZ 金字塔(提取 render pass +
    /// DCIR 缩减链)。开关关闭时保持零样本。
    HiZ,
}

impl CpuSegment {
    const ALL: [Self; 12] = [
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
        Self::HiZ,
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
            Self::HiZ => "hi_z",
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

#[derive(Default)]
struct StageActivity {
    executed_frames: u64,
    skipped_frames: u64,
    skip_reasons: BTreeMap<&'static str, u64>,
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
    submitted_frames: u64,
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
    stage_activity: [StageActivity; GpuSegment::ALL.len()],
    current_stage_mask: u8,
    current_skip_reasons: [Option<&'static str>; GpuSegment::ALL.len()],
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
            submitted_frames: 0,
            packet_updates: 0,
            deep2d_updates: 0,
            late_samples: 0,
            window_started_at: Instant::now(),
            last_presented_at: None,
            frame_intervals: SegmentRing::new(),
            gpu_unavailable_reason: (!supported).then_some("timestamp_query_unsupported"),
            gpu: supported.then(|| GpuFrameTiming::new(device, queue, device_epoch)),
            stage_activity: std::array::from_fn(|_| StageActivity::default()),
            current_stage_mask: 0,
            current_skip_reasons: [None; GpuSegment::ALL.len()],
        }
    }

    pub fn begin_frame(&mut self) -> SampleToken {
        self.frames.attempted += 1;
        self.current_stage_mask = 0;
        self.current_skip_reasons = [None; GpuSegment::ALL.len()];
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
        self.mark_stage_executed(GpuSegment::Frame);
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
        skip_reason: Option<&'static str>,
        encoder: &mut wgpu::CommandEncoder,
    ) {
        if active {
            self.mark_stage_executed(segment);
        } else {
            self.mark_stage_skipped(segment, skip_reason.unwrap_or("inactive_segment"));
        }
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.end(segment, active, encoder);
        }
    }

    /// 并行编码路径:只做帧记账,Frame 起点时间戳延迟到实际承载帧工作
    /// 的第一条 command buffer(pre CB 或首个级联 CB)写入。
    pub fn gpu_begin_frame_deferred(&mut self, token: SampleToken) {
        self.mark_stage_executed(GpuSegment::Frame);
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.begin_frame_deferred(token);
        }
    }

    /// 跨线程时间戳句柄:并行段(如阴影级联)的起止时间戳写进各自的
    /// command buffer,保持 GPU 时间线语义与串行一致。
    pub fn gpu_segment_stamper(&self) -> Option<crate::telemetry_gpu::GpuSegmentStamper<'_>> {
        self.gpu.as_ref().map(|gpu| gpu.stamper())
    }

    /// 并行段只翻活跃掩码,不写时间戳(时间戳已由 stamper 写在级联 CB)。
    pub fn gpu_mark_segment(&mut self, segment: crate::telemetry_gpu::GpuSegment, active: bool) {
        if active {
            self.mark_stage_executed(segment);
        } else {
            self.mark_stage_skipped(segment, "inactive_segment");
        }
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.mark(segment, active);
        }
    }

    pub fn gpu_finish_frame(&mut self, token: SampleToken, encoder: &mut wgpu::CommandEncoder) {
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.finish_frame(token, encoder);
        }
    }

    /// Commit this frame's stage observations after the renderer successfully
    /// submits the command buffers that contain those stages.
    pub fn gpu_submitted_frame(&mut self) {
        self.submitted_frames += 1;
        self.record_stage_activity();
    }

    pub fn reset_barrier(&mut self) {
        self.reset_generation = self.reset_generation.wrapping_add(1);
        self.frames = FrameCounts::default();
        self.submitted_frames = 0;
        self.packet_updates = 0;
        self.deep2d_updates = 0;
        self.late_samples = 0;
        self.window_started_at = Instant::now();
        self.last_presented_at = None;
        self.frame_intervals.clear();
        self.stage_activity = std::array::from_fn(|_| StageActivity::default());
        self.current_stage_mask = 0;
        self.current_skip_reasons = [None; GpuSegment::ALL.len()];
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
        let frame_pass_receipt =
            frame_pass_receipt(self.submitted_frames, &self.stage_activity, &gpu);
        serde_json::json!({
            "schema": "deep-engine.native-telemetry", "version": 1,
            "device_epoch": self.device_epoch, "reset_generation": self.reset_generation,
            "window_capacity": RING_CAPACITY, "frames": self.frames,
            "submitted_frames": self.submitted_frames,
            "packet_updates": self.packet_updates, "deep2d_updates": self.deep2d_updates,
            "late_cpu_samples": self.late_samples, "cpu": cpu, "gpu": gpu,
            "benchmark_sample_window": benchmark_sample_window,
            "frame_pass_receipt": frame_pass_receipt,
        })
    }

    fn mark_stage_executed(&mut self, segment: GpuSegment) {
        let index = segment.index();
        self.current_stage_mask |= 1 << index;
        self.current_skip_reasons[index] = None;
    }

    fn mark_stage_skipped(&mut self, segment: GpuSegment, reason: &'static str) {
        let index = segment.index();
        if self.current_stage_mask & (1 << index) == 0 {
            self.current_skip_reasons[index] = Some(reason);
        }
    }

    fn record_stage_activity(&mut self) {
        for segment in GpuSegment::ALL {
            let index = segment.index();
            let activity = &mut self.stage_activity[index];
            if self.current_stage_mask & (1 << index) != 0 {
                activity.executed_frames += 1;
            } else {
                activity.skipped_frames += 1;
                *activity
                    .skip_reasons
                    .entry(self.current_skip_reasons[index].unwrap_or("stage_not_observed"))
                    .or_default() += 1;
            }
        }
    }

    fn token(&self) -> SampleToken {
        SampleToken {
            device_epoch: self.device_epoch,
            reset_generation: self.reset_generation,
        }
    }
}

fn frame_pass_receipt(
    submitted_frames: u64,
    activity: &[StageActivity; GpuSegment::ALL.len()],
    gpu: &GpuReadback,
) -> serde_json::Value {
    let stages = GpuSegment::ALL
        .into_iter()
        .enumerate()
        .map(|(index, segment)| {
            let activity = &activity[index];
            let execution_status = match (activity.executed_frames, activity.skipped_frames) {
                (0, 0) => "unobserved",
                (executed, 0) if executed == submitted_frames => "executed",
                (0, skipped) if skipped == submitted_frames => "skipped",
                (executed, skipped) if executed + skipped == submitted_frames => "mixed",
                _ => "partial",
            };
            let timing = match gpu.segments.get(segment.name()) {
                Some(stats) if stats.samples > 0 => serde_json::json!({
                    "availability": "measured",
                    "sampleCount": stats.samples,
                    "p50Ns": stats.p50_ns,
                    "p95Ns": stats.p95_ns,
                    "p99Ns": stats.p99_ns,
                    "maxNs": stats.max_ns,
                }),
                _ => {
                    let reason = if activity.executed_frames == 0 {
                        "stage_not_executed_in_window".to_owned()
                    } else {
                        gpu.reason.clone().unwrap_or_else(|| {
                            if gpu.samples > 0 {
                                "no_stage_timestamp_samples_in_window".to_owned()
                            } else {
                                "no_gpu_timestamp_samples_in_window".to_owned()
                            }
                        })
                    };
                    serde_json::json!({
                        "availability": "unavailable",
                        "sampleCount": 0,
                        "reason": reason,
                    })
                }
            };
            serde_json::json!({
                "id": segment.name(),
                "execution": {
                    "status": execution_status,
                    "executedFrames": activity.executed_frames,
                    "skippedFrames": activity.skipped_frames,
                    "skipReasons": activity.skip_reasons,
                },
                "timing": timing,
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "schema": "deep-engine.native-frame-pass-receipt",
        "version": 1,
        "submittedFrames": submitted_frames,
        "stages": stages,
    })
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
