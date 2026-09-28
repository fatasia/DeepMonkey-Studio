//! T14 根运动增量记录的 Native 同语义镜像。
//!
//! TS 合同（只读规范）：`packages/deep-engine/src/gltf/renderAnimationRootMotion.ts`。
//! 对齐语义：
//! - 世界系平移增量 `current - previous` 与旋转增量 `qPrev⁻¹ ⊗ qCurrent`
//!   （`(x, y, z, w)`，Shepperd 提取、列归一化抗缩放）；
//! - 环形历史（默认 512，1..=65536）+ `accumulate(since)` 严格大于过滤；
//! - `reset_baseline` 重整基线不入账（seek/play 语义），瞬移不入账；
//! - 不做实例变换的自动应用（编辑器消费为后续切片）。
//!
//! 与 TS 的接口差异（语义等价）：TS 以「帧内节点表 + 根节点 ID」取世界矩阵，
//! 此处由宿主直接传入被跟踪节点的列主序 4×4 世界矩阵（`&[f64; 16]`），
//! 避免 Rust 侧复制整帧节点表；矩阵口径与 TS 一致（列主序、单位为世界系）。

use std::collections::VecDeque;
use std::fmt;

/// 与 TS `DEFAULT_ROOT_MOTION_HISTORY` 同值。
pub const DEFAULT_ROOT_MOTION_HISTORY: usize = 512;

/// 根运动数据错误（镜像 TS `RangeError` 场景：退化轴/非有限分量/容量越界）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeRootMotionError(pub &'static str);

impl fmt::Display for NativeRootMotionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "root-motion: {}", self.0)
    }
}

impl std::error::Error for NativeRootMotionError {}

/// 一次前进产生的世界系运动增量与播放标记（TS `GltfRootMotionSample`）。
#[derive(Debug, Clone, PartialEq)]
pub struct NativeRootMotionSample {
    pub translation: [f64; 3],
    pub rotation: [f64; 4],
    pub clip_id: Option<String>,
    pub unwrapped_time: f64,
    pub r#loop: u64,
}

/// 严格大于 `since` 的样本累计（TS `GltfRootMotionAccumulation`）。
#[derive(Debug, Clone, PartialEq)]
pub struct NativeRootMotionAccumulation {
    pub translation: [f64; 3],
    pub rotation: [f64; 4],
    pub samples: usize,
}

/// 环形历史 + 位姿基线（TS `GltfRootMotionTracker`）。
#[derive(Debug, Clone)]
pub struct NativeRootMotionTracker {
    capacity: usize,
    samples: VecDeque<NativeRootMotionSample>,
    baseline: Option<([f64; 3], [f64; 4])>,
}

impl NativeRootMotionTracker {
    /// 容量必须是 1..=65536 的整数（与 TS 一致的 fail-closed）。
    pub fn new(capacity: usize) -> Result<Self, NativeRootMotionError> {
        if !(1..=65_536).contains(&capacity) {
            return Err(NativeRootMotionError(
                "Root motion history capacity must be an integer from 1 through 65536.",
            ));
        }
        Ok(Self {
            capacity,
            samples: VecDeque::new(),
            baseline: None,
        })
    }

    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }

    /// 从给定世界矩阵重整基线，不入账任何跳变（TS `resetBaseline`）。
    pub fn reset_baseline(
        &mut self,
        world_matrix: &[f64; 16],
    ) -> Result<(), NativeRootMotionError> {
        let translation = column_major_translation(world_matrix)?;
        let rotation = column_major_quaternion(world_matrix)?;
        self.baseline = Some((translation, rotation));
        Ok(())
    }

    /// 清空基线（对应 TS 传入缺节点的帧后基线为 null：此后前进不入账）。
    pub fn clear_baseline(&mut self) {
        self.baseline = None;
    }

    /// 记录一次前进的增量；无基线时返回 `Ok(None)`（TS 同语义返回 null）。
    pub fn record_advance(
        &mut self,
        world_matrix: &[f64; 16],
        clip_id: Option<&str>,
        unwrapped_time: f64,
        r#loop: u64,
    ) -> Result<Option<NativeRootMotionSample>, NativeRootMotionError> {
        let Some((before_translation, before_rotation)) = self.baseline else {
            return Ok(None);
        };
        let translation = column_major_translation(world_matrix)?;
        let rotation = column_major_quaternion(world_matrix)?;
        let sample = NativeRootMotionSample {
            clip_id: clip_id.map(str::to_owned),
            unwrapped_time,
            r#loop,
            translation: [
                translation[0] - before_translation[0],
                translation[1] - before_translation[1],
                translation[2] - before_translation[2],
            ],
            rotation: quaternion_delta(&before_rotation, &rotation),
        };
        self.baseline = Some((translation, rotation));
        self.samples.push_back(sample.clone());
        if self.samples.len() > self.capacity {
            self.samples.pop_front();
        }
        Ok(Some(sample))
    }

    /// 累计 `unwrapped_time > since` 的样本;无样本返回 `None`。
    /// 回绕帧如实记录渲染 pose 的不连续量(与 TS 一致;圈修正累计为剩余工作)。
    pub fn accumulate(&self, since_unwrapped_time: f64) -> Option<NativeRootMotionAccumulation> {
        let mut x = 0.0;
        let mut y = 0.0;
        let mut z = 0.0;
        let mut count = 0usize;
        let mut rotation = [0.0, 0.0, 0.0, 1.0];
        for sample in &self.samples {
            if !(sample.unwrapped_time > since_unwrapped_time) {
                continue;
            }
            x += sample.translation[0];
            y += sample.translation[1];
            z += sample.translation[2];
            rotation = quaternion_multiply(&rotation, &sample.rotation);
            count += 1;
        }
        if count == 0 {
            return None;
        }
        Some(NativeRootMotionAccumulation {
            translation: [x, y, z],
            rotation: normalize_quaternion(&rotation),
            samples: count,
        })
    }

    /// T16 消费侧最小扩展:历史最新样本的 `unwrapped_time`;空历史为 `None`。
    /// 物理消费方以「`accumulate(watermark)` 累计根运动 → 水印推进到这里」的
    /// 两步协议驱动逐固定 tick 的根运动贯通;水印语义与 `accumulate` 的严格
    /// 大于过滤配对,任何渲染帧率划分下消费的都是同一批样本。
    pub fn latest_unwrapped_time(&self) -> Option<f64> {
        self.samples.back().map(|sample| sample.unwrapped_time)
    }
}

