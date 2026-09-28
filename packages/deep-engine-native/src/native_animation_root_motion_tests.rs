//! T14 根运动 Rust 镜像的语义测试：增量口径、环形历史、since 严格大于、
//! seek/回绕/0-前进语义与错误面。口径与 TS `renderAnimationRootMotion.test.ts`
//! 的结论逐条对齐（世界系增量、qPrev⁻¹ ⊗ qCurrent、如实的回绕不连续量）。

use crate::native_animation_root_motion::{
    DEFAULT_ROOT_MOTION_HISTORY, NativeRootMotionTracker, column_major_quaternion,
    column_major_translation, quaternion_delta,
};

/// 平移 `(x, y, z)` + 无旋转的列主序世界矩阵。
fn translation_matrix(x: f64, y: f64, z: f64) -> [f64; 16] {
    let mut matrix = [0.0; 16];
    matrix[0] = 1.0;
    matrix[5] = 1.0;
    matrix[10] = 1.0;
    matrix[15] = 1.0;
    matrix[12] = x;
    matrix[13] = y;
    matrix[14] = z;
    matrix
}

/// 绕 Y 轴旋转 `degrees` 的列主序世界矩阵（可带平移）。
fn yaw_matrix(degrees: f64, x: f64) -> [f64; 16] {
    let radians = degrees.to_radians();
    let (sin, cos) = radians.sin_cos();
    let mut matrix = [0.0; 16];
    matrix[0] = cos;
    matrix[2] = -sin;
    matrix[8] = sin;
    matrix[10] = cos;
    matrix[5] = 1.0;
    matrix[15] = 1.0;
    matrix[12] = x;
    matrix
}

fn new_tracker() -> NativeRootMotionTracker {
    NativeRootMotionTracker::new(DEFAULT_ROOT_MOTION_HISTORY).unwrap()
}

#[test]
fn translation_deltas_record_on_unwrapped_time_and_filter_strictly_greater() {
    let mut tracker = new_tracker();
    tracker
        .reset_baseline(&translation_matrix(0.0, 0.0, 0.0))
        .unwrap();
    tracker
        .record_advance(&translation_matrix(1.0, 0.0, 0.0), Some("walk"), 0.5, 0)
        .unwrap();
    tracker
        .record_advance(&translation_matrix(2.0, 0.0, 0.0), Some("walk"), 1.0, 1)
        .unwrap();
    assert_eq!(tracker.sample_count(), 2);
    let all = tracker.accumulate(f64::NEG_INFINITY).unwrap();
    assert_eq!(all.translation, [2.0, 0.0, 0.0]);
    assert_eq!(all.samples, 2);
    // 严格大于：since=0.5 只累计 unwrappedTime=1.0 的样本。
    let later = tracker.accumulate(0.5).unwrap();
    assert_eq!(later.translation, [1.0, 0.0, 0.0]);
    assert_eq!(later.samples, 1);
    assert!(tracker.accumulate(1.0).is_none());
}

#[test]
fn rotation_delta_is_world_space_inverse_conjugate_product() {
    let mut tracker = new_tracker();
    tracker.reset_baseline(&yaw_matrix(0.0, 0.0)).unwrap();
    let first = tracker
        .record_advance(&yaw_matrix(45.0, 0.0), Some("walk"), 0.5, 0)
        .unwrap()
        .unwrap();
    let second = tracker
        .record_advance(&yaw_matrix(90.0, 0.0), Some("walk"), 1.0, 0)
        .unwrap()
        .unwrap();
    // 各自增量为 45° yaw；累计 = 90° yaw。
    for sample in [first, second] {
        let half = (45.0_f64 / 2.0).to_radians();
        assert!(
            (sample.rotation[1] - half.sin()).abs() < 1e-12,
            "yaw+ got {:?}",
            sample.rotation
        );
        assert!((sample.rotation[3] - half.cos()).abs() < 1e-12);
    }
    let accumulated = tracker.accumulate(f64::NEG_INFINITY).unwrap();
    let quarter = (90.0_f64 / 2.0).to_radians();
    assert!((accumulated.rotation[1] - quarter.sin()).abs() < 1e-12);
    assert!((accumulated.rotation[3] - quarter.cos()).abs() < 1e-12);
}

#[test]
fn once_advances_accumulate_translation_like_the_ts_report() {
    // TS 报告：once 模式 0.5+0.5 → 累计 [2,0,0]。
    let mut tracker = new_tracker();
    tracker
        .reset_baseline(&translation_matrix(0.0, 0.0, 0.0))
        .unwrap();
    tracker
        .record_advance(&translation_matrix(1.0, 0.0, 0.0), Some("walk"), 0.5, 0)
        .unwrap();
    tracker
        .record_advance(&translation_matrix(2.0, 0.0, 0.0), Some("walk"), 1.0, 0)
        .unwrap();
    assert_eq!(
        tracker.accumulate(f64::NEG_INFINITY).unwrap().translation,
        [2.0, 0.0, 0.0]
    );
}

