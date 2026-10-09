// Frozen cross-host numeric references retain their original decimal precision.
#![allow(clippy::excessive_precision)]

//! T17 CAD→collider 来源规范 golden:真实 T00 工厂 machine.glb → 凸包 collider →
//! Native 射线查询命中/未命中对照。
//!
//! 冻结数据来源:`apps/api/src/physicsColliderSource.test.ts` 的 golden 测试从仓内
//! `data/external-assets/open-packs/factory.zip`(Kenney Factory Kit,CC0)提取
//! `Models/GLB format/machine.glb`(SHA-256 `a39e3042bcb7789274428357383317d70e1c3
//! 1906e5301c99e7d9e90ac584863`,464 顶点 / 268 三角形,米制),经 T12 拓扑检查后由
//! 确定性 quickhull 生成 50 顶点 / 96 面凸包,落盘
//! `test-output/t17-collider/golden-machine-hull.json`。源网格拓扑含
//! NON_MANIFOLD_EDGE(error)→ collider 按 T17 规范标记 approximate=true。
//! 两侧边界断言一致:x∈[-0.6,0.6]、y∈[0,1.29975]、z∈[-0.75,0.75]。
//! 改动任何冻结点必须先重跑 TS golden 并同步本文件。

use super::*;
use crate::runtime_package::parse_and_validate_dynamic_scene_runtime;

/// 冻结凸包顶点(刚体局部空间,米;与 TS golden 逐点一致)。
fn machine_hull_points() -> Vec<Vec3> {
    vec![
        Vec3::new(0.600000024, 2.08551371e-11, 0.500000000),
        Vec3::new(-0.600000024, 1.93293478e-10, -0.500000000),
        Vec3::new(0.500000000, 5.96144912e-16, -0.699999988),
        Vec3::new(-0.500000000, 1.72903463e-14, 0.699999988),
        Vec3::new(-0.500000000, 5.96144912e-16, -0.699999988),
        Vec3::new(-0.500000000, 0.200000003, -0.750000000),
        Vec3::new(0.500000000, 1.72903463e-14, 0.699999988),
        Vec3::new(0.500000000, 0.200000003, 0.750000000),
        Vec3::new(-0.600000024, 1.15049875, -5.71421764e-11),
        Vec3::new(-0.600000024, 1.04024935, 0.600000024),
        Vec3::new(0.600000024, 1.15049875, -9.58696011e-10),
        Vec3::new(0.600000024, 1.04024935, -0.600000024),
        Vec3::new(0.600000024, 2.06773487e-11, -0.550000012),
        Vec3::new(-0.600000024, 1.93115690e-10, 0.550000012),
        Vec3::new(0.600000024, 1.04024935, 0.600000024),
        Vec3::new(-0.600000024, 1.04024935, -0.600000024),
        Vec3::new(-0.500000000, 0.200000003, 0.750000000),
        Vec3::new(0.500000000, 1.14999998, -0.649999976),
        Vec3::new(-0.500000000, 1.14999998, -0.649999976),
        Vec3::new(-0.299999982, 1.25100517, -0.492441803),
        Vec3::new(-0.438882917, 1.28335714, -0.168922305),
        Vec3::new(-0.0171572920, 1.29975188, -0.00497511029),
        Vec3::new(0.500000000, 0.200000003, -0.750000000),
        Vec3::new(0.388668150, 0.655394435, -0.750000000),
        Vec3::new(0.500000000, 1.14999998, 0.649999976),
        Vec3::new(-0.500000000, 1.14999998, 0.649999976),
        Vec3::new(-0.500000000, 1.00000000, 0.699999988),
        Vec3::new(0.500000000, 1.00000000, 0.699999988),
        Vec3::new(-0.500000000, 1.00000000, -0.699999988),
        Vec3::new(0.500000000, 1.00000000, -0.699999988),
        Vec3::new(0.121725649, 1.26739991, -0.328494608),
        Vec3::new(0.600000024, 1.09549868, 0.550000012),
        Vec3::new(0.500000000, 1.25000000, 0.00000000),
        Vec3::new(-0.600000024, 1.09549868, 0.550000012),
        Vec3::new(-0.600000024, 1.09549868, -0.550000012),
        Vec3::new(0.600000024, 1.09549868, -0.550000012),
        Vec3::new(0.500000000, 1.19999993, 0.500000000),
        Vec3::new(-0.500000000, 1.19999993, 0.500000000),
        Vec3::new(0.500000000, 1.19999993, -0.500000000),
        Vec3::new(0.600000024, 2.08636025e-11, 0.550000012),
        Vec3::new(-0.600000024, 1.93301944e-10, -0.550000012),
        Vec3::new(-0.500000000, 1.25000000, 0.00000000),
        Vec3::new(-0.500000000, 1.19999993, -0.500000000),
        Vec3::new(0.0988904238, 0.733040154, -0.750000000),
        Vec3::new(-0.361237228, 1.25452316, -0.457261920),
        Vec3::new(-0.403527617, 1.28945041, -0.107988983),
        Vec3::new(0.0863703191, 1.26130652, -0.389427960),
        Vec3::new(0.424023479, 0.594157219, -0.750000000),
        Vec3::new(0.0440799333, 1.29623389, -0.0401549935),
        Vec3::new(0.0376531780, 0.697684824, -0.750000000),
    ]
}

