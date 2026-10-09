//! F6 凹体碰撞黄金案例:SDF 体素场 → trimesh collider,小球滚入凹槽真实接触,
//! 与凸包近似对照给出穿透量(幽灵体积)差异实测。
//!
//! 场景(与 Web `rapierSdfConcaveGolden.test.ts` 逐项对齐,改参数必须两侧同步):
//! 凹 L 棱柱(x∈[0,1]×y∈[0,3] ∪ x∈[0,3]×y∈[0,1],z∈[0,1])作 fixed 体。
//! - 滚入验收:小球以 −0.3 m/s 自凹槽内 (2.5, 1.35, 0.5) 滚向凹角
//!   (x=1 竖壁 × 横臂顶面),被两面包夹后驻留于 y ≈ 1+r(真实接触);
//!   从上方进入凹槽的入场语义由幽灵厚度对照的下落场景覆盖;
//! - 幽灵厚度对照:同一凹槽正上方 (2, 2.5, 0.5) 静止下落,SDF 首触 y≈1+r,
//!   凸包首触于幽灵斜面 (4−x)+r·√2,厚度差解析值 1 + r·(√2−1) ≈ 1.124 m;
//!   凸包球随后沿斜面滚出凹槽(球在斜面上必然滚动)—— 凸包无法在凹槽内承接。
//!   两版本各跑两次,位姿逐位相等(enhanced-determinism 逐位合同)。

use super::*;
use crate::runtime_package::parse_and_validate_dynamic_scene_runtime;

const SDF_STEPS: usize = 240;
const DROP_STEPS: usize = 90;
const BALL_RADIUS: f64 = 0.3;
const FRICTION: f64 = 0.6;
const ROLL_START: [f64; 3] = [2.5, 1.35, 0.5];
const ROLL_VELOCITY: [f64; 3] = [-0.3, 0.0, 0.0];
const DROP_START: [f64; 3] = [2.0, 2.5, 0.5];

fn l_fixture_distances() -> Vec<f64> {
    #[derive(serde::Deserialize)]
    struct Fixture {
        distances: Vec<f64>,
    }
    let fixture: Fixture =
        serde_json::from_str(include_str!("physics_sdf_l_fixture.json")).expect("fixture parses");
    fixture.distances
}

fn l_sdf_grid_json() -> serde_json::Value {
    serde_json::json!({
        "origin": [-0.125, -0.125, -0.125], "cellSize": 0.25,
        "dimensions": [16, 16, 8], "distances": l_fixture_distances(),
    })
}

/// 凹 L 棱柱的 12 个角点(凸包变体用)。
fn l_hull_points() -> Vec<[f64; 3]> {
    let corners = [
        [0.0, 0.0],
        [3.0, 0.0],
        [3.0, 1.0],
        [1.0, 1.0],
        [1.0, 3.0],
        [0.0, 3.0],
    ];
    corners
        .iter()
        .flat_map(|[x, y]| [[*x, *y, 0.0], [*x, *y, 1.0]])
        .collect()
}

fn sdf_collider_value() -> serde_json::Value {
    serde_json::json!({
        "kind": "sdf-grid", "instanceIds": ["notch-l"], "sdf": l_sdf_grid_json(),
        "precision": {"approximate": true, "reasons": ["sdf-voxel-discretization"], "tolerance": 0.2165}
    })
}

fn hull_collider_value() -> serde_json::Value {
    serde_json::json!({
        "kind": "convex-hull", "instanceIds": ["notch-l"], "points": l_hull_points(),
        "precision": {"approximate": true, "reasons": ["concave-over-approximation"], "hullVertexCount": 12, "concaveSource": true}
    })
}

