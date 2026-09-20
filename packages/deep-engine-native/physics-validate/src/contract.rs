//! physics-frame-v1 跨端合同:复用 dynamic-frame-v1 的纪律(排序、定点 6 位、
//! -0 归一),把物理步进的变换序列压成逐字节稳定的规范串,再以共享 SHA-256 摘要。
//! 与 Web 消费端(`physics-validate/node-wasm/run-and-compare.mjs`)逐字节对齐:
//! - body/joint 按 id 字典序;
//! - 每分量 `{:.6}`(Rust)/`toFixed(6)`(TS),f32 先精确升 f64 再格式化;
//! - `-0` 归一为 `0`(TS `value === 0 ? 0 : value` 同款守卫);
//! - 位级摘要独立于十进制串:f32 to_le_bytes 原始位序哈希,不受格式化影响。

use crate::hash::sha256;

/// 单个刚体在某步的位姿:[tx, ty, tz, qx, qy, qz, qw]。
pub type Pose = [f32; 7];

/// 关节的规范状态。锚点与局部关节 frame 都来自 Rapier 实例本身,
/// 不是从输入 spec 回填,因此能发现两端关节构造或枚举映射漂移。
#[derive(Clone, Debug)]
pub struct JointState {
    pub id: String,
    pub kind: String,
    pub body1: String,
    pub body2: String,
    pub anchor1: [f32; 3],
    pub anchor2: [f32; 3],
    pub frame1: [f32; 4],
    pub frame2: [f32; 4],
}

/// 一步的帧记录:step 序号 + 全部刚体位姿(body id 升序存放) + 关节状态。
#[derive(Clone, Debug)]
pub struct FrameRecord {
    pub step: u32,
    pub bodies: Vec<(String, Pose)>,
    pub joints: Vec<JointState>,
}

pub const COMPONENT_ORDER: [&str; 7] = ["tx", "ty", "tz", "qx", "qy", "qz", "qw"];
const JOINT_VECTOR_COMPONENTS: [&str; 3] = ["x", "y", "z"];
const JOINT_FRAME_COMPONENTS: [&str; 4] = ["x", "y", "z", "w"];

fn fixed6(value: f64) -> String {
    let value = if value == 0.0 { 0.0 } else { value };
    format!("{value:.6}")
}

fn append_fixed_components<const N: usize>(text: &mut String, values: &[f32; N]) {
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            text.push(',');
        }
        text.push_str(&fixed6(f64::from(*value)));
    }
}

/// 单帧规范串:`physics-frame-v1|step=<n>|bodies=id>7分量[|joints=...]`。
/// 调用方保证 `bodies` 与 `joints` 与 canonical 排序前不必有序——这里统一排序,
/// 杜绝调用点漂移。无关节旧场景保持原有字节格式与摘要。
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
        append_fixed_components(&mut text, pose);
    }

    if !frame.joints.is_empty() {
        let mut joints: Vec<&JointState> = frame.joints.iter().collect();
        joints.sort_by(|left, right| left.id.cmp(&right.id));
        text.push_str("|joints=");
        for (index, joint) in joints.iter().enumerate() {
            if index > 0 {
                text.push(';');
            }
            text.push_str(&joint.id);
            text.push('>');
            text.push_str(&joint.kind);
            text.push(',');
            text.push_str(&joint.body1);
            text.push(',');
            text.push_str(&joint.body2);
            text.push_str("|a1=");
            append_fixed_components(&mut text, &joint.anchor1);
            text.push_str("|a2=");
            append_fixed_components(&mut text, &joint.anchor2);
            text.push_str("|f1=");
            append_fixed_components(&mut text, &joint.frame1);
            text.push_str("|f2=");
            append_fixed_components(&mut text, &joint.frame2);
        }
    }
    text
}

pub struct FrameSummary {
    /// 规范帧序列(每步一行,含 step=0 初始帧)的 SHA-256。
    pub frame_sequence_sha256: String,
    /// 位级摘要:step 升序 → body 字典序 → 分量顺序,逐 f32 to_le_bytes 的 SHA-256。
    pub pose_bits_sha256: String,
    /// 关节身份/配置与 f32 frame/anchor 的小端位序摘要。
    pub joint_bits_sha256: String,
}

fn sorted_bodies(frame: &FrameRecord) -> Vec<&(String, Pose)> {
    let mut bodies: Vec<&(String, Pose)> = frame.bodies.iter().collect();
    bodies.sort_by(|left, right| left.0.cmp(&right.0));
    bodies
}

fn sorted_joints(frame: &FrameRecord) -> Vec<&JointState> {
    let mut joints: Vec<&JointState> = frame.joints.iter().collect();
    joints.sort_by(|left, right| left.id.cmp(&right.id));
    joints
}

