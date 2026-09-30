//! T17 位置马达与齿轮耦合黄金(Web↔Native 双端,本文件为 Native 侧)。
//!
//! 全部为 `#[cfg(test)]`,不进入发布产物。参数与 Web
//! `apps/web/src/viewer/rapierPositionServoGearGolden.test.ts` 逐项对齐;
//! 改任何参数必须两侧同步,否则跨端配对数据作废。
//!
//! 位置马达:`GenericJoint::set_motor_position`(ForceBased)阶跃伺服,断言目标
//! 角/位 ± 容差收敛、越冲上界与双跑逐位确定性(revolute rad / prismatic m)。
//!
//! 齿轮耦合:两端 Rapier 均无原生齿轮约束,以从动侧位置马达伺服跟随实现
//! (`GearCoupling` 每步求解前驱动,target wrap 主值域 + 速度前馈 + 加速度基模型)。
//! 断言主动/从动累计转角比 == 设定比;外啮合反向用负 ratio 表达。

use super::*;
use crate::runtime_package::parse_and_validate_dynamic_scene_runtime;

const SERVO_STEPS: usize = 240;
const GEAR_STEPS: usize = 240;
/// 收敛窗口(末段)与稳态窗口起点。
const SETTLE_WINDOW: usize = 30;
const STEADY_START: usize = 120;
const REVOLUTE_TARGET: f64 = 1.5;
const PRISMATIC_TARGET: f64 = 0.05;
const SERVO_STIFFNESS: f64 = 40.0;
const SERVO_DAMPING: f64 = 12.0;
/// revolute 收敛带(弧度)、prismatic 收敛带(米)与越冲上界。
const REVOLUTE_BAND: f32 = 0.01;
const PRISMATIC_BAND: f32 = 0.005;
const OVERSHOOT: f32 = 0.15;
const LATERAL_DRIFT: f32 = 1e-3;
/// 齿轮:driver 速度马达 +4 rad/s;从动 ratio=-2(外啮合反向)。
const DRIVER_VELOCITY: f64 = 4.0;
const MOTOR_STRENGTH: f64 = 10.0;
const GEAR_RATIO: f64 = -2.0;
const GEAR_STIFFNESS: f64 = 40.0;
const GEAR_DAMPING: f64 = 20.0;
const RACK_RATIO: f64 = 2.0;
/// 窗口增量比相对容差与绝对残差漂移上界。
const RATIO_RELATIVE_TOLERANCE: f32 = 0.02;
const RESIDUAL_DRIFT: f32 = 0.1;

fn servo_body(id: &str, translation: [f64; 3], mass: f64, instance: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "type": "dynamic",
        "initialPose": {"translation": translation, "rotation": [0, 0, 0, 1]},
        "mass": mass, "friction": 0.6, "restitution": 0,
        "collider": {"kind": "render-bounds", "instanceIds": [instance]}
    })
}

