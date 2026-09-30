//! T17 黄金案例续轮:三箱堆叠、铰链限位与跨端位姿配对数据。
//!
//! 全部为 `#[cfg(test)]`,不进入发布产物。参数与 Web
//! `apps/web/src/viewer/rapierPhysicsStackGolden.test.ts` /
//! `rapierPhysicsHingeLimitGolden.test.ts` 逐项对齐;改任何参数必须两侧同步。

use super::*;
use crate::runtime_package::parse_and_validate_dynamic_scene_runtime;

const STACK_STEPS: usize = 180;
const STACK_STABILITY_WINDOW_START: usize = 150;
/// 末 30 步最大允许位移(米)与旋转(弧度),与 Web 侧阈值一致。
const STACK_DRIFT_METERS: f32 = 5e-3;
const STACK_DRIFT_RADIANS: f32 = 0.05;
const HINGE_STEPS: usize = 120;
const HINGE_LIMIT_MAX: f32 = 0.5;
/// 限位附近的最终角度区间与整程上界(弧度),与 Web 侧一致。
const HINGE_FINAL_ANGLE_MIN: f32 = 0.45;
const HINGE_FINAL_ANGLE_MAX: f32 = 0.55;
const HINGE_OVERSHOOT_TOLERANCE: f32 = 0.05;

fn box_body(index: u8, y: f64, shove: bool) -> serde_json::Value {
    let mut value = serde_json::json!({
        "id": format!("body-box-{index}"), "type": "dynamic",
        "initialPose": {"translation": [0, y, 0], "rotation": [0, 0, 0, 1]},
        "mass": 1, "friction": 0.6, "restitution": 0,
        "collider": {"kind": "render-bounds", "instanceIds": [format!("stack-box-{index}")]}
    });
    if shove {
        value["initialLinearVelocity"] = serde_json::json!([0.15, 0, 0]);
    }
    value
}

fn stack_runtime_value() -> serde_json::Value {
    // body ids 必须按字典序排列:body-box-1 < body-box-2 < body-box-3 < body-ground。
    serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3, "id": "stack-golden", "revision": 1,
        "physics": {"schema": "deep-engine.physics-runtime", "schemaVersion": 1, "enabled": true,
            "playing": true, "gravity": [0, -9.81, 0],
            "bodies": [
                box_body(1, 0.1, false),
                box_body(2, 0.3, false),
                box_body(3, 0.5, true),
                {"id": "body-ground", "type": "fixed",
                    "initialPose": {"translation": [0, -0.1, 0], "rotation": [0, 0, 0, 1]},
                    "mass": 1, "friction": 0.6, "restitution": 0,
                    "collider": {"kind": "render-bounds", "instanceIds": ["stack-ground"]}}
            ], "joints": []}
    })
}

fn stack_packet() -> RenderPacket {
    // 每顶点 6 个浮点(位置+法线);两个对角顶点即可撑出 AABB。
    let corners = |min: [f64; 3], max: [f64; 3]| {
        serde_json::json!([
            min[0], min[1], min[2], 0, 1, 0, max[0], max[1], max[2], 0, 1, 0, 0, 0, 0, 0, 1, 0
        ])
    };
    let cube = corners([-0.1, -0.1, -0.1], [0.1, 0.1, 0.1]);
    // 地面 cuboid half=(2,0.1,2),实例平移 y=-0.1 → 顶面 y=0,与 Web 侧一致。
    let ground = corners([-2.0, -0.1, -2.0], [2.0, 0.1, 2.0]);
    let instance = |id: &str, geometry: &str, y: f64| {
        serde_json::json!({"id": id, "geometry": geometry, "material": "mat",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, y, 0, 1]})
    };
    serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet", "version": 1,
        "geometries": [
            {"id": "stack-cube", "revision": 1, "vertices": cube, "indices": [0, 1, 2]},
            {"id": "stack-ground", "revision": 1, "vertices": ground, "indices": [0, 1, 2]}
        ],
        "materials": [{"id": "mat", "baseColor": [1, 1, 1], "metallic": 0, "roughness": 1}],
        "instances": [
            instance("stack-box-1", "stack-cube", 0.1),
            instance("stack-box-2", "stack-cube", 0.3),
            instance("stack-box-3", "stack-cube", 0.5),
            instance("stack-ground", "stack-ground", -0.1)
        ]
    }))
    .unwrap()
}

