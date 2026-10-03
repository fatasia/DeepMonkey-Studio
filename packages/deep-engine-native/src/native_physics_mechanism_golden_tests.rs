//! T17 机构驱动黄金收官:活塞-曲柄、传动比、滑块导轨、组合机构。
//!
//! 全部为 `#[cfg(test)]`,不进入发布产物。参数与 Web
//! `apps/web/src/viewer/rapierPistonCrankGolden.test.ts` /
//! `rapierSliderTransmissionGolden.test.ts` 逐项对齐;改任何参数必须两侧同步,
//! 否则跨端配对数据作废。
//!
//! 零重力隔离机构运动学;1/60 s 固定步长;马达 targetVelocity/strength、限位、
//! prismatic(米/m·s⁻¹)语义与 revolute(弧度/rad·s⁻¹)同表。
//! collider 沿 z 错层与 Web 端逐项一致(相邻杆件在关节销处体积重叠,保留杆间
//! 接触会把机构内部炸开;z 错层与 z 轴旋转正交,分离永久成立)。

use super::mechanism_golden_support::*;
use super::NativePhysicsHost;
use crate::contract::RenderPacket;
use crate::runtime_package::parse_and_validate_dynamic_scene_runtime;

// ─── 组 1:活塞-曲柄(曲柄滑块) ───────────────────────────────────────────

fn piston_runtime_value() -> serde_json::Value {
    serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3, "id": "piston-golden", "revision": 1,
        "physics": {"schema": "deep-engine.physics-runtime", "schemaVersion": 1, "enabled": true,
            "playing": true, "gravity": [0.0, 0.0, 0.0],
            "bodies": [
                mech_body("body-crank", [0.025, 0.0, 0.0], 0.5, "piston-crank"),
                mech_body("body-piston", [0.2, 0.0, 0.0], 0.5, "piston-head"),
                mech_body("body-rod", [0.125, 0.0, 0.0], 0.2, "piston-rod"),
            ], "joints": [
                mech_joint("j1-crank-world", "revolute", "body-crank", None,
                    [0.0, 0.0, 0.0], [-0.025, 0.0, 0.0], [0.0, 0.0, 1.0], None, Some((MOTOR_TARGET_VELOCITY, MOTOR_STRENGTH))),
                mech_joint("j2-crank-rod", "revolute", "body-rod", Some("body-crank"),
                    [0.05, 0.0, 0.0], [-0.075, 0.0, 0.0], [0.0, 0.0, 1.0], None, None),
                mech_joint("j3-rod-piston", "revolute", "body-piston", Some("body-rod"),
                    [0.2, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], None, None),
                mech_joint("j4-piston-world", "prismatic", "body-piston", None,
                    [0.2, 0.0, 0.0], [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], None, None),
            ]}
    })
}

fn piston_packet() -> RenderPacket {
    // collider 沿 z 错层(与 Web buildBody 的 setTranslation 逐项一致)。
    mech_packet(
        &[
            (
                "piston-crank",
                cuboid_vertices([0.025, 0.0, 0.03], [0.025, 0.01, 0.01]),
            ),
            (
                "piston-rod",
                cuboid_vertices([0.125, 0.0, -0.03], [0.075, 0.01, 0.01]),
            ),
            (
                "piston-head",
                cuboid_vertices([0.2, 0.0, 0.03], [0.02, 0.02, 0.02]),
            ),
        ],
        &[
            ("piston-crank", "piston-crank", [0.025, 0.0, 0.0]),
            ("piston-rod", "piston-rod", [0.125, 0.0, 0.0]),
            ("piston-head", "piston-head", [0.2, 0.0, 0.0]),
        ],
    )
}

/// 逐步返回活塞平移与曲柄连续转角。
fn run_piston() -> (Vec<[f32; 3]>, Vec<f32>) {
    let runtime = parse_and_validate_dynamic_scene_runtime(&piston_runtime_value()).unwrap();
    let mut packet = piston_packet();
    let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .expect("piston runtime must produce a host");
    let mut positions = Vec::with_capacity(PISTON_STEPS);
    let mut angles = Vec::with_capacity(PISTON_STEPS);
    for _ in 0..PISTON_STEPS {
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 3);
        let binding = host
            .bindings
            .iter()
            .find(|binding| {
                binding
                    .instances
                    .iter()
                    .any(|(instance, _)| instance == "piston-head")
            })
            .expect("piston binding");
        let body = host.bodies.get(binding.handle).expect("piston body");
        let t = body.translation();
        positions.push([t.x, t.y, t.z]);
        let crank = host
            .bindings
            .iter()
            .find(|binding| {
                binding
                    .instances
                    .iter()
                    .any(|(instance, _)| instance == "piston-crank")
            })
            .expect("crank binding");
        let crank_body = host.bodies.get(crank.handle).expect("crank body");
        let r = crank_body.rotation().normalize();
        angles.push(unwrap_angle(
            angles.last().copied(),
            quat_z_angle(&[r.x, r.y, r.z, r.w]),
        ));
    }
    (positions, angles)
}

