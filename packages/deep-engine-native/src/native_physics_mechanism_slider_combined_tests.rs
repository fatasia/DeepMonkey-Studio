//! T17 机构驱动黄金测试(滑块导轨 + 组合机构),自 `native_physics_mechanism_golden_tests.rs`
//! 按测试主题原样拆出;共享常量与夹具在 `native_physics_mechanism_golden_support.rs`。
//! 逐字未改,仅调整导入路径与可见性。

use super::mechanism_golden_support::*;
use super::NativePhysicsHost;
use crate::contract::RenderPacket;
use crate::runtime_package::parse_and_validate_dynamic_scene_runtime;

// ─── 组 3:滑块导轨(prismatic 冲程-钳制) ─────────────────────────────────

fn slider_runtime_value(limits_enabled: bool) -> serde_json::Value {
    serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3, "id": "slider-golden", "revision": 1,
        "physics": {"schema": "deep-engine.physics-runtime", "schemaVersion": 1, "enabled": true,
            "playing": true, "gravity": [0.0, 0.0, 0.0],
            "bodies": [mech_body("body-slider", [0.0, 0.0, 0.0], 0.5, "slider-block")], "joints": [
                mech_joint("j1-slider-world", "prismatic", "body-slider", None,
                    [0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [1.0, 0.0, 0.0],
                    if limits_enabled { Some((-SLIDER_LIMIT, SLIDER_LIMIT)) } else { None },
                    Some((SLIDER_MOTOR_VELOCITY, SLIDER_MOTOR_STRENGTH))),
            ]}
    })
}

fn slider_packet() -> RenderPacket {
    mech_packet(
        &[(
            "slider-block",
            cuboid_vertices([0.0, 0.0, 0.0], [0.03, 0.02, 0.02]),
        )],
        &[("slider-block", "slider-block", [0.0, 0.0, 0.0])],
    )
}

fn run_slider(limits_enabled: bool) -> Vec<[f32; 3]> {
    let runtime =
        parse_and_validate_dynamic_scene_runtime(&slider_runtime_value(limits_enabled)).unwrap();
    let mut packet = slider_packet();
    let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .expect("slider runtime must produce a host");
    let mut positions = Vec::with_capacity(SLIDER_STEPS);
    for _ in 0..SLIDER_STEPS {
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 1);
        let binding = host
            .bindings
            .iter()
            .find(|binding| {
                binding
                    .instances
                    .iter()
                    .any(|(instance, _)| instance == "slider-block")
            })
            .expect("slider binding");
        let body = host.bodies.get(binding.handle).expect("slider body");
        let t = body.translation();
        positions.push([t.x, t.y, t.z]);
    }
    positions
}

fn assert_slider_rail(positions: &[[f32; 3]]) {
    let arrival = positions
        .iter()
        .position(|p| p[0] > (SLIDER_LIMIT - 5e-3) as f32)
        .expect("slider must reach the authored travel");
    let final_x = positions[SLIDER_STEPS - 1][0];
    let peak_x = positions
        .iter()
        .fold(f32::NEG_INFINITY, |acc, p| acc.max(p[0]));
    let lateral = positions
        .iter()
        .fold(0.0f32, |acc, p| acc.max(p[1].abs()).max(p[2].abs()));
    println!(
        "MECH[native-slider] arrival={arrival} final={final_x:.4} peakX={peak_x:.4} lateralDrift={lateral:.3e}m"
    );
    assert!(
        arrival <= SLIDER_TRAVEL_STEPS + SLIDER_TRAVEL_TOLERANCE_STEPS,
        "slider arrival at step {arrival}"
    );
    assert!(
        (SLIDER_FINAL_MIN..=SLIDER_FINAL_MAX).contains(&final_x),
        "slider final x {final_x} outside the clamped band"
    );
    assert!(
        peak_x <= (SLIDER_LIMIT as f32) + SLIDER_OVERSHOOT,
        "slider peak {peak_x}"
    );
    assert!(lateral < SLIDER_GUIDE_DRIFT, "rail lateral drift {lateral}");
}

