//! J3-E Native 窗口事件 / present 计时 support 骨架 —— 仅 CPU 结构与纯校验，未接线、无 GPU 调用，
//! 刻意不引用 wgpu/winit/NativeApp，保证 `cargo check --tests` 无 GPU 装配可编译。
//! 待接线（GPU 线执行，方案与命令见 docs/specs/j3-e-gpu-runner-prep-20261001.md）：
//! 1. `src/app/device_loss_probe_tests.rs` 家族新增 `j3_gate_e_window_events_present` probe，
//!    复用 `DEEP_WINDOW_LOSS_CHILD` 子进程装配与 `J3_WINDOW_NATIVE_OUTPUT` 证据环境。
//! 2. `RenderOutcome::Presented` 返回处 `record(Presented, renderer.id())`（非提交、非读回）。
//! 3. `app::recovery::handle` 消费 `GpuEvent::DeviceLost` 后 `record(DeviceLostCallback, id)`；
//!    `recovery_retry::ready(id)` 处 `record(RecoveryCandidateCreated, id)`，恢复候选
//!    Presented 后 `record(RecoveryPresented, id)`。
//! 4. 旧 id 合成事件被过滤拒绝后 `record(StaleEventRejected, old_id)`。
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

/// 一条窗口事件；`renderer_id` 是该事件归属的生产 renderer id（旧 id 事件须被过滤后才记录为拒绝）。
#[derive(Debug, Clone)]
pub struct WindowEventRecord {
    pub kind: WindowEventKind,
    pub renderer_id: u64,
    /// 自 probe 起点起的 host-monotonic 墙钟；不是 GPU timestamp，不是 HDR 读回时刻。
    pub at: Duration,
}

/// 事件时间线；probe 在 NativeApp 事件循环的接线点顺序调用 [`WindowEventTimeline::record`]。
pub struct WindowEventTimeline {
    started: Instant,
    records: Vec<WindowEventRecord>,
}

