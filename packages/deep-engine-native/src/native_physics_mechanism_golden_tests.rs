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

use super::*;
use crate::runtime_package::parse_and_validate_dynamic_scene_runtime;

const PISTON_STEPS: usize = 360;
const SLIDER_STEPS: usize = 240;
const SPIN_STEPS: usize = 240;
/// 稳态窗口起点(第 2 转起),周期/对称性/角速度在窗口内测量。
const STEADY_START: usize = 120;
const PERIOD_STEPS: f32 = 120.0;
const MOTOR_TARGET_VELOCITY: f64 = std::f64::consts::PI;
const MOTOR_STRENGTH: f64 = 20.0;
const CRANK_RADIUS: f64 = 0.05;
const ROD_LENGTH: f64 = 0.15;
/// 行程容差(米):解析值 0.1。
const STROKE_TOLERANCE: f32 = 5e-3;
/// 活塞导轨直线度:y/z 全程最大漂移(米)。
const GUIDE_DRIFT_METERS: f32 = 2e-3;
const PERIOD_TOLERANCE_STEPS: i32 = 6;
/// 升程/降程步数与解析预测的容差。
const STROKE_ASYMMETRY_STEPS: f32 = 4.0;
const CRANK_RATE_RELATIVE_TOLERANCE: f32 = 0.02;
/// 端到端解析对照最大偏差(米)。
const ANALYTIC_TOLERANCE_METERS: f32 = 8e-3;
const SLIDER_LIMIT: f64 = 0.08;
const SLIDER_MOTOR_VELOCITY: f64 = 0.4;
const SLIDER_MOTOR_STRENGTH: f64 = 10.0;
const SLIDER_FINAL_MIN: f32 = 0.075;
const SLIDER_FINAL_MAX: f32 = 0.085;
const SLIDER_OVERSHOOT: f32 = 5e-3;
const SLIDER_TRAVEL_STEPS: usize = 12;
const SLIDER_TRAVEL_TOLERANCE_STEPS: usize = 4;
const SLIDER_GUIDE_DRIFT: f32 = 1e-3;
const SLIDER_TILT_RADIANS: f32 = 0.01;
/// 1:1 刚性耦合:全程转角差上限(弧度)与末窗角速度比半带宽。
const RIGID_ANGLE_TOLERANCE: f32 = 0.02;
const RIGID_RATIO_BAND: f32 = 0.01;
/// 2:1 目标耦合:末窗实测角速度比相对目标的容差(相对)。
const TARGET_RATIO_RELATIVE_TOLERANCE: f32 = 0.03;

fn mech_body(id: &str, translation: [f64; 3], mass: f64, instance: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "type": "dynamic",
        "initialPose": {"translation": translation, "rotation": [0, 0, 0, 1]},
        "mass": mass, "friction": 0.6, "restitution": 0,
        "collider": {"kind": "render-bounds", "instanceIds": [instance]}
    })
}

#[allow(clippy::too_many_arguments)]
fn mech_joint(
    id: &str,
    kind: &str,
    body_id: &str,
    connected: Option<&str>,
    world_anchor: [f64; 3],
    local_anchor: [f64; 3],
    axis: [f64; 3],
    limits: Option<(f64, f64)>,
    motor: Option<(f64, f64)>,
) -> serde_json::Value {
    let (limits_json, motor_json) = (
        match limits {
            Some((min, max)) => serde_json::json!({"enabled": true, "min": min, "max": max}),
            None => serde_json::json!({"enabled": false, "min": -1, "max": 1}),
        },
        match motor {
            Some((target, strength)) => {
                serde_json::json!({"enabled": true, "targetVelocity": target, "strength": strength})
            }
            None => serde_json::json!({"enabled": false, "targetVelocity": 0, "strength": 0}),
        },
    );
    serde_json::json!({
        "id": id, "kind": kind, "solver": "impulse", "bodyId": body_id,
        "connectedBodyId": connected,
        "worldAnchor": world_anchor, "localAnchor": local_anchor, "axis": axis,
        "limits": limits_json,
        "motor": motor_json
    })
}

/// 轴对齐盒的 packet 顶点(世界系,每顶点 6 浮点=位置+法线;对角+中点三点撑出 AABB)。
fn cuboid_vertices(center: [f64; 3], half: [f64; 3]) -> serde_json::Value {
    serde_json::json!([
        center[0] - half[0],
        center[1] - half[1],
        center[2] - half[2],
        0,
        1,
        0,
        center[0] + half[0],
        center[1] + half[1],
        center[2] + half[2],
        0,
        1,
        0,
        center[0],
        center[1],
        center[2],
        0,
        1,
        0,
    ])
}

fn mech_packet(
    geometries: &[(&str, serde_json::Value)],
    instances: &[(&str, &str, [f64; 3])],
) -> RenderPacket {
    serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet", "version": 1,
        "geometries": geometries.iter().map(|(id, vertices)| {
            serde_json::json!({"id": id, "revision": 1, "vertices": vertices, "indices": [0, 1, 2]})
        }).collect::<Vec<_>>(),
        "materials": [{"id": "mat", "baseColor": [1.0, 1.0, 1.0], "metallic": 0, "roughness": 1}],
        "instances": instances.iter().map(|(id, geometry, translation)| {
            serde_json::json!({"id": id, "geometry": geometry, "material": "mat",
             "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
                           translation[0], translation[1], translation[2], 1]})
        }).collect::<Vec<_>>()
    }))
    .unwrap()
}

