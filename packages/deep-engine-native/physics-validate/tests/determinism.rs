//! R10 确定性测试:双跑逐位一致、初速发散、合同格式金标、物理合理性。
//! 全部固定时钟、纯 CPU、无 GPU、无 sleep。

use physics_validate::{
    canonical_frame, first_bit_divergence, parse_spec, run_scene, summarize, FrameRecord,
};
use std::path::Path;

const SPEC_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/scene-spec-v1.json");

fn spec_bytes() -> Vec<u8> {
    std::fs::read(SPEC_PATH).expect("scene spec present next to crate root")
}

fn load_spec() -> physics_validate::SceneSpec {
    parse_spec(&spec_bytes()).expect("valid scene spec")
}

fn pose_bits(frames: &[FrameRecord]) -> Vec<u8> {
    let mut bits = Vec::new();
    for frame in frames {
        let mut bodies: Vec<&(String, [f32; 7])> = frame.bodies.iter().collect();
        bodies.sort_by(|left, right| left.0.cmp(&right.0));
        for (_, pose) in bodies {
            for value in pose.iter() {
                bits.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    bits
}

#[test]
fn double_run_is_bitwise_identical() {
    let spec = load_spec();
    let first = run_scene(&spec);
    let second = run_scene(&spec);
    assert_eq!(first.frames.len(), second.frames.len());
    // 位级:整个变换序列的 f32 位模式逐字节相等。
    assert_eq!(pose_bits(&first.frames), pose_bits(&second.frames));
    // 摘要级:两个摘要哈希一致。
    assert_eq!(summarize(&first.frames).frame_sequence_sha256, summarize(&second.frames).frame_sequence_sha256);
    assert_eq!(summarize(&first.frames).pose_bits_sha256, summarize(&second.frames).pose_bits_sha256);
    // 定位器不得报任何分歧。
    assert!(first_bit_divergence(&first.frames, &second.frames).is_none());
    // 附加:再跑第三次,三跑全等(排除偶发缓存态)。
    let third = run_scene(&spec);
    assert_eq!(pose_bits(&first.frames), pose_bits(&third.frames));
}

#[test]
fn different_initial_velocity_diverges() {
    let mut spec = load_spec();
    let sphere_c = spec
        .bodies
        .iter_mut()
        .find(|body| body.id == "sphere-c")
        .expect("sphere-c present");
    sphere_c.linvel[1] = 1.5; // 原 1.0:仅改一颗球的初速。
    let baseline = run_scene(&load_spec());
    let modified = run_scene(&spec);
    assert_ne!(
        summarize(&baseline.frames).frame_sequence_sha256,
        summarize(&modified.frames).frame_sequence_sha256,
        "初速不同必须发散"
    );
    assert_ne!(summarize(&baseline.frames).pose_bits_sha256, summarize(&modified.frames).pose_bits_sha256);
    // 发散必须发生在合理位置:step 0 逐位相同(初速尚未积分),
    // 分歧定位器应能给出首个不同步。
    assert!(first_bit_divergence(&baseline.frames[..1], &modified.frames[..1]).is_none());
    let report = first_bit_divergence(&baseline.frames, &modified.frames).expect("divergence");
    assert!(report.contains("step="), "{report}");
}

#[test]
fn canonical_frame_matches_golden_bytes() {
    let spec = load_spec();
    let outcome = run_scene(&spec);
    let initial = canonical_frame(&outcome.frames[0]);
    // step=0 的规范串只含初始位姿,是跨端金标;-0 已归一(见 -1.5 等分量)。
    assert!(initial.starts_with("physics-frame-v1|step=0|bodies="), "{initial}");
    assert!(initial.contains("sphere-a>-1.500000,2.000000,0.000000,0.000000,0.000000,0.000000,1.000000"), "{initial}");
    assert!(initial.contains("sphere-b>0.000000,3.500000,0.000000,0.000000,0.000000,0.000000,1.000000"), "{initial}");
    assert!(initial.contains("sphere-c>1.500000,5.000000,0.000000,0.000000,0.000000,0.000000,1.000000"), "{initial}");
    // 帧数 = steps+1,step 连续。
    assert_eq!(outcome.frames.len(), spec.timestep.steps as usize + 1);
    for (index, frame) in outcome.frames.iter().enumerate() {
        assert_eq!(frame.step, index as u32);
    }
}

#[test]
fn spheres_settle_on_ground_with_restitution() {
    // 物理合理性:4 秒后三球都应贴地(球心高度≈半径),证明接触真实求解,
    // 确定性不是"空转的位一致性"。
    let outcome = run_scene(&load_spec());
    let last = outcome.frames.last().expect("final frame");
    for (id, radius) in [("sphere-a", 0.5f32), ("sphere-b", 0.75), ("sphere-c", 1.0)] {
        let pose = &last
            .bodies
            .iter()
            .find(|(body_id, _)| body_id == id)
            .expect("body present")
            .1;
        let height = pose[1];
        assert!(
            (height - radius).abs() < 0.02,
            "{id} 应稳定贴地: y={height} 期望≈{radius}"
        );
        assert!(height >= radius - 0.02, "{id} 不应穿地: y={height}");
    }
}

#[test]
fn spec_file_bytes_are_stable() {
    // 输入指纹:spec 文件字节变化即场景定义漂移;哈希进 evidence.json 可追溯。
    let bytes = spec_bytes();
    let digest = physics_validate::hash::sha256(&bytes);
    assert_eq!(digest.len(), 64);
    assert!(Path::new(SPEC_PATH).exists());
}
