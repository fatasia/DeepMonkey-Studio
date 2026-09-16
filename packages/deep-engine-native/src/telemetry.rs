//! Opt-in, fixed-window telemetry for one native renderer/device epoch.

use std::{collections::BTreeMap, time::Instant};

use serde::Serialize;

use crate::telemetry_gpu::{GpuFrameTiming, GpuReadback};

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
}

impl CpuSegment {
    const ALL: [Self; 8] = [
        Self::Acquire,
        Self::SceneResources,
        Self::Shadow,
        Self::Opaque,
        Self::Transparent,
        Self::Deep2d,
        Self::Postprocess,
        Self::SubmitPresent,
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
    rings: [SegmentRing; 8],
    frames: FrameCounts,
    late_samples: u64,
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
            late_samples: 0,
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

    pub fn finish_frame(&mut self, token: SampleToken, result: FrameResult) {
        if token != self.token() {
            self.late_samples += 1;
            return;
        }
        match result {
            FrameResult::Presented => self.frames.presented += 1,
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
        self.late_samples = 0;
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
        serde_json::json!({
            "schema": "deep-engine.native-telemetry", "version": 1,
            "device_epoch": self.device_epoch, "reset_generation": self.reset_generation,
            "window_capacity": RING_CAPACITY, "frames": self.frames,
            "late_cpu_samples": self.late_samples, "cpu": cpu, "gpu": gpu,
        })
    }

    fn token(&self) -> SampleToken {
        SampleToken {
            device_epoch: self.device_epoch,
            reset_generation: self.reset_generation,
        }
    }
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