#[test]
fn slider_rail_clamps_travel_drift_free_and_repeats_bit_exactly() {
    let first = run_slider(true);
    let repeat = run_slider(true);
    assert_eq!(first, repeat, "same input must repeat exactly");
    assert_slider_rail(&first);
    // 无限位对照组:同马达冲出限位区间,证明钳制来自限位而非马达力度不足。
    let control = run_slider(false);
    let control_final = control[SLIDER_STEPS - 1][0];
    println!("MECH[native-slider] unlimitedControl final={control_final:.4}");
    assert!(
        control_final > SLIDER_LIMIT as f32 + 0.02,
        "control final {control_final}"
    );
}

#[test]
fn slider_records_per_step_poses_for_cross_end_tolerance_pairing() {
    let positions = run_slider(true);
    let payload = serde_json::json!({
        "meta": {
            "end": "native", "rapier": "0.35.3", "scenario": "slider-rail",
            "limit": SLIDER_LIMIT, "motorTargetVelocity": SLIDER_MOTOR_VELOCITY,
            "motorStrength": SLIDER_MOTOR_STRENGTH,
            "gravity": [0.0, 0.0, 0.0], "fixedStepSeconds": 1.0 / 60.0, "steps": SLIDER_STEPS,
            "solverIterations": 8, "damping": {"linear": 0, "angular": 0},
            "bodies": ["slider-block"],
        },
        "positions": positions,
    });
    write_pairing("native-slider-poses.json", payload);
}

// ─── 组 4:组合机构(轴耦合 + 曲柄滑块,端到端) ────────────────────────────

fn combined_runtime_value() -> serde_json::Value {
    serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3, "id": "combo-golden", "revision": 1,
        "physics": {"schema": "deep-engine.physics-runtime", "schemaVersion": 1, "enabled": true,
            "playing": true, "gravity": [0.0, 0.0, 0.0],
            "bodies": [
                mech_body("body-crank-arm", [0.025, 0.0, 0.0], 0.5, "combo-arm"),
                mech_body("body-drive", [0.0, 0.0, 0.0], 0.6, "combo-drive"),
                mech_body("body-piston", [0.2, 0.0, 0.0], 0.5, "combo-piston"),
                mech_body("body-rod", [0.125, 0.0, 0.0], 0.2, "combo-rod"),
            ], "joints": [
                mech_joint("j1-drive-world", "revolute", "body-drive", None,
                    [0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], None, Some((MOTOR_TARGET_VELOCITY, MOTOR_STRENGTH))),
                mech_joint("j2-arm-drive", "revolute", "body-crank-arm", Some("body-drive"),
                    [0.0, 0.0, 0.0], [-0.025, 0.0, 0.0], [0.0, 0.0, 1.0], Some((0.0, 0.0)), None),
                mech_joint("j3-arm-rod", "revolute", "body-rod", Some("body-crank-arm"),
                    [0.05, 0.0, 0.0], [-0.075, 0.0, 0.0], [0.0, 0.0, 1.0], None, None),
                mech_joint("j4-rod-piston", "revolute", "body-piston", Some("body-rod"),
                    [0.2, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], None, None),
                mech_joint("j5-piston-world", "prismatic", "body-piston", None,
                    [0.2, 0.0, 0.0], [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], None, None),
            ]}
    })
}

fn combined_packet() -> RenderPacket {
    mech_packet(
        &[
            (
                "combo-drive",
                cuboid_vertices([0.0, 0.0, 0.05], [0.05, 0.05, 0.01]),
            ),
            (
                "combo-arm",
                cuboid_vertices([0.025, 0.0, -0.05], [0.025, 0.01, 0.01]),
            ),
            (
                "combo-rod",
                cuboid_vertices([0.125, 0.0, 0.015], [0.075, 0.01, 0.01]),
            ),
            (
                "combo-piston",
                cuboid_vertices([0.2, 0.0, -0.05], [0.02, 0.02, 0.02]),
            ),
        ],
        &[
            ("combo-drive", "combo-drive", [0.0, 0.0, 0.0]),
            ("combo-arm", "combo-arm", [0.025, 0.0, 0.0]),
            ("combo-rod", "combo-rod", [0.125, 0.0, 0.0]),
            ("combo-piston", "combo-piston", [0.2, 0.0, 0.0]),
        ],
    )
}