fn machine_collider_value() -> serde_json::Value {
    let points: Vec<serde_json::Value> = machine_hull_points()
        .iter()
        .map(|point| serde_json::json!([point.x as f64, point.y as f64, point.z as f64]))
        .collect();
    serde_json::json!({
        "kind": "convex-hull",
        "instanceIds": ["machine-instance"],
        "points": points,
        "precision": {
            "approximate": true,
            "reasons": ["topology-error:NON_MANIFOLD_EDGE"],
            "hullVertexCount": 50,
            "triangleCount": 96,
            "topologyOk": false,
            "topologyIssueCodes": ["NON_MANIFOLD_EDGE", "DUPLICATE_TRIANGLE", "OPEN_EDGE"],
            "concaveSource": true
        }
    })
}

/// 机器 + 球体 + 简化网格盒三体场景:三种 collider 来源共存,射线互不干扰。
fn collider_scene_value() -> serde_json::Value {
    // body id 必须按字典序排列:body-machine < body-mesh < body-primitive。
    serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3, "id": "collider-golden", "revision": 1,
        "physics": {"schema": "deep-engine.physics-runtime", "schemaVersion": 1, "enabled": true,
            "playing": true, "gravity": [0, -9.81, 0],
            "bodies": [
                {"id": "body-machine", "type": "dynamic",
                    "initialPose": {"translation": [0, 0, 0], "rotation": [0, 0, 0, 1]},
                    "mass": 120, "friction": 0.6, "restitution": 0,
                    "collider": machine_collider_value()},
                {"id": "body-mesh", "type": "fixed",
                    "initialPose": {"translation": [0, -10, 0], "rotation": [0, 0, 0, 1]},
                    "mass": 1, "friction": 0.5, "restitution": 0,
                    "collider": {"kind": "simplified-mesh", "instanceIds": ["mesh-instance"],
                        "positions": [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5],
                            [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]],
                        "indices": [0, 1, 3, 0, 3, 2, 4, 7, 5, 4, 6, 7, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3],
                        "precision": {"approximate": false, "triangleCount": 12, "topologyOk": true}}},
                {"id": "body-primitive", "type": "fixed",
                    "initialPose": {"translation": [0, -5, 0], "rotation": [0, 0, 0, 1]},
                    "mass": 1, "friction": 0.5, "restitution": 0,
                    "collider": {"kind": "primitive", "instanceIds": ["sphere-instance"],
                        "primitive": {"shape": "sphere", "radius": 1.0},
                        "precision": {"approximate": false}}}
            ], "joints": []}
    })
}

fn collider_scene_packet() -> RenderPacket {
    let machine_bounds = serde_json::json!([
        -0.6, 0.0, -0.75, 0, 1, 0, 0.6, 1.29975, 0.75, 0, 1, 0, 0.0, 0.0, 0.75, 0, 1, 0
    ]);
    let box_bounds = serde_json::json!([
        -0.5, -0.5, -0.5, 0, 1, 0, 0.5, 0.5, 0.5, 0, 1, 0, 0.0, 0.0, 0.0, 0, 1, 0
    ]);
    let instance = |id: &str, geometry: &str, y: f64| {
        serde_json::json!({"id": id, "geometry": geometry, "material": "mat",
            "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, y, 0, 1]})
    };
    serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet", "version": 1,
        "geometries": [
            {"id": "machine", "revision": 1, "vertices": machine_bounds, "indices": [0, 1, 2]},
            {"id": "box", "revision": 1, "vertices": box_bounds, "indices": [0, 1, 2]},
            {"id": "sphere", "revision": 1, "vertices": box_bounds, "indices": [0, 1, 2]}
        ],
        "materials": [{"id": "mat", "baseColor": [1, 1, 1], "metallic": 0, "roughness": 1}],
        "instances": [
            instance("mesh-instance", "box", -10.0),
            instance("sphere-instance", "sphere", -5.0),
            instance("machine-instance", "machine", 0.0)
        ]
    }))
    .unwrap()
}

