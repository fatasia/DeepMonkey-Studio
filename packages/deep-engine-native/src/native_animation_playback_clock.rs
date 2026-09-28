//! T14 动画播放时钟的 Native 同语义镜像。
//!
//! TS 合同（只读规范）：`packages/deep-engine/src/gltf/renderAnimationPlaybackClock.ts`。
//! 把播放 playhead 镜像到未包裹时间线，逐条对齐的转移语义：
//! - `play` 与 TS 同语义：时长/模式/活动 clip 一起提交，未包裹时间按 wrap 归一化；
//! - `seek` 保持圈数、按目标时间重推基线（向前跳过不发射、向后倒带重新武装）；
//! - `plan_advance` 负/非有限/超界 delta 在触碰状态前报 `invalid-time`；
//!   负 timeScale 产生负步长：不发射事件、水位线随步回退；
//! - once 模式按方向敏感的终端钳制（TS `wrapTerminalBound`）持停；
//! - `settle` 提交计划并结算事件；`None` 计划或非前进步长不发射。
//!
//! 事件收集公式在 `native_animation_events`，本模块只承载状态转移。

use crate::native_animation_events::{
    NativeAnimationEventBatch, NativeAnimationTimeError, TIME_EPSILON, collect_clip_events,
};
use crate::runtime_package::DynamicAnimationEventMarker;

/// 一次前进计划（纯派生，不触碰时钟状态）。语义与 TS `ClockAdvancePlan` 一致。
#[derive(Debug, Clone, PartialEq)]
pub struct NativeAnimationAdvancePlan {
    pub from: f64,
    pub to: f64,
    pub step: f64,
    pub r#loop: u64,
    pub active_clip_id: Option<String>,
}

/// 镜像 TS `AnimationPlaybackClock`：状态由宿主逐字段喂入（活动 clip / 时长 /
/// loop-once / timeScale / paused），转移公式与 TS 时钟一致，镜像时间不漂移。
#[derive(Debug, Clone, PartialEq)]
pub struct NativeAnimationPlaybackClock {
    duration: f64,
    /// true = loop（TS wrapMode "loop"/playbackMode "loop"）；false = once（"clamp"/"once"）。
    loop_playback: bool,
    time_scale: f64,
    paused: bool,
    unwrapped: f64,
    active_clip_id: Option<String>,
}

impl NativeAnimationPlaybackClock {
    /// 与 TS `play(resolved)` 同语义：时长/模式/活动 clip 一起提交，
    /// 未包裹时间按 wrap 归一化重置。
    pub fn play(
        &mut self,
        active_clip_id: Option<String>,
        time: f64,
        duration: f64,
        loop_playback: bool,
        time_scale: f64,
        paused: bool,
    ) {
        self.duration = duration;
        self.loop_playback = loop_playback;
        self.time_scale = time_scale;
        self.paused = paused;
        self.active_clip_id = active_clip_id;
        self.unwrapped = normalize_wrap_time(time, duration, loop_playback);
    }

    /// 保持圈数、按目标时间重推未包裹基线（TS `seek`）。
    pub fn seek(&mut self, time: f64) {
        let wrapped = normalize_wrap_time(time, self.duration, self.loop_playback);
        let base = if self.duration > 0.0 {
            ((self.unwrapped + TIME_EPSILON) / self.duration).floor() * self.duration
        } else {
            0.0
        };
        self.unwrapped = base + wrapped;
    }

    pub fn set_time_scale(&mut self, value: f64) {
        self.time_scale = value;
    }

    pub fn pause(&mut self) {
        self.paused = true;
    }

    pub fn resume(&mut self) {
        self.paused = false;
    }

    pub fn unwrapped_time(&self) -> f64 {
        self.unwrapped
    }