#[allow(clippy::too_many_arguments)]
fn servo_joint(
    id: &str,
    kind: &str,
    body_id: &str,
    connected: Option<&str>,
    world_anchor: [f64; 3],
    local_anchor: [f64; 3],
    axis: [f64; 3],
    velocity_motor: Option<(f64, f64)>,
    position: Option<(f64, f64, f64)>,
) -> serde_json::Value {
    let (velocity_json, position_json) = (
        // motor.enabled 是马达总开关:位置伺服开启时必须为 true(解析层强制)。
        match velocity_motor {
            Some((target, strength)) => {
                serde_json::json!({"enabled": true, "targetVelocity": target, "strength": strength})
            }
            None if position.is_some() => {
                serde_json::json!({"enabled": true, "targetVelocity": 0, "strength": 0})
            }
            None => serde_json::json!({"enabled": false, "targetVelocity": 0, "strength": 0}),
        },
        match position {
            Some((target, stiffness, damping)) => serde_json::json!({
                "enabled": true, "target": target, "stiffness": stiffness, "damping": damping
            }),
            None => serde_json::Value::Null,
        },
    );
    let mut motor = velocity_json;
    if !position_json.is_null() {
        motor["position"] = position_json;
    }
    serde_json::json!({
        "id": id, "kind": kind, "solver": "impulse", "bodyId": body_id,
        "connectedBodyId": connected,
        "worldAnchor": world_anchor, "localAnchor": local_anchor, "axis": axis,
        "limits": {"enabled": false, "min": -1, "max": 1},
        "motor": motor
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

fn servo_packet(
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

fn write_pairing(name: &str, payload: serde_json::Value) {
    let directory = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-output/t17-motor-gear"
    );
    std::fs::create_dir_all(directory).expect("create motor-gear pairing directory");
    let path = format!("{directory}/{name}");
    std::fs::write(&path, serde_json::to_string(&payload).unwrap())
        .expect("write motor-gear pairing poses");
}

// ─── 位置伺服:revolute 阶跃 ──────────────────────────────────────────────

fn servo_revolute_runtime_value() -> serde_json::Value {
    serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3, "id": "servo-revolute", "revision": 1,
        "physics": {"schema": "deep-engine.physics-runtime", "schemaVersion": 1, "enabled": true,
            "playing": true, "gravity": [0.0, 0.0, 0.0],
            "bodies": [servo_body("body-arm", [0.0, 0.0, 0.0], 1.0, "servo-arm")],
            "joints": [servo_joint("j1-arm-world", "revolute", "body-arm", None,
                [0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], None,
                Some((REVOLUTE_TARGET, SERVO_STIFFNESS, SERVO_DAMPING)))]}
    })
}

fn servo_revolute_packet() -> RenderPacket {
    servo_packet(
        &[(
            "servo-arm",
            cuboid_vertices([0.0, 0.0, 0.0], [0.25, 0.02, 0.02]),
        )],
        &[("servo-arm", "servo-arm", [0.0, 0.0, 0.0])],
    )
}

/// 返回逐步世界 z 角(连续 unwrap)与位置。
fn run_servo_revolute() -> (Vec<f32>, Vec<[f32; 3]>) {
    let runtime =
        parse_and_validate_dynamic_scene_runtime(&servo_revolute_runtime_value()).unwrap();
    let mut packet = servo_revolute_packet();
    let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .expect("servo revolute runtime must produce a host");
    let mut angles = Vec::with_capacity(SERVO_STEPS);
    let mut positions = Vec::with_capacity(SERVO_STEPS);
    let mut previous: Option<f32> = None;
    for _ in 0..SERVO_STEPS {
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 1);
        let binding = host
            .bindings
            .iter()
            .find(|binding| binding.instances.iter().any(|(id, _)| id == "servo-arm"))
            .expect("servo arm binding");
        let body = host.bodies.get(binding.handle).expect("servo arm body");
        let rotation = body.rotation().normalize();
        let quaternion = [rotation.x, rotation.y, rotation.z, rotation.w];
        previous = Some(unwrap_angle(previous, quat_z_angle(&quaternion)));
        angles.push(previous.unwrap());
        let t = body.translation();
        positions.push([t.x, t.y, t.z]);
    }
    (angles, positions)
}

// ─── 位置伺服:prismatic 阶跃 ─────────────────────────────────────────────

fn servo_prismatic_runtime_value() -> serde_json::Value {
    serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3, "id": "servo-prismatic", "revision": 1,
        "physics": {"schema": "deep-engine.physics-runtime", "schemaVersion": 1, "enabled": true,
            "playing": true, "gravity": [0.0, 0.0, 0.0],
            "bodies": [servo_body("body-slider", [0.0, 0.0, 0.0], 0.5, "servo-slider")],
            "joints": [servo_joint("j1-slider-world", "prismatic", "body-slider", None,
                [0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], None,
                Some((PRISMATIC_TARGET, SERVO_STIFFNESS, SERVO_DAMPING)))]}
    })
}

fn servo_prismatic_packet() -> RenderPacket {
    servo_packet(
        &[(
            "servo-slider",
            cuboid_vertices([0.0, 0.0, 0.0], [0.03, 0.02, 0.02]),
        )],
        &[("servo-slider", "servo-slider", [0.0, 0.0, 0.0])],
    )
}

fn run_servo_prismatic() -> Vec<[f32; 3]> {
    let runtime =
        parse_and_validate_dynamic_scene_runtime(&servo_prismatic_runtime_value()).unwrap();
    let mut packet = servo_prismatic_packet();
    let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .expect("servo prismatic runtime must produce a host");
    let mut positions = Vec::with_capacity(SERVO_STEPS);
    for _ in 0..SERVO_STEPS {
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 1);
        let binding = host
            .bindings
            .iter()
            .find(|binding| binding.instances.iter().any(|(id, _)| id == "servo-slider"))
            .expect("servo slider binding");
        let body = host.bodies.get(binding.handle).expect("servo slider body");
        let t = body.translation();
        positions.push([t.x, t.y, t.z]);
    }
    positions
}