/// 返回每个固定步三箱的平移与旋转(四元数),以及最终 packet 内三箱变换。
fn run_stack() -> (Vec<[[f32; 3]; 3]>, Vec<[[f32; 4]; 3]>, Vec<[f32; 16]>) {
    let runtime = parse_and_validate_dynamic_scene_runtime(&stack_runtime_value()).unwrap();
    let mut packet = stack_packet();
    let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .expect("stack runtime must produce a host");
    const BOXES: [&str; 3] = ["stack-box-1", "stack-box-2", "stack-box-3"];
    let mut translations = Vec::with_capacity(STACK_STEPS);
    let mut rotations = Vec::with_capacity(STACK_STEPS);
    for _ in 0..STACK_STEPS {
        // advance 返回"本次写回 packet 的动态实例数"(生产消费方 player_content/dynamic_playback 的口径),
        // 三个动态箱每步全部同步 = 3;0 表示没有固定步执行。
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 3);
        let mut step_translation = [[0.0f32; 3]; 3];
        let mut step_rotation = [[0.0f32; 4]; 3];
        for (index, id) in BOXES.iter().enumerate() {
            let binding = host
                .bindings
                .iter()
                .find(|binding| binding.instances.iter().any(|(instance, _)| instance == id))
                .expect("physics-owned stack instance");
            let body = host.bodies.get(binding.handle).expect("stack body");
            let t = body.translation();
            let r = body.rotation().normalize();
            step_translation[index] = [t.x, t.y, t.z];
            step_rotation[index] = [r.x, r.y, r.z, r.w];
        }
        translations.push(step_translation);
        rotations.push(step_rotation);
    }
    let final_transforms = BOXES
        .iter()
        .map(|id| {
            packet
                .instances
                .iter()
                .find(|instance| instance.id == *id)
                .expect("packet instance")
                .transform
        })
        .collect();
    (translations, rotations, final_transforms)
}

fn quat_angle(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])
        .abs()
        .min(1.0);
    2.0 * dot.clamp(-1.0, 1.0).acos()
}

fn stack_drift(
    translations: &[[[f32; 3]; 3]],
    rotations: &[[[f32; 4]; 3]],
) -> ([f32; 3], [f32; 3]) {
    let near = STACK_STABILITY_WINDOW_START - 1;
    let end = STACK_STEPS - 1;
    let mut drift = [0.0f32; 3];
    let mut rotation = [0.0f32; 3];
    for index in 0..3 {
        let delta = [
            translations[end][index][0] - translations[near][index][0],
            translations[end][index][1] - translations[near][index][1],
            translations[end][index][2] - translations[near][index][2],
        ];
        drift[index] = (delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]).sqrt();
        rotation[index] = quat_angle(&rotations[end][index], &rotations[near][index]);
    }
    (drift, rotation)
}

#[test]
fn stack_settles_within_drift_thresholds_and_repeats_bit_exactly() {
    let (first_positions, first_rotations, first_transforms) = run_stack();
    let (second_positions, second_rotations, second_transforms) = run_stack();
    assert_eq!(
        first_positions, second_positions,
        "same input must repeat exactly"
    );
    assert_eq!(first_rotations, second_rotations);
    assert_eq!(first_transforms, second_transforms);

    let (drift, rotation) = stack_drift(&first_positions, &first_rotations);
    for index in 0..3 {
        assert!(
            drift[index] < STACK_DRIFT_METERS,
            "box {} drifted {:#e} m over the last 30 steps",
            index + 1,
            drift[index]
        );
        assert!(
            rotation[index] < STACK_DRIFT_RADIANS,
            "box {} rotated {:#e} rad over the last 30 steps",
            index + 1,
            rotation[index]
        );
        let resting_y = first_positions[STACK_STEPS - 1][index][1];
        assert!(
            resting_y > 0.09 && resting_y < 0.54,
            "box {} resting y {resting_y} outside the stacked band",
            index + 1
        );
    }
    // 顶层箱 0.15 m/s 推移不得掀翻堆叠:末步三箱 y 仍保持 ~0.1/0.3/0.5 的层序。
    let end = first_positions[STACK_STEPS - 1];
    assert!(
        end[0][1] < end[1][1] && end[1][1] < end[2][1],
        "stack layering collapsed: {end:?}"
    );
    assert!(
        end[2][0].abs() < 0.5,
        "top box shove must not slide the stack off the pad: x={:?}",
        end[2][0]
    );
    // 固定地面不是物理拥有实例,位姿查询必须拒绝。
    let packet = stack_packet();
    let runtime = parse_and_validate_dynamic_scene_runtime(&stack_runtime_value()).unwrap();
    let host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .unwrap();
    assert!(host.instance_pose(&packet, "stack-ground").is_none());
}

#[test]
fn stack_records_per_step_poses_for_cross_end_tolerance_pairing() {
    let (translations, rotations, _) = run_stack();
    let payload = serde_json::json!({
        "meta": {
            "end": "native", "rapier": "0.35.3", "scenario": "stack-3boxes",
            "halfExtents": 0.1, "mass": 1, "friction": 0.6, "restitution": 0,
            "gravity": [0, -9.81, 0], "fixedStepSeconds": 1.0 / 60.0, "steps": STACK_STEPS,
            "solverIterations": 8, "ccd": true, "damping": {"linear": 0, "angular": 0},
            "topBoxInitialVelocity": [0.15, 0, 0],
            "boxes": ["stack-box-1", "stack-box-2", "stack-box-3"]
        },
        "translations": translations,
        "rotations": rotations
    });
    let directory = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-output/t17-cross-tolerance"
    );
    std::fs::create_dir_all(directory).expect("create pairing output directory");
    let path = format!("{directory}/native-stack-poses.json");
    std::fs::write(&path, serde_json::to_string(&payload).unwrap()).expect("write pairing poses");
    assert_eq!(translations.len(), STACK_STEPS);
}