fn unwrap_angle(previous: Option<f32>, raw: f32) -> f32 {
    let Some(previous) = previous else {
        return raw;
    };
    let mut value = raw;
    while value - previous > std::f32::consts::PI {
        value -= 2.0 * std::f32::consts::PI;
    }
    while previous - value > std::f32::consts::PI {
        value += 2.0 * std::f32::consts::PI;
    }
    value
}

/// 绕 z 的主值角(四元数组 [x, y, z, w])。
fn quat_z_angle(r: &[f32; 4]) -> f32 {
    2.0 * r[2].atan2(r[3])
}

/// 中线穿越事件(up=由下而上,down=由上而下),返回相对 `start` 的步索引。
fn midline_crossings(samples: &[f32], start: usize) -> (Vec<usize>, Vec<usize>) {
    let window = &samples[start..];
    let mid = (window.iter().cloned().fold(f32::NEG_INFINITY, f32::max)
        + window.iter().cloned().fold(f32::INFINITY, f32::min))
        / 2.0;
    let mut up = Vec::new();
    let mut down = Vec::new();
    for i in 1..window.len() {
        if window[i - 1] < mid && window[i] >= mid {
            up.push(start + i);
        }
        if window[i - 1] >= mid && window[i] < mid {
            down.push(start + i);
        }
    }
    (up, down)
}

fn write_pairing(name: &str, payload: serde_json::Value) {
    let directory = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-output/t17-mechanism"
    );
    std::fs::create_dir_all(directory).expect("create mechanism pairing directory");
    let path = format!("{directory}/{name}");
    std::fs::write(&path, serde_json::to_string(&payload).unwrap())
        .expect("write mechanism pairing poses");
}

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

fn assert_piston_kinematics(positions: &[[f32; 3]], angles: &[f32]) {
    let stroke = positions
        .iter()
        .fold(f32::NEG_INFINITY, |acc, p| acc.max(p[0]))
        - positions.iter().fold(f32::INFINITY, |acc, p| acc.min(p[0]));
    let lateral = positions
        .iter()
        .fold(0.0f32, |acc, p| acc.max(p[1].abs()).max(p[2].abs()));
    println!("MECH[native-piston] stroke={stroke:.4}m lateralDrift={lateral:.3e}m");
    assert!(
        (0.1 - STROKE_TOLERANCE..=0.1 + STROKE_TOLERANCE).contains(&stroke),
        "piston stroke {stroke} outside the analytic band"
    );
    assert!(
        lateral < GUIDE_DRIFT_METERS,
        "piston lateral drift {lateral}"
    );

    let xs: Vec<f32> = positions.iter().map(|p| p[0]).collect();
    let (up, down) = midline_crossings(&xs, STEADY_START);
    assert!(up.len() >= 2, "steady-window up-crossings {}", up.len());
    let period = up[up.len() - 1] - up[up.len() - 2];
    let rise = down
        .iter()
        .rev()
        .find(|d| **d < up[up.len() - 1])
        .map(|d| d - up[up.len() - 2]);
    let fall = period - rise.expect("down-crossing inside the period");
    // 解析:中线 L 处 cosθ = r/(2L);半程角 2·acos(r/(2L))。
    let phi = (CRANK_RADIUS as f32 / (2.0 * ROD_LENGTH as f32)).acos();
    let expected_rise = PERIOD_STEPS * phi / std::f32::consts::PI;
    let expected_fall = PERIOD_STEPS - expected_rise;
    println!(
        "MECH[native-piston] period={period}steps rise={rise:?} fall={fall} (analytic {expected_rise:.1}/{expected_fall:.1})"
    );
    assert!(
        (period as i32 - PERIOD_STEPS as i32).abs() <= PERIOD_TOLERANCE_STEPS,
        "period {period} steps off the analytic period"
    );
    assert!(
        (rise.unwrap() as f32 - expected_rise).abs() <= STROKE_ASYMMETRY_STEPS
            && ((fall as f32) - expected_fall).abs() <= STROKE_ASYMMETRY_STEPS,
        "rise/fall {rise:?}/{fall} off the analytic band"
    );

    let window = PERIOD_STEPS as usize;
    let elapsed = angles[angles.len() - 1] - angles[angles.len() - 1 - window];
    let rate = elapsed / (window as f32 / 60.0);
    let relative = (rate - MOTOR_TARGET_VELOCITY as f32).abs() / MOTOR_TARGET_VELOCITY as f32;
    println!("MECH[native-piston] crankRate={rate:.4}rad/s (rel {relative:.2e})");
    assert!(
        relative <= CRANK_RATE_RELATIVE_TOLERANCE,
        "crank rate {rate}"
    );
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
