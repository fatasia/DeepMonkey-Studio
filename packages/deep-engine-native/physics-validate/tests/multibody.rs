use physics_validate::{parse_spec, run_scene, summarize, FrameRecord, SceneSpec};

fn fixture() -> SceneSpec { parse_spec(include_bytes!("../scene-spec-f07-multibody.json")).unwrap() }

fn anchor(frame: &FrameRecord, id: &str, local: [f64; 3]) -> [f64; 2] {
    if id == "ground" { return [local[0], local[1] - 0.5]; }
    let pose = frame.bodies.iter().find(|(name, _)| name == id).unwrap().1;
    let z = f64::from(pose[5]); let w = f64::from(pose[6]);
    let cos = 1.0 - 2.0 * z * z; let sin = 2.0 * z * w;
    [f64::from(pose[0]) + cos * local[0] - sin * local[1],
     f64::from(pose[1]) + sin * local[0] + cos * local[1]]
}

#[test]
fn multibody_moves_under_gravity_and_preserves_every_joint_anchor() {
    let spec = fixture(); let result = run_scene(&spec);
    let repeated = run_scene(&spec);
    assert_eq!(summarize(&result.frames).pose_bits_sha256, summarize(&repeated.frames).pose_bits_sha256);
    assert_eq!(result.frames.len(), 241);
    let last = result.frames.last().unwrap();
    assert!((last.bodies[2].1[1] - 4.0).abs() > 0.2);
    for frame in &result.frames {
        assert_eq!(frame.joints.len(), 3);
        for joint in &spec.joints {
            let a = anchor(frame, &joint.body1, joint.anchor1);
            let b = anchor(frame, &joint.body2, joint.anchor2);
            assert!((a[0]-b[0]).hypot(a[1]-b[1]) < 0.00001, "step {}: {a:?} != {b:?}", frame.step);
        }
    }
    let mut free = spec.clone(); free.joints.clear();
    assert_ne!(summarize(&result.frames).pose_bits_sha256, summarize(&run_scene(&free).frames).pose_bits_sha256);
    let mut weightless = spec.clone(); weightless.gravity = [0.0; 3];
    assert_ne!(summarize(&result.frames).pose_bits_sha256, summarize(&run_scene(&weightless).frames).pose_bits_sha256);
}

#[test]
fn multibody_cycles_and_duplicate_parents_fail_instead_of_dropping_joints() {
    for cycle in [false, true] {
        let mut spec = fixture();
        let mut extra = spec.joints[0].clone(); extra.id = "invalid-extra".into();
        if cycle { extra.body1 = "link-c".into(); extra.body2 = "ground".into(); }
        spec.joints.push(extra);
        assert!(std::panic::catch_unwind(|| run_scene(&spec)).is_err());
    }
}

#[test]
fn multibody_controls_are_rejected_and_f06_golden_remains_unchanged() {
    let mut spec = fixture(); spec.joints[0].limits = Some([-0.2, 0.2]);
    assert!(parse_spec(&serde_json::to_vec(&spec).unwrap()).is_err());
    let legacy = parse_spec(include_bytes!("../scene-spec-f06-motor-limits.json")).unwrap();
    spec.joints[0].limits = None; spec.joints[0].motor = legacy.joints[0].motor.clone();
    assert!(parse_spec(&serde_json::to_vec(&spec).unwrap()).is_err());
    let summary = summarize(&run_scene(&legacy).frames);
    assert_eq!(summary.pose_bits_sha256, "bbbe5f3b1863188641cf4ed9440163760dd9767539a3feae0dc90d326bbdee28");
    assert_eq!(summary.frame_sequence_sha256, "c1856b172625a5beb3900e577a86d02842261a3d1b744b859f12a015a44aa21e");
}