fn run_combined() -> (Vec<[f32; 3]>, Vec<f32>, Vec<f32>) {
    let runtime = parse_and_validate_dynamic_scene_runtime(&combined_runtime_value()).unwrap();
    let mut packet = combined_packet();
    let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .expect("combined runtime must produce a host");
    let binding_of = |host: &NativePhysicsHost, instance: &str| {
        host.bindings
            .iter()
            .find(|binding| binding.instances.iter().any(|(id, _)| id == instance))
            .unwrap_or_else(|| panic!("{instance} binding"))
            .handle
    };
    let piston_handle = binding_of(&host, "combo-piston");
    let arm_handle = binding_of(&host, "combo-arm");
    let drive_handle = binding_of(&host, "combo-drive");
    let mut positions = Vec::with_capacity(PISTON_STEPS);
    let mut arm_angles = Vec::with_capacity(PISTON_STEPS);
    let mut drive_angles = Vec::with_capacity(PISTON_STEPS);
    for _ in 0..PISTON_STEPS {
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 4);
        let t = host
            .bodies
            .get(piston_handle)
            .expect("piston body")
            .translation();
        positions.push([t.x, t.y, t.z]);
        let qa = host
            .bodies
            .get(arm_handle)
            .expect("arm body")
            .rotation()
            .normalize();
        arm_angles.push(unwrap_angle(
            arm_angles.last().copied(),
            quat_z_angle(&[qa.x, qa.y, qa.z, qa.w]),
        ));
        let qd = host
            .bodies
            .get(drive_handle)
            .expect("drive body")
            .rotation()
            .normalize();
        drive_angles.push(unwrap_angle(
            drive_angles.last().copied(),
            quat_z_angle(&[qd.x, qd.y, qd.z, qd.w]),
        ));
    }
    (positions, arm_angles, drive_angles)
}

#[test]
fn combined_mechanism_tracks_the_analytic_curve_end_to_end_and_repeats_bit_exactly() {
    let (first_positions, first_arm, first_drive) = run_combined();
    let (repeat_positions, repeat_arm, repeat_drive) = run_combined();
    assert_eq!(
        first_positions, repeat_positions,
        "same input must repeat exactly"
    );
    assert_eq!(first_arm, repeat_arm);
    assert_eq!(first_drive, repeat_drive);
    assert_piston_kinematics(&first_positions, &first_arm);

    // 1:1 轴耦合:末窗平均角速度比。
    let window = PERIOD_STEPS as usize;
    let last = PISTON_STEPS - 1;
    let drive_rate = (first_drive[last] - first_drive[last - window]) / (window as f32 / 60.0);
    let arm_rate = (first_arm[last] - first_arm[last - window]) / (window as f32 / 60.0);
    let ratio = arm_rate / drive_rate;
    println!("MECH[native-combo] armRate={arm_rate:.4} driveRate={drive_rate:.4} ratio={ratio:.4}");
    assert!(
        (0.98..=1.02).contains(&ratio),
        "arm/drive ratio {ratio} outside the 1:1 band"
    );

    // 端到端解析对照:实测曲柄角代入 x(θ),与活塞实测 x 逐点比较(稳态窗口)。
    let mut worst = 0.0f32;
    for i in STEADY_START..PISTON_STEPS {
        let theta = first_arm[i];
        let analytic = (CRANK_RADIUS as f32) * theta.cos()
            + ((ROD_LENGTH as f32).powi(2) - ((CRANK_RADIUS as f32) * theta.sin()).powi(2)).sqrt();
        worst = worst.max((first_positions[i][0] - analytic).abs());
    }
    println!("MECH[native-combo] worstAnalyticDeviation={worst:.5}m");
    assert!(
        worst < ANALYTIC_TOLERANCE_METERS,
        "analytic deviation {worst}"
    );
}

#[test]
fn combined_records_per_step_poses_for_cross_end_tolerance_pairing() {
    let (positions, arm, drive) = run_combined();
    let payload = serde_json::json!({
        "meta": {
            "end": "native", "rapier": "0.35.3", "scenario": "combined-shaft-crank-slider",
            "crankRadius": CRANK_RADIUS, "rodLength": ROD_LENGTH,
            "motorTargetVelocity": MOTOR_TARGET_VELOCITY, "motorStrength": MOTOR_STRENGTH,
            "gravity": [0.0, 0.0, 0.0], "fixedStepSeconds": 1.0 / 60.0, "steps": PISTON_STEPS,
            "solverIterations": 8, "damping": {"linear": 0, "angular": 0},
            "bodies": ["combo-piston", "combo-drive", "combo-arm"],
        },
        "positions": positions,
        "armAngles": arm,
        "driveAngles": drive,
    });
    write_pairing("native-combined-poses.json", payload);
}
