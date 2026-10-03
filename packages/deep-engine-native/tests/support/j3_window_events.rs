//! J3-E Native 窗口事件 / present support：仅 std 的 CPU 结构与纯校验，无 GPU 调用。
//! `src/app/device_loss_probe_tests.rs` 的具名两 fresh probe 引用本模块；
//! redraw 的 Windows test-only observer 在真实 `RenderOutcome::Presented` 返回点记录事件与 span。
//! 计时口径：全部 host-monotonic 墙钟；禁止写 GPU timestamp；恢复时长只报告不设阈值。

use std::time::{Duration, Instant};

/// 窗口生命周期事件种类；与 `GpuEvent`/`WindowEvent` 解耦，probe 负责映射（见文件头接线点）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowEventKind {
    WindowCreated,
    Presented,
    DeviceLostCallback,
    RecoveryCandidateCreated,
    RecoveryPresented,
    StaleEventRejected,
}

impl WindowEventKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::WindowCreated => "window-created",
            Self::Presented => "presented",
            Self::DeviceLostCallback => "device-lost-callback",
            Self::RecoveryCandidateCreated => "recovery-candidate-created",
            Self::RecoveryPresented => "recovery-presented",
            Self::StaleEventRejected => "stale-event-rejected",
        }
    }
}

/// 一条窗口事件；`renderer_id` 是该事件归属的生产 renderer id（旧 id 事件须被过滤后才记录为拒绝）。
#[derive(Debug, Clone)]
pub struct WindowEventRecord {
    pub kind: WindowEventKind,
    pub renderer_id: u64,
    /// 自 probe 起点起的 host-monotonic 墙钟；不是 GPU timestamp，不是 HDR 读回时刻。
    pub at: Duration,
}

#[derive(Debug, Clone)]
pub struct WindowPresentSample {
    pub renderer_id: u64,
    pub kind: WindowEventKind,
    pub at: Duration,
    /// Renderer::render 墙钟 span，包括真实 surface present 返回，不包括后续 HDR 读回。
    pub duration: Duration,
}

/// 事件时间线；probe 在 NativeApp 事件循环的接线点顺序调用 [`WindowEventTimeline::record`]。
pub struct WindowEventTimeline {
    started: Instant,
    records: Vec<WindowEventRecord>,
    present_samples: Vec<WindowPresentSample>,
}

impl WindowEventTimeline {
    pub fn start() -> Self {
        Self {
            started: Instant::now(),
            records: Vec::new(),
            present_samples: Vec::new(),
        }
    }

    pub fn record(&mut self, kind: WindowEventKind, renderer_id: u64) {
        self.records.push(WindowEventRecord {
            kind,
            renderer_id,
            at: self.started.elapsed(),
        });
    }

    pub fn records(&self) -> &[WindowEventRecord] {
        &self.records
    }

    pub fn record_present(&mut self, kind: WindowEventKind, renderer_id: u64, duration: Duration) {
        assert!(matches!(
            kind,
            WindowEventKind::Presented | WindowEventKind::RecoveryPresented
        ));
        let at = self.started.elapsed();
        self.records.push(WindowEventRecord {
            kind,
            renderer_id,
            at,
        });
        self.present_samples.push(WindowPresentSample {
            renderer_id,
            kind,
            at,
            duration,
        });
    }

    pub fn present_samples(&self) -> &[WindowPresentSample] {
        &self.present_samples
    }

    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// 真实 present 时刻（毫秒，自窗口创建起）：含丢失前的 `Presented` 与恢复后的
    /// `RecoveryPresented`，供证据 JSON 的 `presentOffsetsMs` 字段直接使用。
    pub fn present_offsets_ms(&self) -> Vec<f64> {
        self.records
            .iter()
            .filter(|record| {
                matches!(
                    record.kind,
                    WindowEventKind::Presented | WindowEventKind::RecoveryPresented
                )
            })
            .map(|record| record.at.as_secs_f64() * 1_000.0)
            .collect()
    }
}

/// 预注册期望；与矩阵 runner（scripts/lib/j3UnknownLossMatrix.mjs）逐 cell 对齐。
#[derive(Debug, Clone, Copy)]
pub struct WindowEventExpectations {
    pub loss_callbacks: u32,
    pub require_recovery_present: bool,
    pub require_present_timing: bool,
    /// probe 总超时；沿既有 45s 预算口径。
    pub timeout: Duration,
}

#[derive(Debug)]
pub struct WindowEventFindings {
    pub presents_before_loss: usize,
    pub presents_after_recovery: usize,
    pub loss_callbacks: u32,
    pub stale_rejections: u32,
    pub recovery_duration: Option<Duration>,
    pub total: Duration,
}

#[path = "j3_window_events_validation.rs"]
mod validation;
pub use validation::validate_window_events;

/// 注入计划；与既有 destroy 注入 probe 同族，只描述刺激不执行注入。
#[derive(Debug, Clone, Copy)]
pub struct LossInjectionPlan {
    /// 旧 renderer 完成多少次真实 present 后销毁 device；0 = 恢复候选 Present 前再销毁。
    pub destroy_after_presents: u32,
    /// 期望 reason 片段，沿用既有 `reason.to_lowercase().contains` 口径。
    pub expected_reason_contains: &'static str,
    /// 首次候选创建注入的失败次数；0 = 一次性通过。
    pub injected_creation_failures: u8,
}

impl LossInjectionPlan {
    /// 对照行：destroyed 一次性重建（已验语义锁定）。
    #[rustfmt::skip]
    pub const DESTROYED: Self = Self { destroy_after_presents: 1, expected_reason_contains: "destroyed", injected_creation_failures: 0 };
    /// unknown + 首次创建失败注入（退避后第二次成功），对齐 unknown-retry-backoff 矩阵行。
    #[rustfmt::skip]
    pub const UNKNOWN_WITH_RETRY_FAILURE: Self = Self { destroy_after_presents: 1, expected_reason_contains: "unknown", injected_creation_failures: 1 };
    /// 候选创建成功、Present 前再丢：预算不清零，对齐 unknown-pre-present-loss 矩阵行。
    #[rustfmt::skip]
    pub const UNKNOWN_BEFORE_PRESENT: Self = Self { destroy_after_presents: 0, expected_reason_contains: "unknown", injected_creation_failures: 0 };
}

#[cfg(test)]
#[path = "j3_window_events_cpu_tests.rs"]
mod j3_window_events_cpu_tests;