fn append_joint_bits(bits: &mut Vec<u8>, joint: &JointState) {
    for text in [&joint.id, &joint.kind, &joint.body1, &joint.body2] {
        bits.extend_from_slice(text.as_bytes());
        bits.push(0);
    }
    for value in joint.anchor1.iter() {
        bits.extend_from_slice(&value.to_le_bytes());
    }
    for value in joint.anchor2.iter() {
        bits.extend_from_slice(&value.to_le_bytes());
    }
    for value in joint.frame1.iter() {
        bits.extend_from_slice(&value.to_le_bytes());
    }
    for value in joint.frame2.iter() {
        bits.extend_from_slice(&value.to_le_bytes());
    }
}

/// 全序列摘要。哈希输入与帧内容一一对应,无任何时间/环境噪声。
pub fn summarize(frames: &[FrameRecord]) -> FrameSummary {
    let mut sequence = String::new();
    let mut pose_bits = Vec::new();
    let mut joint_bits = Vec::new();
    for (index, frame) in frames.iter().enumerate() {
        if index > 0 {
            sequence.push('\n');
        }
        sequence.push_str(&canonical_frame(frame));
        for (_, pose) in sorted_bodies(frame) {
            for value in pose.iter() {
                pose_bits.extend_from_slice(&value.to_le_bytes());
            }
        }
        for joint in sorted_joints(frame) {
            joint_bits.extend_from_slice(&frame.step.to_le_bytes());
            append_joint_bits(&mut joint_bits, joint);
        }
    }
    FrameSummary {
        frame_sequence_sha256: sha256(sequence.as_bytes()),
        pose_bits_sha256: sha256(&pose_bits),
        joint_bits_sha256: sha256(&joint_bits),
    }
}

fn compare_components(
    step: u32,
    owner: &str,
    field: &str,
    left: &[f32],
    right: &[f32],
    names: &[&str],
) -> Option<String> {
    for (index, (a, b)) in left.iter().zip(right.iter()).enumerate() {
        if a.to_bits() != b.to_bits() {
            return Some(format!(
                "step={step} {owner}={field} component={} native_bits=0x{:08x} other_bits=0x{:08x} native={} other={}",
                names[index],
                a.to_bits(),
                b.to_bits(),
                fixed6(f64::from(*a)),
                fixed6(f64::from(*b)),
            ));
        }
    }
    None
}

