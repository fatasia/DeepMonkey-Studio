use physics_validate::{parse_spec, run_scene, summarize, SceneSpec};

fn fixture() -> SceneSpec {
    parse_spec(include_bytes!("../scene-spec-f06-motor-limits.json")).unwrap()
}

fn final_angles(spec: &SceneSpec) -> Vec<f32> {
    run_scene(spec).frames.last().unwrap().bodies.iter()
        .map(|(_, pose)| 2.0 * pose[5].atan2(pose[6])).collect()
}

#[test]
fn motor_reaches_target_and_both_limits_actually_constrain_motion() {
    let spec = fixture();
    let first = run_scene(&spec);
    let second = run_scene(&spec);
    assert_eq!(summarize(&first.frames).pose_bits_sha256, summarize(&second.frames).pose_bits_sha256);
    for (actual, expected) in final_angles(&spec).iter().zip([0.35, -0.35, 0.2]) {
        assert!((actual - expected).abs() < 0.002, "actual={actual}, expected={expected}");
    }
    let mut unpowered = spec.clone();
    for joint in &mut unpowered.joints { joint.motor = None; }
    assert!(final_angles(&unpowered).iter().all(|angle| angle.abs() < 0.000001));
    let mut unlimited = spec.clone();
    for joint in &mut unlimited.joints { joint.limits = None; }
    let angles = final_angles(&unlimited);
    assert!(angles[0] > 0.9 && angles[1] < -0.9, "without limits: {angles:?}");
    assert_ne!(summarize(&first.frames).pose_bits_sha256, summarize(&run_scene(&unpowered).frames).pose_bits_sha256);
    assert_ne!(summarize(&first.frames).pose_bits_sha256, summarize(&run_scene(&unlimited).frames).pose_bits_sha256);
}

#[test]
fn invalid_joint_controls_are_rejected_before_world_construction() {
    let input = serde_json::to_value(fixture()).unwrap();
    for (field, value) in [
        ("limits", serde_json::json!([1, -1])),
        ("limits", serde_json::json!([0, 1e100])),
        ("limits", serde_json::json!([0])),
        ("motor", serde_json::json!({"targetPosition":0,"targetVelocity":0,"stiffness":-1,"damping":4,"model":"force"})),
        ("motor", serde_json::json!({"targetPosition":0,"targetVelocity":0,"stiffness":1,"damping":4,"model":"unknown"})),
    ] {
        let mut invalid = input.clone();
        invalid["joints"][0][field] = value;
        assert!(parse_spec(&serde_json::to_vec(&invalid).unwrap()).is_err(), "{invalid}");
    }
}

#[test]
fn legacy_f04_f05_pose_and_canonical_hashes_do_not_change() {
    for (input, poses, canonical) in [
        (include_bytes!("../scene-spec-f04-revolute.json").as_slice(),
         "61088dedfdc8435ec863ea1bbb1fc98c5d1957ffb3ea4fa78793fab8d3548b6a",
         "f182e538bd42664bfef091a40df3117c6382b40ff7efc5f927dcd072149fc3b6"),
        (include_bytes!("../scene-spec-f05-chain.json").as_slice(),
         "78db6b95dfd33e26dc24c49a3e7fe2477244009819a5cf09316f41b8e743d76f",
         "b228b40afd9c3088dfdf48af6480cafe771f2baf300d2c540fc707ec83b2b9c0"),
    ] {
        let result = summarize(&run_scene(&parse_spec(input).unwrap()).frames);
        assert_eq!(result.pose_bits_sha256, poses);
        assert_eq!(result.frame_sequence_sha256, canonical);
    }
}
