//! physics-frame-v1 跨端合同:复用 dynamic-frame-v1 的纪律(排序、定点 6 位、
//! -0 归一),把物理步进的变换序列压成逐字节稳定的规范串,再以共享 SHA-256 摘要。
//! 与 Web 消费端(`physics-validate/node-wasm/run-and-compare.mjs`)逐字节对齐:
//! - body 按 id 字典序;
//! - 每分量 `{:.6}`(Rust)/`toFixed(6)`(TS),f32 先精确升 f64 再格式化;
//! - `-0` 归一为 `0`(TS `value === 0 ? 0 : value` 同款守卫);
//! - 位级摘要独立于十进制串:f32 to_le_bytes 原始位序哈希,不受格式化影响。

use crate::hash::sha256;

/// 单个刚体在某步的位姿:[tx, ty, tz, qx, qy, qz, qw]。
pub type Pose = [f32; 7];

/// 一步的帧记录:step 序号 + 全部刚体位姿(body id 升序存放)。
#[derive(Clone, Debug)]
pub struct FrameRecord {
    pub step: u32,
    pub bodies: Vec<(String, Pose)>,
}

pub const COMPONENT_ORDER: [&str; 7] = ["tx", "ty", "tz", "qx", "qy", "qz", "qw"];

fn fixed6(value: f64) -> String {
    let value = if value == 0.0 { 0.0 } else { value };
    format!("{value:.6}")
}

/// 单帧规范串:`physics-frame-v1|step=<n>|bodies=id>7分量;...`。
/// 调用方保证 `bodies` 与 `canonical` 排序前不必有序——这里统一排序,杜绝调用点漂移。
pub fn canonical_frame(frame: &FrameRecord) -> String {
    let mut bodies: Vec<&(String, Pose)> = frame.bodies.iter().collect();
    bodies.sort_by(|left, right| left.0.cmp(&right.0));
    let mut text = format!("physics-frame-v1|step={}|bodies=", frame.step);
    for (index, (id, pose)) in bodies.iter().enumerate() {
        if index > 0 {
            text.push(';');
        }
        text.push_str(id);
        text.push('>');
        for (component, value) in pose.iter().enumerate() {
            if component > 0 {
                text.push(',');
            }
            text.push_str(&fixed6(f64::from(*value)));
        }
    }
    text
}

pub struct FrameSummary {
    /// 规范帧序列(每步一行,含 step=0 初始帧)的 SHA-256。
    pub frame_sequence_sha256: String,
    /// 位级摘要:step 升序 → body 字典序 → 分量顺序,逐 f32 to_le_bytes 的 SHA-256。
    pub pose_bits_sha256: String,
}

/// 全序列摘要。哈希输入与帧内容一一对应,无任何时间/环境噪声。
pub fn summarize(frames: &[FrameRecord]) -> FrameSummary {
    let mut sequence = String::new();
    let mut bits = Vec::new();
    for frame in frames {
        if frame.step > 0 {
            sequence.push('\n');
        }
        sequence.push_str(&canonical_frame(frame));
        let mut bodies: Vec<&(String, Pose)> = frame.bodies.iter().collect();
        bodies.sort_by(|left, right| left.0.cmp(&right.0));
        for (_, pose) in bodies {
            for value in pose.iter() {
                bits.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    FrameSummary {
        frame_sequence_sha256: sha256(sequence.as_bytes()),
        pose_bits_sha256: sha256(&bits),
    }
}

/// 两条帧序列的第一处位级分歧;逐位门禁的定位输出。
pub fn first_bit_divergence(left: &[FrameRecord], right: &[FrameRecord]) -> Option<String> {
    for (frame_left, frame_right) in left.iter().zip(right.iter()) {
        if frame_left.step != frame_right.step {
            return Some(format!(
                "step mismatch: {} vs {}",
                frame_left.step, frame_right.step
            ));
        }
        for ((id_left, pose_left), (_id_right, pose_right)) in frame_left
            .bodies
            .iter()
            .zip(frame_right.bodies.iter())
        {
            for (index, (a, b)) in pose_left.iter().zip(pose_right.iter()).enumerate() {
                if a.to_bits() != b.to_bits() {
                    return Some(format!(
                        "step={} body={} component={} native_bits=0x{:08x} other_bits=0x{:08x} native={} other={}",
                        frame_left.step,
                        id_left,
                        COMPONENT_ORDER[index],
                        a.to_bits(),
                        b.to_bits(),
                        fixed6(f64::from(*a)),
                        fixed6(f64::from(*b)),
                    ));
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{FrameRecord, Pose, canonical_frame, first_bit_divergence, summarize};

    fn pose(values: [f32; 7]) -> Pose {
        values
    }

    #[test]
    fn canonical_frame_sorts_and_normalizes_negative_zero() {
        let frame = FrameRecord {
            step: 7,
            bodies: vec![
                ("sphere-b".into(), pose([-0.0; 7])),
                ("sphere-a".into(), pose([1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0])),
            ],
        };
        assert_eq!(
            canonical_frame(&frame),
            "physics-frame-v1|step=7|bodies="
                .to_owned()
                + "sphere-a>1.000000,2.000000,3.000000,0.000000,0.000000,0.000000,1.000000;"
                + "sphere-b>0.000000,0.000000,0.000000,0.000000,0.000000,0.000000,0.000000"
        );
    }

    #[test]
    fn summary_is_order_sensitive_to_bits_but_stable_to_body_order() {
        let first = FrameRecord {
            step: 0,
            bodies: vec![("a".into(), pose([0.1; 7]))],
        };
        let reordered = FrameRecord {
            step: 0,
            bodies: vec![("a".into(), pose([0.1; 7]))],
        };
        let flipped = FrameRecord {
            step: 0,
            bodies: vec![("a".into(), {
                let mut values = [0.1f32; 7];
                values[6] += f32::EPSILON;
                values
            })],
        };
        assert_eq!(
            summarize(&[first.clone()]).frame_sequence_sha256,
            summarize(&[reordered]).frame_sequence_sha256
        );
        assert_ne!(
            summarize(&[first]).pose_bits_sha256,
            summarize(&[flipped]).pose_bits_sha256
        );
    }

    #[test]
    fn divergence_locator_reports_first_step_body_component() {
        let base = FrameRecord {
            step: 3,
            bodies: vec![("a".into(), pose([0.0; 7])), ("b".into(), pose([0.0; 7]))],
        };
        let mut drifted = base.clone();
        drifted.bodies[1].1[2] = 1.0e-33;
        let report = first_bit_divergence(&[base], &[drifted]).expect("divergence");
        assert!(report.contains("step=3"), "{report}");
        assert!(report.contains("body=b"), "{report}");
        assert!(report.contains("component=tz"), "{report}");
    }
}