/// 两条帧序列的第一处位级分歧;逐位门禁的定位输出。
pub fn first_bit_divergence(left: &[FrameRecord], right: &[FrameRecord]) -> Option<String> {
    if left.len() != right.len() {
        return Some(format!("frame count mismatch: {} vs {}", left.len(), right.len()));
    }
    for (frame_left, frame_right) in left.iter().zip(right.iter()) {
        if frame_left.step != frame_right.step {
            return Some(format!(
                "step mismatch: {} vs {}",
                frame_left.step, frame_right.step
            ));
        }

        let left_bodies = sorted_bodies(frame_left);
        let right_bodies = sorted_bodies(frame_right);
        if left_bodies.len() != right_bodies.len() {
            return Some(format!(
                "step={} body count mismatch: {} vs {}",
                frame_left.step,
                left_bodies.len(),
                right_bodies.len()
            ));
        }
        for ((id_left, pose_left), (id_right, pose_right)) in
            left_bodies.iter().zip(right_bodies.iter())
        {
            if id_left != id_right {
                return Some(format!(
                    "step={} body id mismatch: {id_left} vs {id_right}",
                    frame_left.step
                ));
            }
            if let Some(report) = compare_components(
                frame_left.step,
                "body",
                id_left,
                pose_left,
                pose_right,
                &COMPONENT_ORDER,
            ) {
                return Some(report);
            }
        }

        let left_joints = sorted_joints(frame_left);
        let right_joints = sorted_joints(frame_right);
        if left_joints.len() != right_joints.len() {
            return Some(format!(
                "step={} joint count mismatch: {} vs {}",
                frame_left.step,
                left_joints.len(),
                right_joints.len()
            ));
        }
        for (left_joint, right_joint) in left_joints.iter().zip(right_joints.iter()) {
            if left_joint.id != right_joint.id {
                return Some(format!(
                    "step={} joint id mismatch: {} vs {}",
                    frame_left.step, left_joint.id, right_joint.id
                ));
            }
            for (field, left_text, right_text) in [
                ("kind", &left_joint.kind, &right_joint.kind),
                ("body1", &left_joint.body1, &right_joint.body1),
                ("body2", &left_joint.body2, &right_joint.body2),
            ] {
                if left_text != right_text {
                    return Some(format!(
                        "step={} joint={} field={} native={} other={}",
                        frame_left.step, left_joint.id, field, left_text, right_text
                    ));
                }
            }
            for (field, left_values, right_values, names) in [
                (
                    "anchor1",
                    &left_joint.anchor1[..],
                    &right_joint.anchor1[..],
                    &JOINT_VECTOR_COMPONENTS[..],
                ),
                (
                    "anchor2",
                    &left_joint.anchor2[..],
                    &right_joint.anchor2[..],
                    &JOINT_VECTOR_COMPONENTS[..],
                ),
                (
                    "frame1",
                    &left_joint.frame1[..],
                    &right_joint.frame1[..],
                    &JOINT_FRAME_COMPONENTS[..],
                ),
                (
                    "frame2",
                    &left_joint.frame2[..],
                    &right_joint.frame2[..],
                    &JOINT_FRAME_COMPONENTS[..],
                ),
            ] {
                if let Some(report) = compare_components(
                    frame_left.step,
                    "joint",
                    &format!("{} field={field}", left_joint.id),
                    left_values,
                    right_values,
                    names,
                ) {
                    return Some(report);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        FrameRecord, JointState, Pose, canonical_frame, first_bit_divergence, summarize,
    };

    fn pose(values: [f32; 7]) -> Pose {
        values
    }

    fn empty_joints() -> Vec<JointState> {
        Vec::new()
    }

    fn joint(id: &str) -> JointState {
        JointState {
            id: id.into(),
            kind: "fixed".into(),
            body1: "a".into(),
            body2: "b".into(),
            anchor1: [0.0; 3],
            anchor2: [0.0; 3],
            frame1: [0.0, 0.0, 0.0, 1.0],
            frame2: [0.0, 0.0, 0.0, 1.0],
        }
    }

    #[test]
    fn canonical_frame_sorts_and_normalizes_negative_zero() {
        let frame = FrameRecord {
            step: 7,
            bodies: vec![
                ("sphere-b".into(), pose([-0.0; 7])),
                ("sphere-a".into(), pose([1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0])),
            ],
            joints: empty_joints(),
        };
        assert_eq!(
            canonical_frame(&frame),
            "physics-frame-v1|step=7|bodies=".to_owned()
                + "sphere-a>1.000000,2.000000,3.000000,0.000000,0.000000,0.000000,1.000000;"
                + "sphere-b>0.000000,0.000000,0.000000,0.000000,0.000000,0.000000,0.000000"
        );
    }

    #[test]
    fn canonical_frame_contains_sorted_joint_contract() {
        let frame = FrameRecord {
            step: 0,
            bodies: vec![("a".into(), pose([0.0; 7]))],
            joints: vec![joint("joint-b"), joint("joint-a")],
        };
        let text = canonical_frame(&frame);
        assert!(text.contains("|joints=joint-a>fixed,a,b|a1=0.000000,0.000000,0.000000"), "{text}");
        assert!(text.find("joint-a").unwrap() < text.find("joint-b").unwrap(), "{text}");
        assert_eq!(summarize(&[frame]).joint_bits_sha256.len(), 64);
    }

    #[test]
    fn summary_is_order_sensitive_to_bits_but_stable_to_body_order() {
        let first = FrameRecord {
            step: 0,
            bodies: vec![("a".into(), pose([0.1; 7]))],
            joints: empty_joints(),
        };
        let reordered = FrameRecord {
            step: 0,
            bodies: vec![("a".into(), pose([0.1; 7]))],
            joints: empty_joints(),
        };
        let flipped = FrameRecord {
            step: 0,
            bodies: vec![("a".into(), pose({
                let mut values = [0.1f32; 7];
                values[6] += f32::EPSILON;
                values
            }))],
            joints: empty_joints(),
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
            joints: empty_joints(),
        };
        let mut drifted = base.clone();
        drifted.bodies[1].1[2] = 1.0e-33;
        let report = first_bit_divergence(&[base], &[drifted]).expect("divergence");
        assert!(report.contains("step=3"), "{report}");
        assert!(report.contains("body=b"), "{report}");
        assert!(report.contains("component=tz"), "{report}");
    }

    #[test]
    fn divergence_locator_reports_joint_field() {
        let base = FrameRecord {
            step: 1,
            bodies: vec![("a".into(), pose([0.0; 7]))],
            joints: vec![joint("hinge")],
        };
        let mut drifted = base.clone();
        drifted.joints[0].anchor2[1] = 1.0;
        let report = first_bit_divergence(&[base], &[drifted]).expect("divergence");
        assert!(report.contains("joint=hinge"), "{report}");
        assert!(report.contains("field=anchor2"), "{report}");
        assert!(report.contains("component=y"), "{report}");
    }
}
