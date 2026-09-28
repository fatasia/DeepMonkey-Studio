//! T14 动画 clip 事件收集的 Native 同语义镜像。
//!
//! TS 合同（只读规范，勿在 Rust 侧另行演化语义）：
//! `packages/deep-engine/src/gltf/renderAnimationEvents.ts`。逐条对齐的语义：
//! - 事件集合为未包裹时间线上 `(from, to]` 的发生时刻，闭右端；
//! - 按未包裹时间序 + 注册序稳定排序，同输入同序列；
//! - 仅前进（step > 0）发射；截断（默认 1024/update）丢弃、绝不延后重放。
//!
//! 播放时钟镜像见 `native_animation_playback_clock`；宿主接线：标记集来自
//! 运行包 `animationController.events`（已 fail-closed 校验），clip 时长与
//! 活动 clip 由持有导入模型采样数据的宿主提供。所有数值走 `f64`，与 TS
//! `Number` 同精度，跨端对拍见 `native_animation_events_tests`。

use std::fmt;

use crate::runtime_package::DynamicAnimationEventMarker;

/// 与 TS `TIME_EPSILON` 同值：边界闭右端与整圈判定的容差。
pub const TIME_EPSILON: f64 = 1e-9;
/// 与 TS `DEFAULT_MAX_EVENTS_PER_UPDATE` 同值。
pub const DEFAULT_MAX_EVENTS_PER_UPDATE: usize = 1024;

/// 跨端共享的错误码：镜像 TS `GltfRenderAnimationBridgeError("invalid-time")`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeAnimationTimeError(pub &'static str);

impl fmt::Display for NativeAnimationTimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid-time: {}", self.0)
    }
}

impl std::error::Error for NativeAnimationTimeError {}

/// 跨边界命中的事件。语义与 TS `GltfAnimationEvent` 一致：
/// `unwrapped_time = marker.time + loop * duration`。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NativeAnimationEvent<'a> {
    pub clip_id: &'a str,
    pub event_id: &'a str,
    pub unwrapped_time: f64,
    pub r#loop: u64,
}

/// 一次结算的事件批次；`truncated` 表示本 update 超限丢弃（绝不延后）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NativeAnimationEventBatch<'a> {
    pub events: Vec<NativeAnimationEvent<'a>>,
    pub truncated: bool,
}

impl<'a> NativeAnimationEventBatch<'a> {
    pub fn empty() -> Self {
        Self::default()
    }
}

/// 镜像 TS `collectClipEvents`：收集活动 clip 上落在 `(from, to]` 的发生时刻。
/// 仅 `to > from` 的前进收集；同刻按注册序稳定排序；超过 `limit` 即截断。
/// TS 在截断后丢弃当前 marker 的后续发生并停止收集后续 marker（外层
/// `!truncated` 条件），此处 `truncated` 提前退出为同语义。
pub fn collect_clip_events<'a>(
    markers: &'a [DynamicAnimationEventMarker],
    active_clip_id: Option<&str>,
    duration: f64,
    from: f64,
    to: f64,
    limit: usize,
) -> NativeAnimationEventBatch<'a> {
    let mut batch = NativeAnimationEventBatch::empty();
    let Some(active) = active_clip_id else {
        return batch;
    };
    if !(to > from) || !(duration > 0.0) || markers.is_empty() {
        return batch;
    }
    let mut collected: Vec<(NativeAnimationEvent<'a>, usize)> = Vec::new();
    let mut truncated = false;
    for (order, marker) in markers.iter().enumerate() {
        if truncated {
            break;
        }
        if marker.clip_id != active {
            continue;
        }
        let mut occurrence = marker.time + ((from - marker.time) / duration).ceil() * duration;
        while occurrence <= from {
            occurrence += duration;
        }
        while occurrence <= to + TIME_EPSILON {
            if collected.len() >= limit {
                truncated = true;
                break;
            }
            let r#loop = ((occurrence - marker.time) / duration).round() as u64;
            collected.push((
                NativeAnimationEvent {
                    clip_id: marker.clip_id.as_str(),
                    event_id: marker.event_id.as_str(),
                    unwrapped_time: occurrence,
                    r#loop,
                },
                order,
            ));
            occurrence += duration;
        }
    }
    if collected.is_empty() {
        return batch;
    }
    collected.sort_by(|(left, left_order), (right, right_order)| {
        left.unwrapped_time
            .partial_cmp(&right.unwrapped_time)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(left_order.cmp(right_order))
    });
    batch.events = collected.into_iter().map(|(event, _)| event).collect();
    batch.truncated = truncated;
    batch
}