// ─── 齿轮耦合:-2:1 外啮合反向 ────────────────────────────────────────────

fn gear_runtime_value() -> serde_json::Value {
    serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3, "id": "gear-golden", "revision": 1,
        "physics": {"schema": "deep-engine.physics-runtime", "schemaVersion": 1, "enabled": true,
            "playing": true, "gravity": [0.0, 0.0, 0.0],
            "bodies": [
                servo_body("body-gear-a", [0.0, 0.0, 0.0], 0.6, "gear-a"),
                servo_body("body-gear-b", [0.0, 0.0, -0.04], 0.6, "gear-b"),
            ],
            "joints": [
                servo_joint("j1-gear-a-world", "revolute", "body-gear-a", None,
                    [0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 1.0],
                    Some((DRIVER_VELOCITY, MOTOR_STRENGTH)), None),
                servo_joint("j2-gear-b-world", "revolute", "body-gear-b", None,
                    [0.0, 0.0, -0.04], [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], None, None),
            ],
            "gears": [{"id": "g1", "driverJointId": "j1-gear-a-world", "followerJointId": "j2-gear-b-world",
                "ratio": GEAR_RATIO, "stiffness": GEAR_STIFFNESS, "damping": GEAR_DAMPING}]}
    })
}

fn gear_packet() -> RenderPacket {
    // collider 沿 z 错层(与 Web addBody 的 colliderOffset 逐项一致)。
    servo_packet(
        &[
            (
                "gear-a",
                cuboid_vertices([0.0, 0.0, 0.045], [0.05, 0.05, 0.01]),
            ),
            (
                "gear-b",
                cuboid_vertices([0.0, 0.0, -0.045], [0.05, 0.05, 0.01]),
            ),
        ],
        &[
            ("gear-a", "gear-a", [0.0, 0.0, 0.0]),
            ("gear-b", "gear-b", [0.0, 0.0, -0.04]),
        ],
    )
}

/// 返回 driver/follower 的连续 z 角与 follower 逐步位置。
fn run_gear() -> (Vec<f32>, Vec<f32>, Vec<[f32; 3]>) {
    let runtime = parse_and_validate_dynamic_scene_runtime(&gear_runtime_value()).unwrap();
    let mut packet = gear_packet();
    let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .expect("gear runtime must produce a host");
    let read_angle = |host: &NativePhysicsHost, instance: &str| -> f32 {
        let binding = host
            .bindings
            .iter()
            .find(|binding| binding.instances.iter().any(|(id, _)| id == instance))
            .expect("gear binding");
        let body = host.bodies.get(binding.handle).expect("gear body");
        let rotation = body.rotation().normalize();
        quat_z_angle(&[rotation.x, rotation.y, rotation.z, rotation.w])
    };
    let read_position = |host: &NativePhysicsHost, instance: &str| -> [f32; 3] {
        let binding = host
            .bindings
            .iter()
            .find(|binding| binding.instances.iter().any(|(id, _)| id == instance))
            .expect("gear binding");
        let t = host
            .bodies
            .get(binding.handle)
            .expect("gear body")
            .translation();
        [t.x, t.y, t.z]
    };
    let mut angles_a = Vec::with_capacity(GEAR_STEPS);
    let mut angles_b = Vec::with_capacity(GEAR_STEPS);
    let mut positions_b = Vec::with_capacity(GEAR_STEPS);
    for _ in 0..GEAR_STEPS {
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 2);
        angles_a.push(unwrap_angle(
            angles_a.last().copied(),
            read_angle(&host, "gear-a"),
        ));
        angles_b.push(unwrap_angle(
            angles_b.last().copied(),
            read_angle(&host, "gear-b"),
        ));
        positions_b.push(read_position(&host, "gear-b"));
    }
    (angles_a, angles_b, positions_b)
}

// ─── 齿条:prismatic 2:1 ─────────────────────────────────────────────────