fn hinge_runtime_value(limits_enabled: bool) -> serde_json::Value {
    serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3, "id": "hinge-golden", "revision": 1,
        "physics": {"schema": "deep-engine.physics-runtime", "schemaVersion": 1, "enabled": true,
            "playing": true, "gravity": [0, 0, 0],
            "bodies": [
                {"id": "body-arm", "type": "dynamic",
                    "initialPose": {"translation": [0.25, 0, 0], "rotation": [0, 0, 0, 1]},
                    "mass": 1, "friction": 0.6, "restitution": 0,
                    "collider": {"kind": "render-bounds", "instanceIds": ["hinge-arm"]}}
            ],
            "joints": [
                {"id": "joint-arm", "kind": "revolute", "solver": "impulse", "bodyId": "body-arm",
                    "connectedBodyId": null, "worldAnchor": [0, 0, 0], "localAnchor": [-0.25, 0, 0],
                    "axis": [0, 0, 1],
                    "limits": {"enabled": limits_enabled, "min": -0.5, "max": 0.5},
                    "motor": {"enabled": true, "targetVelocity": 2, "strength": 10}}
            ]}
    })
}

fn hinge_packet() -> RenderPacket {
    serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet", "version": 1,
        "geometries": [
            {"id": "hinge-arm-shape", "revision": 1,
                "vertices": [
                    -0.25, -0.02, -0.02, 0, 1, 0,
                    0.25, 0.02, 0.02, 0, 1, 0,
                    0, 0, 0, 0, 1, 0
                ],
                "indices": [0, 1, 2]}
        ],
        "materials": [{"id": "mat", "baseColor": [1, 1, 1], "metallic": 0, "roughness": 1}],
        "instances": [
            {"id": "hinge-arm", "geometry": "hinge-arm-shape", "material": "mat",
                "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.25, 0, 0, 1]}
        ]
    }))
    .unwrap()
}

/// 逐步返回臂的连续转角(弧度)。packet 变换为列主序,绕 z 角 = atan2(m[1], m[0])。
fn run_hinge(limits_enabled: bool) -> Vec<f32> {
    let runtime =
        parse_and_validate_dynamic_scene_runtime(&hinge_runtime_value(limits_enabled)).unwrap();
    let mut packet = hinge_packet();
    let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .expect("hinge runtime must produce a host");
    let mut angles: Vec<f32> = Vec::with_capacity(HINGE_STEPS);
    for _ in 0..HINGE_STEPS {
        // 返回值为同步实例数:摆臂唯一动态实例 = 1。
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 1);
        let transform = &packet
            .instances
            .iter()
            .find(|instance| instance.id == "hinge-arm")
            .expect("hinge instance")
            .transform;
        let raw = (f64::from(transform[1])).atan2(f64::from(transform[0])) as f32;
        let unwrapped = match angles.last().copied() {
            Some(previous) => {
                let mut value = raw;
                while value - previous > std::f32::consts::PI {
                    value -= 2.0 * std::f32::consts::PI;
                }
                while previous - value > std::f32::consts::PI {
                    value += 2.0 * std::f32::consts::PI;
                }
                value
            }
            None => raw,
        };
        angles.push(unwrapped);
    }
    angles
}

#[test]
fn hinge_motor_clamps_at_authored_limits_and_repeats_bit_exactly() {
    let limited = run_hinge(true);
    let repeat = run_hinge(true);
    assert_eq!(limited, repeat, "same input must repeat exactly");

    let final_angle = limited[HINGE_STEPS - 1];
    let peak = limited.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    assert!(
        final_angle >= HINGE_FINAL_ANGLE_MIN && final_angle <= HINGE_FINAL_ANGLE_MAX,
        "final angle {final_angle} outside the clamped band"
    );
    assert!(
        peak <= HINGE_LIMIT_MAX + HINGE_OVERSHOOT_TOLERANCE,
        "peak angle {peak} exceeded the limit tolerance"
    );
}

#[test]
fn hinge_motor_without_limits_drives_far_past_the_authored_band() {
    let control = run_hinge(false);
    let final_angle = control[HINGE_STEPS - 1];
    assert!(
        final_angle > 1.0,
        "unlimited control final angle {final_angle} must exceed the band"
    );
}

#[test]
fn hinge_exports_existing_actual_golden_for_independent_oracle() {
    let limited = run_hinge(true);
    let repeat = run_hinge(true);
    assert_eq!(limited, repeat);
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-output/c5-bullet");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("native-hinge.json"), serde_json::to_string(&serde_json::json!({
        "limited":limited,"repeat":repeat,"control":run_hinge(false),"stepSeconds":1.0/60.0,
        "steps":HINGE_STEPS,"limitMin":-0.5,"limitMax":0.5,"mass":1,"targetVelocity":2,"strength":10
    })).unwrap()).unwrap();
}