    pub fn r#loop(&self) -> u64 {
        if self.duration > 0.0 {
            ((self.unwrapped + TIME_EPSILON) / self.duration).floor() as u64
        } else {
            0
        }
    }

    /// 纯计划：镜像 TS `planAdvance`。负/非有限/超界 delta 在触碰状态前返回
    /// `invalid-time`；暂停、零步长或 once 终端持停返回 `None`。
    pub fn plan_advance(
        &self,
        delta_seconds: f64,
    ) -> Result<Option<NativeAnimationAdvancePlan>, NativeAnimationTimeError> {
        // 镜像 TS `validateFrameDelta`。
        if !delta_seconds.is_finite() || delta_seconds < 0.0 || delta_seconds > 1_000_000.0 {
            return Err(NativeAnimationTimeError(
                "Animation frame delta is invalid.",
            ));
        }
        if self.paused {
            return Ok(None);
        }
        let step = delta_seconds * self.time_scale;
        if step == 0.0 {
            return Ok(None);
        }
        let from = self.unwrapped;
        let mut to = from + step;
        if !self.loop_playback && self.duration > 0.0 {
            to = if step > 0.0 {
                to.min(wrap_terminal_bound(from, self.duration, 1))
            } else {
                to.max(wrap_terminal_bound(from, self.duration, -1))
            };
        }
        if to == from {
            return Ok(None);
        }
        let r#loop = if self.duration > 0.0 {
            ((to + TIME_EPSILON) / self.duration).floor() as u64
        } else {
            0
        };
        Ok(Some(NativeAnimationAdvancePlan {
            from,
            to,
            step,
            r#loop,
            active_clip_id: self.active_clip_id.clone(),
        }))
    }

    /// 提交计划并结算事件（TS `settle`）。`None` 计划或非前进步长不发射；
    /// 负步长只回退水位线，后续前进会按倒带语义重新武装。
    pub fn settle<'a>(
        &mut self,
        plan: Option<NativeAnimationAdvancePlan>,
        markers: &'a [DynamicAnimationEventMarker],
        limit: usize,
    ) -> NativeAnimationEventBatch<'a> {
        let Some(plan) = plan else {
            return NativeAnimationEventBatch::empty();
        };
        self.unwrapped = plan.to;
        if plan.step <= 0.0 {
            return NativeAnimationEventBatch::empty();
        }
        collect_clip_events(
            markers,
            plan.active_clip_id.as_deref(),
            self.duration,
            plan.from,
            plan.to,
            limit,
        )
    }
}

impl Default for NativeAnimationPlaybackClock {
    fn default() -> Self {
        Self {
            duration: 0.0,
            loop_playback: true,
            time_scale: 1.0,
            paused: false,
            unwrapped: 0.0,
            active_clip_id: None,
        }
    }
}

/// 镜像 TS `normalizeWrapTime`：loop 取模、once（clamp）钳制、零时长归零。
fn normalize_wrap_time(time: f64, duration: f64, loop_playback: bool) -> f64 {
    if duration <= 0.0 {
        return 0.0;
    }
    if !loop_playback {
        return time.min(duration).max(0.0);
    }
    ((time % duration) + duration) % duration
}

/// 镜像 TS `wrapTerminalBound`：方向敏感的 once 终端钳制。整圈边界按方向区分
/// （未包裹 0 前进可跑满一圈、后退已在低端持停；其余整圈边界前进持停、后退松开）。
fn wrap_terminal_bound(time: f64, duration: f64, sign: i32) -> f64 {
    if duration <= 0.0 {
        return 0.0;
    }
    let revolutions = time / duration;
    let exact = revolutions.round();
    if (revolutions - exact).abs() * duration <= TIME_EPSILON {
        if exact == 0.0 {
            return if sign > 0 { duration } else { 0.0 };
        }
        return if sign > 0 {
            time
        } else {
            (revolutions - TIME_EPSILON).floor() * duration
        };
    }
    if sign > 0 {
        (revolutions - TIME_EPSILON).ceil() * duration
    } else {
        (revolutions + TIME_EPSILON).floor() * duration
    }
}