#[test]
fn wrap_frames_record_the_pose_discontinuity_and_a_full_cycle_nets_zero() {
    // 渲染 pose x = 2t（wrap 内）；0.75 → 1.25 跨回绕：1.5 → 0.5，增量 −1。
    let mut tracker = new_tracker();
    tracker
        .reset_baseline(&translation_matrix(1.5, 0.0, 0.0))
        .unwrap();
    let wrapped = tracker
        .record_advance(&translation_matrix(0.5, 0.0, 0.0), Some("walk"), 1.25, 1)
        .unwrap()
        .unwrap();
    assert_eq!(wrapped.translation, [-1.0, 0.0, 0.0]);
    // 整圈净值为零：x = t，四步恰好铺满一圈（末步跨回绕）。
    let mut tracker = new_tracker();
    tracker
        .reset_baseline(&translation_matrix(0.0, 0.0, 0.0))
        .unwrap();
    for (x, time, r#loop) in [
        (0.25, 0.25, 0),
        (0.5, 0.5, 0),
        (0.75, 0.75, 0),
        (0.0, 1.0, 1),
    ] {
        tracker
            .record_advance(&translation_matrix(x, 0.0, 0.0), Some("walk"), time, r#loop)
            .unwrap();
    }
    let cycle = tracker.accumulate(f64::NEG_INFINITY).unwrap();
    assert!(
        cycle.translation.iter().all(|value| value.abs() < 1e-12),
        "整圈净值应为零，got {:?}",
        cycle.translation
    );
}

#[test]
fn seek_rebaseline_records_no_jump_and_missing_baseline_records_nothing() {
    let mut tracker = new_tracker();
    // 无基线（TS：未配置/基线缺失）→ 前进不入账。
    assert!(
        tracker
            .record_advance(&translation_matrix(1.0, 0.0, 0.0), Some("walk"), 0.5, 0)
            .unwrap()
            .is_none()
    );
    tracker
        .reset_baseline(&translation_matrix(0.0, 0.0, 0.0))
        .unwrap();
    tracker
        .record_advance(&translation_matrix(1.0, 0.0, 0.0), Some("walk"), 0.5, 0)
        .unwrap();
    // seek 重整基线：瞬移不入账（样本数不变），新基线从目标 pose 起算。
    tracker
        .reset_baseline(&translation_matrix(9.0, 0.0, 0.0))
        .unwrap();
    assert_eq!(tracker.sample_count(), 1);
    tracker
        .record_advance(&translation_matrix(10.0, 0.0, 0.0), Some("walk"), 0.75, 0)
        .unwrap();
    let since_seek = tracker.accumulate(0.5).unwrap();
    assert_eq!(since_seek.translation, [1.0, 0.0, 0.0]);
}

#[test]
fn ring_history_keeps_the_latest_samples_within_capacity() {
    let mut tracker = NativeRootMotionTracker::new(3).unwrap();
    tracker
        .reset_baseline(&translation_matrix(0.0, 0.0, 0.0))
        .unwrap();
    for step in 1..=5 {
        tracker
            .record_advance(
                &translation_matrix(step as f64, 0.0, 0.0),
                Some("walk"),
                step as f64,
                0,
            )
            .unwrap();
    }
    assert_eq!(tracker.sample_count(), 3);
    // 保留最新 3 条：since=2 之后应剩 3、4、5 三条，累计 +3。
    let accumulated = tracker.accumulate(2.0).unwrap();
    assert_eq!(accumulated.translation, [3.0, 0.0, 0.0]);
    assert_eq!(accumulated.samples, 3);
}

#[test]
fn capacity_and_matrix_errors_fail_closed_like_the_ts_range_errors() {
    assert!(NativeRootMotionTracker::new(0).is_err());
    assert!(NativeRootMotionTracker::new(65_537).is_err());
    let mut tracker = new_tracker();
    // 零缩放列 = 退化旋转轴。
    let mut degenerate = translation_matrix(0.0, 0.0, 0.0);
    degenerate[0] = 0.0;
    assert!(tracker.reset_baseline(&degenerate).is_err());
    // 非有限分量。
    let mut non_finite = translation_matrix(0.0, 0.0, 0.0);
    non_finite[12] = f64::NAN;
    assert!(tracker.reset_baseline(&non_finite).is_err());
}

#[test]
fn column_major_helpers_match_the_ts_math_on_identity_and_delta() {
    let identity = translation_matrix(3.0, 4.0, 5.0);
    assert_eq!(
        column_major_translation(&identity).unwrap(),
        [3.0, 4.0, 5.0]
    );
    assert_eq!(
        column_major_quaternion(&identity).unwrap(),
        [0.0, 0.0, 0.0, 1.0]
    );
    // 相同姿态的增量为恒等四元数。
    let pose = yaw_matrix(30.0, 0.0);
    let rotation = column_major_quaternion(&pose).unwrap();
    let delta = quaternion_delta(&rotation, &rotation);
    assert!((delta[3] - 1.0).abs() < 1e-12);
    assert!(delta[..3].iter().all(|value| value.abs() < 1e-12));
}