fn rack_runtime_value() -> serde_json::Value {
    serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3, "id": "rack-golden", "revision": 1,
        "physics": {"schema": "deep-engine.physics-runtime", "schemaVersion": 1, "enabled": true,
            "playing": true, "gravity": [0.0, 0.0, 0.0],
            "bodies": [
                servo_body("body-rack-a", [0.0, 0.06, 0.0], 0.5, "rack-a"),
                servo_body("body-rack-b", [0.0, -0.06, 0.0], 0.5, "rack-b"),
            ],
            "joints": [
                servo_joint("j1-rack-a-world", "prismatic", "body-rack-a", None,
                    [0.0, 0.06, 0.0], [0.0, 0.0, 0.0], [1.0, 0.0, 0.0],
                    Some((0.5, MOTOR_STRENGTH)), None),
                servo_joint("j2-rack-b-world", "prismatic", "body-rack-b", None,
                    [0.0, -0.06, 0.0], [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], None, None),
            ],
            "gears": [{"id": "g1", "driverJointId": "j1-rack-a-world", "followerJointId": "j2-rack-b-world",
                "ratio": RACK_RATIO, "stiffness": GEAR_STIFFNESS, "damping": GEAR_DAMPING}]}
    })
}

fn rack_packet() -> RenderPacket {
    servo_packet(
        &[
            (
                "rack-a",
                cuboid_vertices([0.0, 0.06, 0.0], [0.04, 0.01, 0.02]),
            ),
            (
                "rack-b",
                cuboid_vertices([0.0, -0.06, 0.0], [0.04, 0.01, 0.02]),
            ),
        ],
        &[
            ("rack-a", "rack-a", [0.0, 0.06, 0.0]),
            ("rack-b", "rack-b", [0.0, -0.06, 0.0]),
        ],
    )
}

fn run_rack() -> (Vec<f32>, Vec<f32>) {
    let runtime = parse_and_validate_dynamic_scene_runtime(&rack_runtime_value()).unwrap();
    let mut packet = rack_packet();
    let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .expect("rack runtime must produce a host");
    let read_x = |host: &NativePhysicsHost, instance: &str| -> f32 {
        let binding = host
            .bindings
            .iter()
            .find(|binding| binding.instances.iter().any(|(id, _)| id == instance))
            .expect("rack binding");
        host.bodies
            .get(binding.handle)
            .expect("rack body")
            .translation()
            .x
    };
    let mut travel_a = Vec::with_capacity(GEAR_STEPS);
    let mut travel_b = Vec::with_capacity(GEAR_STEPS);
    for _ in 0..GEAR_STEPS {
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 2);
        travel_a.push(read_x(&host, "rack-a"));
        travel_b.push(read_x(&host, "rack-b"));
    }
    (travel_a, travel_b)
}

// ─── 断言 ────────────────────────────────────────────────────────────────

#[test]
fn revolute_position_servo_settles_at_target_bit_exactly() {
    let first = run_servo_revolute();
    let repeat = run_servo_revolute();
    assert_eq!(
        repeat.0, first.0,
        "servo revolute must be bit-exact across runs"
    );
    assert_eq!(repeat.1, first.1);

    let window = &first.0[SERVO_STEPS - SETTLE_WINDOW..];
    let mean = window.iter().sum::<f32>() / window.len() as f32;
    let peak = first.0.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    println!("SERVO[native-revolute] mean={mean:.5} target={REVOLUTE_TARGET} peak={peak:.5}");
    assert!(
        (mean - REVOLUTE_TARGET as f32).abs() <= REVOLUTE_BAND,
        "settled angle {mean:.5} outside ±{REVOLUTE_BAND} rad of {REVOLUTE_TARGET}"
    );
    assert!(
        peak <= REVOLUTE_TARGET as f32 + OVERSHOOT,
        "overshoot peak {peak:.5} beyond {OVERSHOOT}"
    );
}

#[test]
fn prismatic_position_servo_settles_at_target_bit_exactly() {
    let first = run_servo_prismatic();
    let repeat = run_servo_prismatic();
    assert_eq!(
        repeat, first,
        "servo prismatic must be bit-exact across runs"
    );

    let window = &first[SERVO_STEPS - SETTLE_WINDOW..];
    let mean = window.iter().map(|p| p[0]).sum::<f32>() / window.len() as f32;
    let drift = first
        .iter()
        .map(|p| p[1].abs().max(p[2].abs()))
        .fold(0.0_f32, f32::max);
    println!("SERVO[native-prismatic] mean={mean:.5} target={PRISMATIC_TARGET} drift={drift:.2e}");
    assert!(
        (mean - PRISMATIC_TARGET as f32).abs() <= PRISMATIC_BAND,
        "settled position {mean:.5} outside ±{PRISMATIC_BAND} m of {PRISMATIC_TARGET}"
    );
    assert!(drift < LATERAL_DRIFT, "lateral drift {drift:.2e} m");
    let directory = concat!(env!("CARGO_MANIFEST_DIR"), "/../../test-output/c5-bullet");
    std::fs::create_dir_all(directory).unwrap();
    std::fs::write(format!("{directory}/native-slider.json"), serde_json::to_string(&serde_json::json!({
        "positions":first,"repeat":repeat,"meta":{"mass":0.5,"target":PRISMATIC_TARGET,
        "stiffness":SERVO_STIFFNESS,"damping":SERVO_DAMPING,"step":1.0/60.0,"steps":SERVO_STEPS,"solverIterations":8}
    })).unwrap()).unwrap();
}