fn notch_scene(
    collider: serde_json::Value,
    start: [f64; 3],
    velocity: Option<[f64; 3]>,
) -> serde_json::Value {
    // body ids 字典序:body-ball < body-ground < body-sdf。
    let mut ball = serde_json::json!({
        "id": "body-ball", "type": "dynamic",
        "initialPose": {"translation": start, "rotation": [0, 0, 0, 1]},
        "mass": 0.5, "friction": FRICTION, "restitution": 0,
        "collider": {"kind": "primitive", "instanceIds": ["notch-ball"],
            "primitive": {"shape": "sphere", "radius": BALL_RADIUS}}
    });
    if let Some(velocity) = velocity {
        ball["initialLinearVelocity"] = serde_json::json!(velocity);
    }
    serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3, "id": "sdf-notch-golden", "revision": 1,
        "physics": {"schema": "deep-engine.physics-runtime", "schemaVersion": 1, "enabled": true,
            "playing": true, "gravity": [0, -9.81, 0],
            "bodies": [ball,
                {"id": "body-ground", "type": "fixed",
                    "initialPose": {"translation": [0, -0.1, 0], "rotation": [0, 0, 0, 1]},
                    "mass": 1, "friction": FRICTION, "restitution": 0,
                    "collider": {"kind": "render-bounds", "instanceIds": ["notch-ground"]}},
                {"id": "body-sdf", "type": "fixed",
                    "initialPose": {"translation": [0, 0, 0], "rotation": [0, 0, 0, 1]},
                    "mass": 1, "friction": FRICTION, "restitution": 0, "collider": collider}
            ], "joints": []}
    })
}

fn notch_packet() -> RenderPacket {
    let corners = |min: [f64; 3], max: [f64; 3]| {
        serde_json::json!([
            min[0], min[1], min[2], 0, 1, 0, max[0], max[1], max[2], 0, 1, 0, 0, 0, 0, 0, 1, 0
        ])
    };
    let instance = |id: &str, geometry: &str, transform: [f64; 16]| serde_json::json!({"id": id, "geometry": geometry, "material": "mat", "transform": transform});
    serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet", "version": 1,
        "geometries": [
            {"id": "notch-ground", "revision": 1,
                "vertices": corners([-5.0, -0.1, -5.0], [5.0, 0.1, 5.0]), "indices": [0, 1, 2]},
            {"id": "notch-proxy", "revision": 1,
                "vertices": corners([0.0, 0.0, 0.0], [0.1, 0.1, 0.1]), "indices": [0, 1, 2]}
        ],
        "materials": [{"id": "mat", "baseColor": [1, 1, 1], "metallic": 0, "roughness": 1}],
        "instances": [
            instance("notch-ground", "notch-ground",
                [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -0.1, 0.0, 1.0]),
            instance("notch-ball", "notch-proxy",
                [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0,
                 ROLL_START[0], ROLL_START[1], ROLL_START[2], 1.0]),
            instance("notch-l", "notch-proxy",
                [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0])
        ]
    }))
    .unwrap()
}

type BallPose = [f32; 10];

fn run_notch(
    collider: serde_json::Value,
    start: [f64; 3],
    velocity: Option<[f64; 3]>,
    steps: usize,
) -> Vec<BallPose> {
    let runtime =
        parse_and_validate_dynamic_scene_runtime(&notch_scene(collider, start, velocity)).unwrap();
    let mut packet = notch_packet();
    let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .expect("notch runtime must produce a host");
    let mut poses = Vec::with_capacity(steps);
    for _ in 0..steps {
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 1);
        let binding = host
            .bindings
            .iter()
            .find(|binding| {
                binding
                    .instances
                    .iter()
                    .any(|(instance, _)| instance == "notch-ball")
            })
            .expect("physics-owned ball");
        let body = host.bodies.get(binding.handle).expect("notch ball");
        let t = body.translation();
        let r = body.rotation().normalize();
        let v = body.linvel();
        poses.push([t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z]);
    }
    poses
}

#[test]
fn sdf_notch_catches_the_rolled_in_ball_and_repeats_bit_exactly() {
    // 验收主场景:小球从竖臂顶面滚入凹槽,与 SDF trimesh 真实接触驻留。
    let first = run_notch(
        sdf_collider_value(),
        ROLL_START,
        Some(ROLL_VELOCITY),
        SDF_STEPS,
    );
    let repeat = run_notch(
        sdf_collider_value(),
        ROLL_START,
        Some(ROLL_VELOCITY),
        SDF_STEPS,
    );
    assert_eq!(repeat, first, "same input must replay bit-exactly");

    let end = first.last().expect("poses recorded");
    let [x, y, z, ..] = *end;
    let (x, y, z) = (f64::from(x), f64::from(y), f64::from(z));
    assert!(
        (1.05..2.3).contains(&x),
        "ball must settle inside the notch after rolling in, got x={x}"
    );
    let rest_error = (y - (1.0 + BALL_RADIUS)).abs();
    assert!(
        rest_error < 0.03,
        "ball must rest on the real groove floor y≈1.3, got y={y} (error {rest_error})"
    );
    // trimesh 小面片接触有确定性切向伪影(facet bias),z 向漂移有界即可。
    assert!(
        (z - 0.5).abs() < 0.12,
        "ball must stay near the z=0.5 plane, got z={z}"
    );
}