#[test]
fn piston_crank_tracks_the_analytic_stroke_and_repeats_bit_exactly() {
    let (first_positions, first_angles) = run_piston();
    let (repeat_positions, repeat_angles) = run_piston();
    assert_eq!(
        first_positions, repeat_positions,
        "same input must repeat exactly"
    );
    assert_eq!(first_angles, repeat_angles);
    assert_piston_kinematics(&first_positions, &first_angles);
}

#[test]
fn piston_records_per_step_poses_for_cross_end_tolerance_pairing() {
    let (positions, _) = run_piston();
    let payload = serde_json::json!({
        "meta": {
            "end": "native", "rapier": "0.35.3", "scenario": "piston-crank",
            "crankRadius": CRANK_RADIUS, "rodLength": ROD_LENGTH,
            "motorTargetVelocity": MOTOR_TARGET_VELOCITY, "motorStrength": MOTOR_STRENGTH,
            "gravity": [0.0, 0.0, 0.0], "fixedStepSeconds": 1.0 / 60.0, "steps": PISTON_STEPS,
            "solverIterations": 8, "damping": {"linear": 0, "angular": 0},
            "bodies": ["piston-head"],
        },
        "positions": positions,
    });
    write_pairing("native-piston-poses.json", payload);
}

// ─── 组 2:传动比(1:1 刚性耦合 / 2:1 目标耦合) ──────────────────────────

fn spin_runtime_value(
    a_id: &str,
    b_id: &str,
    b_joint: serde_json::Value,
    a_motor: f64,
) -> serde_json::Value {
    serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3, "id": format!("{a_id}-golden"), "revision": 1,
        "physics": {"schema": "deep-engine.physics-runtime", "schemaVersion": 1, "enabled": true,
            "playing": true, "gravity": [0.0, 0.0, 0.0],
            "bodies": [
                mech_body(a_id, [0.0, 0.0, 0.0], 0.6, format!("{a_id}-inst").as_str()),
                mech_body(b_id, [0.0, 0.0, -0.04], 0.6, format!("{b_id}-inst").as_str()),
            ], "joints": [
                mech_joint(format!("j1-{a_id}-world").as_str(), "revolute", a_id, None,
                    [0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], None, Some((a_motor, 10.0))),
                b_joint,
            ]}
    })
}

fn spin_packet(a_id: &str, b_id: &str) -> RenderPacket {
    // 两轮 collider 沿 z 反向错层 0.045(与 Web addBody 的 setTranslation 逐项一致)。
    mech_packet(
        &[
            (
                format!("{a_id}-inst").as_str(),
                cuboid_vertices([0.0, 0.0, 0.045], [0.05, 0.05, 0.01]),
            ),
            (
                format!("{b_id}-inst").as_str(),
                cuboid_vertices([0.0, 0.0, -0.085], [0.05, 0.05, 0.01]),
            ),
        ],
        &[
            (
                format!("{a_id}-inst").as_str(),
                format!("{a_id}-inst").as_str(),
                [0.0, 0.0, 0.0],
            ),
            (
                format!("{b_id}-inst").as_str(),
                format!("{b_id}-inst").as_str(),
                [0.0, 0.0, -0.04],
            ),
        ],
    )
}

fn run_spin(
    a_id: &str,
    b_id: &str,
    b_joint: serde_json::Value,
    a_motor: f64,
) -> Vec<([f32; 4], [f32; 4])> {
    let runtime =
        parse_and_validate_dynamic_scene_runtime(&spin_runtime_value(a_id, b_id, b_joint, a_motor))
            .unwrap();
    let mut packet = spin_packet(a_id, b_id);
    let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .expect("spin runtime must produce a host");
    let binding_of = |host: &NativePhysicsHost, instance: &str| {
        host.bindings
            .iter()
            .find(|binding| binding.instances.iter().any(|(id, _)| id == instance))
            .unwrap_or_else(|| panic!("{instance} binding"))
            .handle
    };
    let a_handle = binding_of(&host, &format!("{a_id}-inst"));
    let b_handle = binding_of(&host, &format!("{b_id}-inst"));
    let mut quats = Vec::with_capacity(SPIN_STEPS);
    for _step in 0..SPIN_STEPS {
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 2);
        let qa = host
            .bodies
            .get(a_handle)
            .expect("a body")
            .rotation()
            .normalize();
        let qb = host
            .bodies
            .get(b_handle)
            .expect("b body")
            .rotation()
            .normalize();
        quats.push(([qa.x, qa.y, qa.z, qa.w], [qb.x, qb.y, qb.z, qb.w]));
    }
    quats
}