#[test]
fn gear_coupling_holds_ratio_bit_exactly() {
    let first = run_gear();
    let repeat = run_gear();
    assert_eq!(
        repeat.0, first.0,
        "gear angles must be bit-exact across runs"
    );
    assert_eq!(repeat.1, first.1);
    assert_eq!(repeat.2, first.2);

    let last = GEAR_STEPS - 1;
    let delta_a = first.0[last] - first.0[STEADY_START];
    let delta_b = first.1[last] - first.1[STEADY_START];
    let ratio = delta_b / delta_a;
    let residual = (delta_b - (GEAR_RATIO as f32) * delta_a).abs();
    println!(
        "GEAR[native-2to1] deltaA={delta_a:.3} deltaB={delta_b:.3} ratio={ratio:.4} (target {GEAR_RATIO})"
    );
    let band = (GEAR_RATIO as f32).abs() * RATIO_RELATIVE_TOLERANCE;
    assert!(
        ratio >= GEAR_RATIO as f32 - band && ratio <= GEAR_RATIO as f32 + band,
        "window transmission ratio {ratio:.4} outside {GEAR_RATIO}±{band}"
    );
    assert!(
        residual <= RESIDUAL_DRIFT,
        "absolute residual {residual:.4} rad beyond {RESIDUAL_DRIFT}"
    );
}

#[test]
fn rack_coupling_holds_ratio_bit_exactly() {
    let first = run_rack();
    let repeat = run_rack();
    assert_eq!(repeat, first, "rack travel must be bit-exact across runs");

    let last = GEAR_STEPS - 1;
    let delta_a = first.0[last] - first.0[STEADY_START];
    let delta_b = first.1[last] - first.1[STEADY_START];
    let ratio = delta_b / delta_a;
    println!(
        "GEAR[native-rack2to1] deltaA={delta_a:.4} deltaB={delta_b:.4} ratio={ratio:.4} (target {RACK_RATIO})"
    );
    let band = RACK_RATIO as f32 * RATIO_RELATIVE_TOLERANCE;
    assert!(
        ratio >= RACK_RATIO as f32 - band && ratio <= RACK_RATIO as f32 + band,
        "rack travel ratio {ratio:.4} outside {RACK_RATIO}±{band}"
    );
}

#[test]
fn writes_native_servo_pairing() {
    let (angles, positions) = run_servo_revolute();
    write_pairing(
        "native-servo-poses.json",
        serde_json::json!({
            "meta": {
                "end": "native", "scenario": "position-servo-revolute",
                "target": REVOLUTE_TARGET, "stiffness": SERVO_STIFFNESS, "damping": SERVO_DAMPING,
                "gravity": [0.0, 0.0, 0.0], "fixedStepSeconds": 1.0 / 60.0,
                "steps": SERVO_STEPS, "solverIterations": 8, "bodies": ["body-arm"],
            },
            "positions": positions,
            "angles": angles,
        }),
    );
    assert_eq!(positions.len(), SERVO_STEPS);
}

#[test]
fn writes_native_gear_pairing() {
    let (angles_a, angles_b, positions) = run_gear();
    write_pairing(
        "native-gear-poses.json",
        serde_json::json!({
            "meta": {
                "end": "native", "scenario": "gear-coupling-2to1",
                "driverVelocity": DRIVER_VELOCITY, "ratio": GEAR_RATIO,
                "stiffness": GEAR_STIFFNESS, "damping": GEAR_DAMPING,
                "gravity": [0.0, 0.0, 0.0], "fixedStepSeconds": 1.0 / 60.0,
                "steps": GEAR_STEPS, "solverIterations": 8, "bodies": ["body-gear-b"],
            },
            "positions": positions,
            "anglesDriver": angles_a,
            "anglesFollower": angles_b,
        }),
    );
    assert_eq!(positions.len(), GEAR_STEPS);
}