#[test]
fn native_host_rejects_soft_body_payloads_fail_closed() {
    // F6:布料/软体通道由 Web 求解器会话承担;Native 宿主必须显式拒收,
    // 不静默丢弃作者内容。载荷须能通过运行包校验(结构合法),仅 host 能力缺失。
    let mut scene = notch_scene(sdf_collider_value(), ROLL_START, Some(ROLL_VELOCITY));
    scene["physics"]["softBodies"] = serde_json::json!([{
        "kind": "cloth", "id": "flag-a", "columns": 8, "rows": 8, "spacing": 0.05,
        "mass": 0.02, "compliance": 0, "damping": 0.01, "substeps": 4,
        "perturbation": 0.0, "seed": 7, "origin": [0, 1, 0], "pinned": [0],
        "wind": {"direction": [0, 0, -1], "baseSpeed": 1.0, "gustFrequency": 0.5,
                 "spatialScale": 1.0, "seed": 3}
    }]);
    let runtime = parse_and_validate_dynamic_scene_runtime(&scene)
        .expect("soft-body payload must pass package validation");
    let packet = notch_packet();
    let error = match NativePhysicsHost::from_runtime(&runtime, &packet) {
        Ok(_) => panic!("native host must reject soft bodies"),
        Err(error) => error,
    };
    assert!(
        error.contains("does not support soft bodies"),
        "got: {error}"
    );
    assert!(
        error.contains("the web solver session owns this channel"),
        "got: {error}"
    );
}

/// 首次接触 = 竖直速度首次偏离自由落体预测(Rapier 半隐式欧拉:v_{n+1} =
/// v_n − g·dt 逐步精确)。斜面接触只偏转速度而 y 仍下降,y 判据会漏检。
fn first_contact_y(poses: &[BallPose]) -> f64 {
    let g_dt = 9.81 * (1.0 / 60.0);
    for (step, pose) in poses.iter().enumerate() {
        let expected_vy = -g_dt * (step as f64 + 1.0);
        let actual_vy = f64::from(pose[8]);
        if (actual_vy - expected_vy).abs() > 0.02 {
            return f64::from(pose[1]);
        }
    }
    panic!("ball never made contact");
}

#[test]
fn convex_hull_ghost_thickness_measured_against_sdf_contact() {
    // 定量对照:同一凹槽正上方低空静止下落(x=2,零初速)。SDF 首触于真实地面
    // y≈1+r;凸包首触于幽灵斜面 (4−x)+r·√2 ≈ 2.424;厚度差解析值
    // 1 + r·(√2−1) ≈ 1.124 m。
    let hull = run_notch(hull_collider_value(), DROP_START, None, DROP_STEPS);
    let repeat = run_notch(hull_collider_value(), DROP_START, None, DROP_STEPS);
    assert_eq!(repeat, hull, "same input must replay bit-exactly");
    let sdf = run_notch(sdf_collider_value(), DROP_START, None, DROP_STEPS);

    let hull_contact = first_contact_y(&hull);
    let sdf_contact = first_contact_y(&sdf);
    let ghost = hull_contact - sdf_contact;
    assert!(
        (1.0..1.25).contains(&ghost),
        "ghost thickness (hull contact {hull_contact:.3} − SDF contact {sdf_contact:.3}) must be ≈1.124 m, got {ghost:.3}"
    );

    // 终态对照:SDF 球驻留凹槽横臂顶;凸包球沿幽灵斜面滚出凹槽(球在斜面上
    // 必然滚动),即凸包近似无法在凹槽内承接小球 —— 定性失效形态。
    let sdf_end = sdf.last().expect("poses recorded");
    let sdf_in_notch = (1.2..2.95).contains(&f64::from(sdf_end[0]))
        && (f64::from(sdf_end[1]) - (1.0 + BALL_RADIUS)).abs() < 0.05;
    assert!(
        sdf_in_notch,
        "SDF ball must stay in the notch, got x={} y={}",
        sdf_end[0], sdf_end[1]
    );
    let end = hull.last().expect("poses recorded");
    let escaped = f64::from(end[0]) > 3.0 + BALL_RADIUS || f64::from(end[1]) < 0.9;
    assert!(
        escaped,
        "hull ball must escape the notch, got x={} y={}",
        end[0], end[1]
    );
}