/// 列主序 4×4 的平移（TS `columnMajorTranslation`）。
pub fn column_major_translation(matrix: &[f64; 16]) -> Result<[f64; 3], NativeRootMotionError> {
    assert_finite_matrix(matrix)?;
    Ok([matrix[12], matrix[13], matrix[14]])
}

/// 列主序 4×4 的旋转（Shepperd 法；先列归一化，缩放不泄漏进四元数）。
pub fn column_major_quaternion(matrix: &[f64; 16]) -> Result<[f64; 4], NativeRootMotionError> {
    assert_finite_matrix(matrix)?;
    let c0 = normalize_axis([matrix[0], matrix[1], matrix[2]])?;
    let c1 = normalize_axis([matrix[4], matrix[5], matrix[6]])?;
    let c2 = normalize_axis([matrix[8], matrix[9], matrix[10]])?;
    let trace = c0[0] + c1[1] + c2[2];
    if trace > 0.0 {
        let s = (trace + 1.0).sqrt() * 2.0;
        return Ok([
            (c1[2] - c2[1]) / s,
            (c2[0] - c0[2]) / s,
            (c0[1] - c1[0]) / s,
            0.25 * s,
        ]);
    }
    if c0[0] > c1[1] && c0[0] > c2[2] {
        let s = (1.0 + c0[0] - c1[1] - c2[2]).sqrt() * 2.0;
        return Ok([
            0.25 * s,
            (c1[0] + c0[1]) / s,
            (c2[0] + c0[2]) / s,
            (c1[2] - c2[1]) / s,
        ]);
    }
    if c1[1] > c2[2] {
        let s = (1.0 + c1[1] - c0[0] - c2[2]).sqrt() * 2.0;
        return Ok([
            (c1[0] + c0[1]) / s,
            0.25 * s,
            (c2[1] + c1[2]) / s,
            (c2[0] - c0[2]) / s,
        ]);
    }
    let s = (1.0 + c2[2] - c0[0] - c1[1]).sqrt() * 2.0;
    Ok([
        (c2[0] + c0[2]) / s,
        (c2[1] + c1[2]) / s,
        0.25 * s,
        (c0[1] - c1[0]) / s,
    ])
}

/// 单位四元数积 `a ⊗ b`，`(x, y, z, w)` 序（TS `quaternionMultiply`）。
pub fn quaternion_multiply(a: &[f64; 4], b: &[f64; 4]) -> [f64; 4] {
    normalize_quaternion(&[
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ])
}

/// `previous → current` 的旋转增量 `previous⁻¹ ⊗ current`（TS `quaternionDelta`）。
pub fn quaternion_delta(previous: &[f64; 4], current: &[f64; 4]) -> [f64; 4] {
    quaternion_multiply(
        &[-previous[0], -previous[1], -previous[2], previous[3]],
        current,
    )
}

pub fn normalize_quaternion(quaternion: &[f64; 4]) -> [f64; 4] {
    let length = (quaternion[0] * quaternion[0]
        + quaternion[1] * quaternion[1]
        + quaternion[2] * quaternion[2]
        + quaternion[3] * quaternion[3])
        .sqrt();
    if !(length > 0.0) {
        return [0.0, 0.0, 0.0, 1.0];
    }
    [
        quaternion[0] / length,
        quaternion[1] / length,
        quaternion[2] / length,
        quaternion[3] / length,
    ]
}

fn normalize_axis(axis: [f64; 3]) -> Result<[f64; 3], NativeRootMotionError> {
    let length = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    if !(length > 0.0) {
        return Err(NativeRootMotionError(
            "Root motion matrix has a degenerate rotation axis.",
        ));
    }
    Ok([axis[0] / length, axis[1] / length, axis[2] / length])
}

fn assert_finite_matrix(matrix: &[f64; 16]) -> Result<(), NativeRootMotionError> {
    if matrix.iter().any(|value| !value.is_finite()) {
        return Err(NativeRootMotionError(
            "Root motion matrix contains non-finite values.",
        ));
    }
    Ok(())
}
