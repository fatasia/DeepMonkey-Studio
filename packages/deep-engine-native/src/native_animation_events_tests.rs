//! T14 动画事件边界矩阵的 Rust 侧重测 + TS↔Rust 跨端确定性对照。
//!
//! 向量全部取自 TS 报告（`docs/reports/deep-core/T14-implementation.md`
//! "事件边界矩阵"小节）与 `renderAnimationEvents.test.ts` 的固定序列：
//! clip `walk`/`run` 时长 1.0 秒，标记集与更新序列逐项一致；跨端对拍口径为
//! `(eventId, unwrappedTime, loop)` 三元组（unwrappedTime 用精确可表示的
//! 二进制小数，f64 与 TS Number 同精度，允许 1e-9 容差比较）。

use crate::native_animation_events::{
    DEFAULT_MAX_EVENTS_PER_UPDATE, TIME_EPSILON, collect_clip_events,
};
use crate::native_animation_playback_clock::NativeAnimationPlaybackClock;
use crate::runtime_package::DynamicAnimationEventMarker;

fn marker(clip_id: &str, event_id: &str, time: f64) -> DynamicAnimationEventMarker {
    DynamicAnimationEventMarker {
        clip_id: clip_id.to_string(),
        event_id: event_id.to_string(),
        time,
    }
}

fn walk_markers() -> Vec<DynamicAnimationEventMarker> {
    vec![marker("walk", "half", 0.25), marker("walk", "late", 0.6)]
}

fn loop_clock(active: &str, duration: f64) -> NativeAnimationPlaybackClock {
    let mut clock = NativeAnimationPlaybackClock::default();
    clock.play(Some(active.to_string()), 0.0, duration, true, 1.0, false);
    clock
}

fn once_clock(active: &str, duration: f64) -> NativeAnimationPlaybackClock {
    let mut clock = NativeAnimationPlaybackClock::default();
    clock.play(Some(active.to_string()), 0.0, duration, false, 1.0, false);
    clock
}