fn collider_host() -> (NativePhysicsHost, RenderPacket) {
    let runtime = parse_and_validate_dynamic_scene_runtime(&collider_scene_value()).unwrap();
    let packet = collider_scene_packet();
    let host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .expect("collider runtime must produce a host");
    (host, packet)
}

#[test]
fn machine_convex_hull_ray_hits_and_reports_body_toi_and_normal() {
    let (host, _packet) = collider_host();
    // 命中:从 x=-5 沿 +x 射向机械臂侧面(y=1.15, z=0;凸包在该高度 x-min=-0.6)。
    let hit = host.cast_ray([-5.0, 1.15, 0.0], [1.0, 0.0, 0.0], 100.0);
    let (body_id, toi, normal) = hit.clone().expect("ray must hit the machine hull");
    assert_eq!(body_id, "body-machine");
    // 命中点 x = -5 + toi ≈ -0.6。
    assert!(
        (toi - 4.4).abs() <= 0.05,
        "toi {toi} must place the hit near x=-0.6"
    );
    assert!(
        normal[0].abs() > 0.9,
        "hit normal must face along x, got {normal:?}"
    );
    // 逐位确定:同查询同结果。
    assert_eq!(
        host.cast_ray([-5.0, 1.15, 0.0], [1.0, 0.0, 0.0], 100.0),
        hit
    );
}

#[test]
fn machine_convex_hull_ray_misses_where_the_bounding_box_would_hit() {
    let (host, _packet) = collider_host();
    // 未命中对照(凸包 ≠ 包围盒):x=0.58、y=0.1 在 AABB 内(y∈[0,1.29975]),
    // 但该高度凸包 x 极限只有 0.55 → render-bounds 会命中,凸包必须未命中。
    assert!(
        host.cast_ray([0.55, 1.25, 5.0], [0.0, 0.0, -1.0], 100.0)
            .is_none()
    );
    // 纯未命中:机械体 z 极限 0.75,z=0.9 处射线在外侧。
    assert!(
        host.cast_ray([0.0, 0.6, 0.9], [0.0, 0.0, 1.0], 100.0)
            .is_none()
    );
}

#[test]
fn simplified_mesh_and_primitive_colliders_insert_and_answer_queries() {
    let (host, _packet) = collider_host();
    // 球体:从 z=+3 向 -z,命中 z=-4(球心 -5,半径 1)。
    let (body_id, toi, normal) = host
        .cast_ray([0.0, -5.0, 3.0], [0.0, 0.0, -1.0], 100.0)
        .expect("ray must hit the sphere primitive");
    assert_eq!(body_id, "body-primitive");
    assert!(
        (toi - 2.0).abs() <= 0.01,
        "toi {toi} must place the hit at z=-4"
    );
    assert!(
        normal[2] > 0.9,
        "sphere hit normal must face +z, got {normal:?}"
    );
    // 简化网格盒:命中 z=-9.5 面。
    let (body_id, toi, _normal) = host
        .cast_ray([0.0, -10.0, 3.0], [0.0, 0.0, -1.0], 100.0)
        .expect("ray must hit the simplified mesh box");
    assert_eq!(body_id, "body-mesh");
    assert!(
        (toi - 2.5).abs() <= 0.01,
        "toi {toi} must place the hit at z=-9.5"
    );
    // 网格盒外侧(x=0.7 > half 0.5)未命中。
    assert!(
        host.cast_ray([0.7, -10.0, 3.0], [0.0, 0.0, -1.0], 100.0)
            .is_none()
    );
}

#[test]
fn hull_collider_body_falls_and_the_query_tracks_the_new_pose() {
    let (mut host, mut packet) = collider_host();
    for _ in 0..30 {
        host.advance(1.0 / 60.0, &mut packet).unwrap();
    }
    let (step, translation) = host
        .instance_pose(&packet, "machine-instance")
        .expect("dynamic machine pose");
    assert_eq!(step, 30);
    assert!(
        translation[1] < -0.5,
        "machine must fall under gravity, y={}",
        translation[1]
    );
    // 凸包 collider 跟随刚体位姿:在下落后的机体高度上仍能命中。
    let (body_id, _toi, _normal) = host
        .cast_ray([-5.0, translation[1] + 0.5, 0.0], [1.0, 0.0, 0.0], 100.0)
        .expect("ray must hit the fallen machine hull");
    assert_eq!(body_id, "body-machine");
}