#[test]
fn rigid_shaft_coupling_keeps_the_ratio_locked_and_repeats_bit_exactly() {
    // 1:1 刚性联轴器:revolute 限位 [0,0] 锁死相对转动(普通 revolute 允许相对转)。
    let b_joint = mech_joint(
        "j2-body-shaft-b-a",
        "revolute",
        "body-shaft-b",
        Some("body-shaft-a"),
        [0.0, 0.0, 0.0],
        [0.0, 0.0, 0.04],
        [0.0, 0.0, 1.0],
        Some((0.0, 0.0)),
        None,
    );
    let first = run_spin("body-shaft-a", "body-shaft-b", b_joint.clone(), 2.0);
    let repeat = run_spin("body-shaft-a", "body-shaft-b", b_joint, 2.0);
    assert_eq!(first, repeat, "same input must repeat exactly");

    let mut angles_a = Vec::with_capacity(SPIN_STEPS);
    let mut angles_b = Vec::with_capacity(SPIN_STEPS);
    for (qa, qb) in &first {
        angles_a.push(unwrap_angle(angles_a.last().copied(), quat_z_angle(qa)));
        angles_b.push(unwrap_angle(angles_b.last().copied(), quat_z_angle(qb)));
    }
    let worst = angles_a
        .iter()
        .zip(&angles_b)
        .fold(0.0f32, |acc, (a, b)| acc.max((a - b).abs()));
    println!("MECH[native-coupling1to1] worstAngleDiff={worst:.5}rad");
    assert!(
        worst < RIGID_ANGLE_TOLERANCE,
        "coupling angle difference {worst}"
    );
    let window = SPIN_STEPS - STEADY_START;
    let dt = window as f32 / 60.0;
    let rate_a = (angles_a[SPIN_STEPS - 1] - angles_a[STEADY_START]) / dt;
    let rate_b = (angles_b[SPIN_STEPS - 1] - angles_b[STEADY_START]) / dt;
    let ratio = rate_b / rate_a;
    println!("MECH[native-coupling1to1] steadyRatio={ratio:.5}");
    assert!(
        (1.0 - RIGID_RATIO_BAND..=1.0 + RIGID_RATIO_BAND).contains(&ratio),
        "ratio {ratio}"
    );
}

#[test]
fn ratio_coupled_motors_hold_the_2to1_transmission_and_repeats_bit_exactly() {
    // 合同无齿轮啮合约束:传动比 2:1 用两个旋转关节的马达目标按传动比耦合表达
    // (外啮合反向)——这是驱动目标耦合而非几何啮合,报告中如实说明。
    // 马达目标取 +2/-4:Rapier 0.35 的睡眠判据按"最远点速度"(≈|ω|×max_extent)与
    // 0.05 m/s 阈值比较,+1 rad/s 的低速轮会被判 0.5 s 静止而睡眠(Web 0.19 旧判据
    // 不睡,两端语义差异);2 rad/s 起留 2 倍裕量。
    let b_joint = mech_joint(
        "j2-body-gear-b-world",
        "revolute",
        "body-gear-b",
        None,
        [0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0],
        [0.0, 0.0, 1.0],
        None,
        Some((-4.0, 10.0)),
    );
    let first = run_spin("body-gear-a", "body-gear-b", b_joint.clone(), 2.0);
    let repeat = run_spin("body-gear-a", "body-gear-b", b_joint, 2.0);
    assert_eq!(first, repeat, "same input must repeat exactly");

    // 末窗平均角速度:连续角差分(主值平均会因 ±π 回卷失真)。
    let mut angles_a = Vec::with_capacity(SPIN_STEPS);
    let mut angles_b = Vec::with_capacity(SPIN_STEPS);
    for (qa, qb) in &first {
        angles_a.push(unwrap_angle(angles_a.last().copied(), quat_z_angle(qa)));
        angles_b.push(unwrap_angle(angles_b.last().copied(), quat_z_angle(qb)));
    }
    let window = SPIN_STEPS - STEADY_START;
    let dt = window as f32 / 60.0;
    let rate_a = (angles_a[SPIN_STEPS - 1] - angles_a[STEADY_START]) / dt;
    let rate_b = (angles_b[SPIN_STEPS - 1] - angles_b[STEADY_START]) / dt;
    let ratio = rate_b / rate_a;
    println!("MECH[native-gear2to1] rateA={rate_a:.4} rateB={rate_b:.4} ratio={ratio:.4}");
    let tolerance = 2.0 * TARGET_RATIO_RELATIVE_TOLERANCE;
    assert!(
        (ratio - -2.0).abs() <= tolerance,
        "measured ratio {ratio} off the 2:1 band"
    );

    // 端到端比恒定:窗口内单步角速度比的极差受限(取稳态段抽样)。
    let sample_window = &angles_a[STEADY_START..STEADY_START + 40];
    let mut sample_rates = Vec::new();
    for i in 1..sample_window.len() {
        sample_rates.push(
            (angles_b[STEADY_START + i] - angles_b[STEADY_START + i - 1])
                / (angles_a[STEADY_START + i] - angles_a[STEADY_START + i - 1]),
        );
    }
    let spread = sample_rates
        .iter()
        .cloned()
        .fold(f32::NEG_INFINITY, f32::max)
        - sample_rates.iter().cloned().fold(f32::INFINITY, f32::min);
    assert!(spread < 0.05, "ratio spread {spread}");
}