/// 驱动一组 delta 并把事件结算汇总成跨端对拍字符串。
fn drive(
    clock: &mut NativeAnimationPlaybackClock,
    markers: &[DynamicAnimationEventMarker],
    deltas: &[f64],
) -> Vec<String> {
    deltas
        .iter()
        .map(|delta| {
            let plan = clock.plan_advance(*delta).unwrap();
            clock
                .settle(plan, markers, DEFAULT_MAX_EVENTS_PER_UPDATE)
                .events
                .iter()
                .map(|event| {
                    format!(
                        "{}/{}@{}#{}",
                        event.clip_id, event.event_id, event.unwrapped_time, event.r#loop
                    )
                })
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect()
}

#[test]
fn normal_advances_emit_in_unwrapped_order_and_never_replay() {
    let markers = walk_markers();
    let mut clock = loop_clock("walk", 1.0);
    assert_eq!(
        drive(&mut clock, &markers, &[0.3, 0.3, 0.3, 0.29]),
        ["walk/half@0.25#0", "walk/late@0.6#0", "", ""]
    );
}

#[test]
fn one_large_delta_emits_one_event_per_crossed_loop() {
    let markers = vec![marker("walk", "half", 0.5)];
    let mut clock = loop_clock("walk", 1.0);
    assert_eq!(
        drive(&mut clock, &markers, &[3.5]),
        [format!(
            "walk/half@0.5#0,walk/half@1.5#1,walk/half@2.5#2,walk/half@3.5#3"
        )]
    );
    assert!((clock.unwrapped_time() - 3.5).abs() <= TIME_EPSILON);
    assert_eq!(drive(&mut clock, &markers, &[0.25]), [""]);
}

#[test]
fn wrap_boundary_marker_emits_exactly_once() {
    let markers = vec![marker("walk", "tick", 0.95)];
    let mut clock = loop_clock("walk", 1.0);
    assert_eq!(drive(&mut clock, &markers, &[0.9]), [""]);
    assert_eq!(drive(&mut clock, &markers, &[0.2]), ["walk/tick@0.95#0"]);
    assert!((clock.unwrapped_time() - 1.1).abs() <= TIME_EPSILON);
    assert_eq!(
        drive(&mut clock, &markers, &[1.9]),
        ["walk/tick@1.95#1,walk/tick@2.95#2"]
    );
}

#[test]
fn forward_seek_skips_and_backward_seek_rearms() {
    let markers = walk_markers();
    let mut clock = loop_clock("walk", 1.0);
    assert_eq!(drive(&mut clock, &markers, &[0.4]), ["walk/half@0.25#0"]);
    clock.seek(0.9);
    assert_eq!(drive(&mut clock, &markers, &[0.05]), [""]);
    clock.seek(0.1);
    assert_eq!(drive(&mut clock, &markers, &[0.2]), ["walk/half@0.25#0"]);
}

#[test]
fn zero_deltas_settle_nothing_without_moving_the_watermark() {
    let markers = vec![marker("walk", "half", 0.25)];
    let mut clock = loop_clock("walk", 1.0);
    assert_eq!(drive(&mut clock, &markers, &[0.0, 0.0, 0.0]), ["", "", ""]);
    assert!((clock.unwrapped_time() - 0.0).abs() <= TIME_EPSILON);
    assert_eq!(drive(&mut clock, &markers, &[0.3]), ["walk/half@0.25#0"]);
}

#[test]
fn negative_delta_fails_before_touching_state() {
    let markers = vec![marker("walk", "half", 0.25)];
    let mut clock = loop_clock("walk", 1.0);
    let error = clock.plan_advance(-1.0).unwrap_err();
    assert_eq!(error.0, "Animation frame delta is invalid.");
    assert!((clock.unwrapped_time() - 0.0).abs() <= TIME_EPSILON);
    assert_eq!(drive(&mut clock, &markers, &[0.3]), ["walk/half@0.25#0"]);
}

#[test]
fn negative_time_scale_emits_nothing_and_rearms_on_forward_replay() {
    let markers = vec![marker("walk", "half", 0.25)];
    let mut clock = loop_clock("walk", 1.0);
    clock.set_time_scale(-1.0);
    assert_eq!(drive(&mut clock, &markers, &[0.5]), [""]);
    assert!((clock.unwrapped_time() + 0.5).abs() <= TIME_EPSILON);
    clock.set_time_scale(1.0);
    assert_eq!(drive(&mut clock, &markers, &[1.0]), ["walk/half@0.25#0"]);
}

#[test]
fn once_playback_holds_at_the_terminal_and_stops_emitting() {
    let markers = vec![marker("walk", "tick", 0.95)];
    let mut clock = once_clock("walk", 1.0);
    assert_eq!(drive(&mut clock, &markers, &[0.5]), [""]);
    assert_eq!(drive(&mut clock, &markers, &[0.5]), ["walk/tick@0.95#0"]);
    assert_eq!(drive(&mut clock, &markers, &[0.5]), [""]);
    assert!((clock.unwrapped_time() - 1.0).abs() <= TIME_EPSILON);
    // 持停后再推进不产生新计划（终端钳制使 to == from）。
    assert!(clock.plan_advance(0.5).unwrap().is_none());
}

#[test]
fn paused_updates_emit_nothing_and_resume_hits_once() {
    let markers = vec![marker("walk", "half", 0.5)];
    let mut clock = loop_clock("walk", 1.0);
    clock.pause();
    assert!(clock.plan_advance(0.5).unwrap().is_none());
    clock.resume();
    assert_eq!(drive(&mut clock, &markers, &[0.5]), ["walk/half@0.5#0"]);
    assert_eq!(drive(&mut clock, &markers, &[0.5]), [""]);
}

#[test]
fn bursts_past_the_cap_truncate_deterministically() {
    let markers = vec![marker("walk", "a", 0.25), marker("walk", "b", 0.5)];
    let mut clock = loop_clock("walk", 1.0);
    let plan = clock.plan_advance(900.0).unwrap();
    let batch = clock.settle(plan, &markers, DEFAULT_MAX_EVENTS_PER_UPDATE);
    assert!(batch.truncated);
    assert_eq!(batch.events.len(), 1024);
    assert_eq!(
        (
            batch.events[0].event_id,
            batch.events[0].unwrapped_time,
            batch.events[0].r#loop
        ),
        ("a", 0.25, 0)
    );
    assert_eq!(
        (
            batch.events[1023].event_id,
            batch.events[1023].unwrapped_time,
            batch.events[1023].r#loop
        ),
        ("a", 899.25, 899)
    );
    assert_eq!(
        batch
            .events
            .iter()
            .filter(|event| event.event_id == "b")
            .count(),
        124
    );
}

#[test]
fn switching_the_active_clip_moves_the_event_line_like_a_cross_fade() {
    let markers = vec![
        marker("walk", "walkHalf", 0.25),
        marker("run", "runHalf", 0.5),
    ];
    let mut clock = loop_clock("walk", 1.0);
    assert_eq!(
        drive(&mut clock, &markers, &[0.4]),
        ["walk/walkHalf@0.25#0"]
    );
    // crossFade：play() 携带目标 clip 与重置后的 playhead 一起提交。
    clock.play(Some("run".to_string()), 0.0, 1.0, true, 1.0, false);
    assert_eq!(drive(&mut clock, &markers, &[0.6]), ["run/runHalf@0.5#0"]);
}

#[test]
fn identical_update_sequences_produce_identical_event_sequences() {
    let markers = walk_markers();
    let first = drive(
        &mut loop_clock("walk", 1.0),
        &markers,
        &[0.3, 0.4, 1.2, 0.0, 0.3],
    );
    let second = drive(
        &mut loop_clock("walk", 1.0),
        &markers,
        &[0.3, 0.4, 1.2, 0.0, 0.3],
    );
    assert_eq!(first, second);
}

/// 跨端对照：与 `renderAnimationEvents.test.ts` 相同标记集与播放序列的
/// TS 事件序列逐项一致（eventId/unwrappedTime/loop）。
#[test]
fn cross_end_vectors_match_the_ts_contract_sequence_for_sequence() {
    // TS 用例 1：markers(half@0.25, late@0.6)，drive(0.3, 0.3, 0.3, 0.29)。
    let markers = walk_markers();
    let mut clock = loop_clock("walk", 1.0);
    assert_eq!(
        drive(&mut clock, &markers, &[0.3, 0.3, 0.3, 0.29]),
        ["walk/half@0.25#0", "walk/late@0.6#0", "", ""]
    );
    // TS 用例 2：marker(half@0.5)，update(3.5) 跨 4 圈，随后 0.25 无重放。
    let markers = vec![marker("walk", "half", 0.5)];
    let mut clock = loop_clock("walk", 1.0);
    assert_eq!(
        drive(&mut clock, &markers, &[3.5, 0.25]),
        [
            "walk/half@0.5#0,walk/half@1.5#1,walk/half@2.5#2,walk/half@3.5#3",
            ""
        ]
    );
    // TS 用例 3：marker(tick@0.95)，0.9 → 0.2（回绕恰一次）→ 1.9（两圈）。
    let markers = vec![marker("walk", "tick", 0.95)];
    let mut clock = loop_clock("walk", 1.0);
    assert_eq!(
        drive(&mut clock, &markers, &[0.9, 0.2, 1.9]),
        ["", "walk/tick@0.95#0", "walk/tick@1.95#1,walk/tick@2.95#2"]
    );
    // TS 用例 4：seek 前跳不发射、后跳重新武装。
    let markers = walk_markers();
    let mut clock = loop_clock("walk", 1.0);
    assert_eq!(drive(&mut clock, &markers, &[0.4]), ["walk/half@0.25#0"]);
    clock.seek(0.9);
    clock.seek(0.1);
    assert_eq!(drive(&mut clock, &markers, &[0.2]), ["walk/half@0.25#0"]);
}

/// 纯函数口径直测：`(from, to]` 闭右端——恰好落在 `to` 的发生发射一次，
/// 下一 update 的区间从 `to` 严格之后开始，不再重放。
#[test]
fn collect_range_is_right_closed_and_never_replays_the_boundary() {
    let markers = vec![marker("walk", "tick", 0.3)];
    let first = collect_clip_events(&markers, Some("walk"), 1.0, 0.0, 0.3, 1024);
    assert_eq!(first.events.len(), 1);
    assert_eq!(
        (first.events[0].unwrapped_time, first.events[0].r#loop),
        (0.3, 0)
    );
    let second = collect_clip_events(&markers, Some("walk"), 1.0, 0.3, 0.6, 1024);
    assert_eq!(second.events, Vec::new());
    // 空区间与非前进步长不收集；无活动 clip 不收集。
    assert!(
        collect_clip_events(&markers, Some("walk"), 1.0, 0.3, 0.3, 1024)
            .events
            .is_empty()
    );
    assert!(
        collect_clip_events(&markers, None, 1.0, 0.0, 0.5, 1024)
            .events
            .is_empty()
    );
    // 他 clip 标记不发射。
    let others = vec![marker("run", "elsewhere", 0.4)];
    assert!(
        collect_clip_events(&others, Some("walk"), 1.0, 0.0, 0.5, 1024)
            .events
            .is_empty()
    );
}