#[test]
fn collider_sources_fail_closed_on_missing_precision_or_degenerate_hulls() {
    // convex-hull 缺 precision → 解析层拒整包。
    let mut value = collider_scene_value();
    if let Some(object) = value["physics"]["bodies"][0]["collider"].as_object_mut() {
        object.remove("precision");
    }
    assert!(parse_and_validate_dynamic_scene_runtime(&value).is_err());
    // 未知 kind → 拒绝。
    let mut value = collider_scene_value();
    value["physics"]["bodies"][0]["collider"]["kind"] = serde_json::json!("magic-cloud");
    assert!(parse_and_validate_dynamic_scene_runtime(&value).is_err());
    // 几何字段串味(凸包带 indices)→ 拒绝。
    let mut value = collider_scene_value();
    value["physics"]["bodies"][0]["collider"]["indices"] = serde_json::json!([0, 1, 2]);
    assert!(parse_and_validate_dynamic_scene_runtime(&value).is_err());
    // 简化网格缺 precision → 拒绝。
    let mut value = collider_scene_value();
    if let Some(object) = value["physics"]["bodies"][1]["collider"].as_object_mut() {
        object.remove("precision");
    }
    assert!(parse_and_validate_dynamic_scene_runtime(&value).is_err());
    // 共面 4 点凸包:解析通过(有限、≥4 点),Native 构包 fail-closed。
    let mut value = collider_scene_value();
    value["physics"]["bodies"][0]["collider"]["points"] = serde_json::json!([
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [1.0, 1.0, 0.0]
    ]);
    let runtime = parse_and_validate_dynamic_scene_runtime(&value).unwrap();
    let result = NativePhysicsHost::from_runtime(&runtime, &collider_scene_packet());
    assert!(
        result.is_err(),
        "coplanar hull must be rejected by the host"
    );
    // character 控制器 + 非包围盒 collider → 拒绝。
    let mut value = collider_scene_value();
    value["physics"]["bodies"][0]["type"] = serde_json::json!("kinematic");
    value["physics"]["bodies"][0]["character"] = serde_json::json!({"offset": 0.02});
    let runtime = parse_and_validate_dynamic_scene_runtime(&value).unwrap();
    assert!(
        NativePhysicsHost::from_runtime(&runtime, &collider_scene_packet()).is_err(),
        "character controllers require render-bounds colliders"
    );
}

#[test]
fn primitive_collider_shapes_validate_before_reaching_native() {
    // cuboid 缺 halfExtents → 拒绝。
    let mut value = collider_scene_value();
    value["physics"]["bodies"][2]["collider"]["primitive"] = serde_json::json!({"shape": "cuboid"});
    assert!(parse_and_validate_dynamic_scene_runtime(&value).is_err());
    // cylinder 缺 halfHeight → 拒绝。
    let mut value = collider_scene_value();
    value["physics"]["bodies"][2]["collider"]["primitive"] =
        serde_json::json!({"shape": "cylinder", "radius": 1.0});
    assert!(parse_and_validate_dynamic_scene_runtime(&value).is_err());
    // 非法半径(0)→ 拒绝。
    let mut value = collider_scene_value();
    value["physics"]["bodies"][2]["collider"]["primitive"] =
        serde_json::json!({"shape": "sphere", "radius": 0.0});
    assert!(parse_and_validate_dynamic_scene_runtime(&value).is_err());
    // 合法 cylinder 全链:构造 + 查询命中。
    let mut value = collider_scene_value();
    value["physics"]["bodies"][2]["collider"]["primitive"] =
        serde_json::json!({"shape": "cylinder", "radius": 1.0, "halfHeight": 0.5});
    let runtime = parse_and_validate_dynamic_scene_runtime(&value).unwrap();
    let packet = collider_scene_packet();
    let host = NativePhysicsHost::from_runtime(&runtime, &packet)
        .unwrap()
        .unwrap();
    let hit = host.cast_ray([0.0, -5.0, 3.0], [0.0, 0.0, -1.0], 100.0);
    assert_eq!(hit.expect("cylinder must answer rays").0, "body-primitive");
}