impl WindowEventTimeline {
    pub fn start() -> Self {
        Self {
            started: Instant::now(),
            records: Vec::new(),
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

    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// 真实 present 时刻（毫秒，自窗口创建起）：含丢失前的 `Presented` 与恢复后的
    /// `RecoveryPresented`，供证据 JSON 的 `presentOffsetsMs` 字段直接使用。
    pub fn present_offsets_ms(&self) -> Vec<u128> {
        self.records
            .iter()
            .filter(|record| {
                matches!(
                    record.kind,
                    WindowEventKind::Presented | WindowEventKind::RecoveryPresented
                )
            })
            .map(|record| record.at.as_millis())
            .collect()
    }
}

/// 预注册期望；与矩阵 runner（scripts/lib/j3UnknownLossMatrix.mjs）逐 cell 对齐。
#[derive(Debug, Clone, Copy)]
pub struct WindowEventExpectations {
    pub loss_callbacks: u32,
    pub require_recovery_present: bool,
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

/// 纯 CPU 校验时间线是否符合预注册期望；任何不符返回 Err（不静默降级、不粉饰）。
pub fn validate_window_events(
    timeline: &WindowEventTimeline,
    old_id: u64,
    new_id: u64,
    expectations: &WindowEventExpectations,
) -> Result<WindowEventFindings, String> {
    if let Some(record) = timeline.records().first() {
        if record.kind != WindowEventKind::WindowCreated || record.renderer_id != old_id {
            return Err(format!(
                "expected WindowCreated({old_id}) first, got {record:?}"
            ));
        }
    }
    let mut previous = Duration::ZERO;
    for record in timeline.records() {
        if record.at < previous {
            return Err(format!("non-monotonic window event timeline: {record:?}"));
        }
        previous = record.at;
    }
    let loss = timeline
        .records()
        .iter()
        .filter(|record| record.kind == WindowEventKind::DeviceLostCallback)
        .count() as u32;
    if loss != expectations.loss_callbacks {
        return Err(format!(
            "expected {} lost callbacks, got {loss}",
            expectations.loss_callbacks
        ));
    }
    let mut presents_before_loss = 0usize;
    let mut presents_after_recovery = 0usize;
    let mut recovery_duration = None;
    let mut lost_at = None;
    for record in timeline.records() {
        match record.kind {
            WindowEventKind::Presented if lost_at.is_none() => {
                if record.renderer_id != old_id {
                    return Err(format!(
                        "pre-loss present from {}: {record:?}",
                        record.renderer_id
                    ));
                }
                presents_before_loss += 1;
            }
            WindowEventKind::DeviceLostCallback => {
                if record.renderer_id != old_id {
                    return Err(format!(
                        "lost callback id != destroyed {old_id}: {record:?}"
                    ));
                }
                lost_at = Some(record.at);
            }
            WindowEventKind::RecoveryCandidateCreated => {
                if record.renderer_id == old_id {
                    return Err("recovery candidate must be a new renderer id".to_string());
                }
                if new_id != 0 && record.renderer_id != new_id {
                    return Err(format!(
                        "candidate {} != expected {new_id}",
                        record.renderer_id
                    ));
                }
            }
            WindowEventKind::RecoveryPresented => {
                if record.renderer_id == old_id {
                    return Err("recovery present must come from the new renderer".to_string());
                }
                if let Some(lost) = lost_at {
                    recovery_duration = Some(record.at.saturating_sub(lost));
                }
                presents_after_recovery += 1;
            }
            _ => {}
        }
    }
    if presents_before_loss == 0 {
        return Err("no real present was recorded before the loss".to_string());
    }
    if expectations.require_recovery_present && presents_after_recovery == 0 {
        return Err("recovery present expected but absent".to_string());
    }
    let stale_rejections = timeline
        .records()
        .iter()
        .filter(|record| record.kind == WindowEventKind::StaleEventRejected)
        .count() as u32;
    if stale_rejections == 0 {
        return Err("stale-event negative control was not recorded".to_string());
    }
    let total = timeline.elapsed();
    if total > expectations.timeout {
        return Err(format!("probe exceeded timeout: {total:?}"));
    }
    Ok(WindowEventFindings {
        presents_before_loss,
        presents_after_recovery,
        loss_callbacks: loss,
        stale_rejections,
        recovery_duration,
        total,
    })
}

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
mod j3_window_events_cpu_tests {
    use super::*;

    const BASE: &[(WindowEventKind, u64, u64)] = &[
        (WindowEventKind::WindowCreated, 1, 0),
        (WindowEventKind::Presented, 1, 5),
        (WindowEventKind::DeviceLostCallback, 1, 10),
        (WindowEventKind::RecoveryCandidateCreated, 2, 12),
        (WindowEventKind::RecoveryPresented, 2, 20),
        (WindowEventKind::StaleEventRejected, 1, 21),
    ];

    const EXPECT: WindowEventExpectations = WindowEventExpectations {
        loss_callbacks: 1,
        require_recovery_present: true,
        timeout: Duration::from_secs(45),
    };

    fn records(events: &[(WindowEventKind, u64, u64)]) -> Vec<WindowEventRecord> {
        events
            .iter()
            .map(|(kind, renderer_id, offset_ms)| WindowEventRecord {
                kind: *kind,
                renderer_id: *renderer_id,
                at: Duration::from_millis(*offset_ms),
            })
            .collect()
    }

    fn timeline(events: &[WindowEventRecord]) -> WindowEventTimeline {
        WindowEventTimeline {
            started: Instant::now(),
            records: events.to_vec(),
        }
    }

    #[test]
    fn certified_shape_passes_and_every_violation_is_rejected() {
        let findings = validate_window_events(&timeline(&records(BASE)), 1, 2, &EXPECT).unwrap();
        assert_eq!(findings.presents_before_loss, 1);
        assert_eq!(findings.presents_after_recovery, 1);
        assert_eq!(findings.recovery_duration, Some(Duration::from_millis(10)));
        assert_eq!(findings.stale_rejections, 1);
        let base = timeline(&records(BASE));
        assert_eq!(base.present_offsets_ms(), vec![5u128, 20]);
        assert!(validate_window_events(&timeline(&records(BASE)), 1, 2, &EXPECT).is_ok());
        /// 对 BASE 施加一处变异后必须以 needle 拒绝；不粉饰、不静默通过。
        fn reject_after(mutate: impl Fn(&mut Vec<WindowEventRecord>), needle: &str) {
            let mut events = records(BASE);
            mutate(&mut events);
            let needle_hint = "expected rejection, timeline passed";
            let error = validate_window_events(&timeline(&events), 1, 2, &EXPECT)
                .err()
                .unwrap_or_else(|| needle_hint.to_string());
            assert!(error.contains(needle), "expected '{needle}' in: {error}");
        }
        reject_after(|e| e[0].kind = WindowEventKind::Presented, "WindowCreated");
        reject_after(|e| drop(e.remove(4)), "recovery present expected"); // 缺恢复 present
        reject_after(|e| drop(e.remove(5)), "stale-event"); // 缺 stale 负例
        reject_after(|e| e[4].at = Duration::from_millis(3), "non-monotonic");
        reject_after(|e| e[2].renderer_id = 9, "lost callback id");
        reject_after(|e| e[3].renderer_id = 1, "new renderer id");
        reject_after(|e| e[4].renderer_id = 1, "must come from the new renderer");
    }
}
