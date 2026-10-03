//! T17 机构驱动黄金测试共享支撑,自 `native_physics_mechanism_golden_tests.rs` 原样拆出:
//! 公差常量、机构体/关节/包 packet 构造、连续角与落盘工具。
//! 除可见性(`pub(super)`)与 `super::` → `crate::` 导入路径调整外逐字未改;
//! 参数与 Web 端逐项对齐的纪律见各测试文件头注释。

use crate::contract::RenderPacket;

pub(super) const PISTON_STEPS: usize = 360;
pub(super) const SLIDER_STEPS: usize = 240;
pub(super) const SPIN_STEPS: usize = 240;
/// 稳态窗口起点(第 2 转起),周期/对称性/角速度在窗口内测量。
pub(super) const STEADY_START: usize = 120;
pub(super) const PERIOD_STEPS: f32 = 120.0;
pub(super) const MOTOR_TARGET_VELOCITY: f64 = std::f64::consts::PI;
pub(super) const MOTOR_STRENGTH: f64 = 20.0;
pub(super) const CRANK_RADIUS: f64 = 0.05;
pub(super) const ROD_LENGTH: f64 = 0.15;
/// 行程容差(米):解析值 0.1。
pub(super) const STROKE_TOLERANCE: f32 = 5e-3;
/// 活塞导轨直线度:y/z 全程最大漂移(米)。
pub(super) const GUIDE_DRIFT_METERS: f32 = 2e-3;
pub(super) const PERIOD_TOLERANCE_STEPS: i32 = 6;
/// 升程/降程步数与解析预测的容差。
pub(super) const STROKE_ASYMMETRY_STEPS: f32 = 4.0;
pub(super) const CRANK_RATE_RELATIVE_TOLERANCE: f32 = 0.02;
/// 端到端解析对照最大偏差(米)。
pub(super) const ANALYTIC_TOLERANCE_METERS: f32 = 8e-3;
pub(super) const SLIDER_LIMIT: f64 = 0.08;
pub(super) const SLIDER_MOTOR_VELOCITY: f64 = 0.4;
pub(super) const SLIDER_MOTOR_STRENGTH: f64 = 10.0;
pub(super) const SLIDER_FINAL_MIN: f32 = 0.075;
pub(super) const SLIDER_FINAL_MAX: f32 = 0.085;
pub(super) const SLIDER_OVERSHOOT: f32 = 5e-3;
pub(super) const SLIDER_TRAVEL_STEPS: usize = 12;
pub(super) const SLIDER_TRAVEL_TOLERANCE_STEPS: usize = 4;
pub(super) const SLIDER_GUIDE_DRIFT: f32 = 1e-3;
pub(super) const SLIDER_TILT_RADIANS: f32 = 0.01;
/// 1:1 刚性耦合:全程转角差上限(弧度)与末窗角速度比半带宽。
pub(super) const RIGID_ANGLE_TOLERANCE: f32 = 0.02;
pub(super) const RIGID_RATIO_BAND: f32 = 0.01;
/// 2:1 目标耦合:末窗实测角速度比相对目标的容差(相对)。
pub(super) const TARGET_RATIO_RELATIVE_TOLERANCE: f32 = 0.03;

pub(super) fn mech_body(id: &str, translation: [f64; 3], mass: f64, instance: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "type": "dynamic",
        "initialPose": {"translation": translation, "rotation": [0, 0, 0, 1]},
        "mass": mass, "friction": 0.6, "restitution": 0,
        "collider": {"kind": "render-bounds", "instanceIds": [instance]}
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn mech_joint(
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
pub(super) fn cuboid_vertices(center: [f64; 3], half: [f64; 3]) -> serde_json::Value {
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

pub(super) fn mech_packet(
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

pub(super) fn unwrap_angle(previous: Option<f32>, raw: f32) -> f32 {
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
pub(super) fn quat_z_angle(r: &[f32; 4]) -> f32 {
    2.0 * r[2].atan2(r[3])
}

pub(super) fn write_pairing(name: &str, payload: serde_json::Value) {
    let directory = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-output/t17-mechanism"
    );
    std::fs::create_dir_all(directory).expect("create mechanism pairing directory");
    let path = format!("{directory}/{name}");
    std::fs::write(&path, serde_json::to_string(&payload).unwrap())
        .expect("write mechanism pairing poses");
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

pub(super) fn assert_piston_kinematics(positions: &[[f32; 3]], angles: &[f32]) {
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
