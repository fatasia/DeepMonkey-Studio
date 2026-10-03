//! T16 角色运动测试共享夹具,自 `native_character_motion_tests.rs` 原样拆出:
//! 场景装配(Scene/障碍构造/角色体)、世界常量与实例平移读取。
//! 除可见性(`pub(super)`)与 `super::` → `crate::` 导入路径调整外逐字未改。

use crate::contract::RenderPacket;
use crate::native_physics::NativePhysicsHost;
use crate::runtime_package::parse_and_validate_dynamic_scene_runtime;

pub(super) const TICK_DT: f64 = 1.0 / 60.0;
pub(super) const WALK_TICKS: usize = 60;
pub(super) const WALK_SPEED_MPS: f64 = 2.0;
pub(super) const CHARACTER_HALF_Y: f64 = 0.5;
pub(super) const CHARACTER_GAP: f64 = 0.01;
pub(super) const SPAWN_Y: f32 = (CHARACTER_HALF_Y + CHARACTER_GAP) as f32;

/// 两角即可撑出 AABB 的顶点块(每顶点 6 浮点:位置 + 法线)。
fn corners(min: [f64; 3], max: [f64; 3]) -> serde_json::Value {
    serde_json::json!([
        min[0], min[1], min[2], 0, 1, 0, max[0], max[1], max[2], 0, 1, 0, 0, 0, 0, 0, 1, 0
    ])
}

/// 场景装配:地面(顶面 y=0)+ 追加障碍 + 角色出生高度。
/// 障碍 body 的 rotation 走 initialPose(轴 z 俯仰),collider 随 fixed body 一起倾斜。
pub(super) struct Scene {
    pub(super) runtime: serde_json::Value,
    packet: serde_json::Value,
}

impl Scene {
    pub(super) fn new(character_spawn_y: f64, character: serde_json::Value, obstacles: Vec<Obstacle>) -> Self {
        Self::new_at(0.0, character_spawn_y, character, obstacles)
    }

    pub(super) fn new_at(
        character_spawn_x: f64,
        character_spawn_y: f64,
        character: serde_json::Value,
        obstacles: Vec<Obstacle>,
    ) -> Self {
        let spawn = (character_spawn_x, character_spawn_y);
        let mut bodies = vec![character_body(character, spawn)];
        let mut geometries = vec![character_geometry()];
        let mut instances = vec![character_instance(spawn)];
        for obstacle in &obstacles {
            bodies.push(obstacle.body.clone());
            geometries.push(obstacle.geometry.clone());
            // 实例变换 = 刚体完整位姿(含旋转):引擎按「实例局部顶点 →
            // inverse(body)·instance」计算 render-bounds,旋转必须进实例变换。
            let t = obstacle.body["initialPose"]["translation"]
                .as_array()
                .unwrap()
                .clone();
            let r = obstacle.body["initialPose"]["rotation"]
                .as_array()
                .unwrap()
                .clone();
            let (x, y, z, w) = (
                r[0].as_f64().unwrap_or(0.0),
                r[1].as_f64().unwrap_or(0.0),
                r[2].as_f64().unwrap_or(0.0),
                r[3].as_f64().unwrap_or(1.0),
            );
            let transform = [
                1.0 - 2.0 * (y * y + z * z),
                2.0 * (x * y + z * w),
                2.0 * (x * z - y * w),
                0.0,
                2.0 * (x * y - z * w),
                1.0 - 2.0 * (x * x + z * z),
                2.0 * (y * z + x * w),
                0.0,
                2.0 * (x * z + y * w),
                2.0 * (y * z - x * w),
                1.0 - 2.0 * (x * x + y * y),
                0.0,
                t[0].as_f64().unwrap_or(0.0),
                t[1].as_f64().unwrap_or(0.0),
                t[2].as_f64().unwrap_or(0.0),
                1.0,
            ];
            instances.push(serde_json::json!({
                "id": format!("inst-{}", obstacle.body["id"].as_str().unwrap()),
                "geometry": format!("geo-{}", obstacle.body["id"].as_str().unwrap()),
                "material": "mat",
                "transform": transform
            }));
        }
        Self {
            runtime: serde_json::json!({
                "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3,
                "id": "t16-character", "revision": 1,
                "physics": {"schema": "deep-engine.physics-runtime", "schemaVersion": 1,
                    "enabled": true, "playing": true, "gravity": [0, -9.81, 0],
                    "bodies": bodies, "joints": []}
            }),
            packet: serde_json::json!({
                "schema": "deep-engine.render-packet", "version": 1,
                "geometries": geometries,
                "materials": [{"id": "mat", "baseColor": [1, 1, 1], "metallic": 0, "roughness": 1}],
                "instances": instances
            }),
        }
    }

    /// 地面 + 默认角色(底 0.01 间隙)+ 障碍,直接挂载宿主。
    pub(super) fn mount(self) -> (NativePhysicsHost, RenderPacket) {
        let runtime = parse_and_validate_dynamic_scene_runtime(&self.runtime).unwrap();
        let packet: RenderPacket = serde_json::from_value(self.packet).unwrap();
        let host = NativePhysicsHost::from_runtime(&runtime, &packet)
            .unwrap()
            .expect("t16 character runtime must mount");
        (host, packet)
    }
}

pub(super) struct Obstacle {
    body: serde_json::Value,
    geometry: serde_json::Value,
}

fn character_geometry() -> serde_json::Value {
    serde_json::json!({
        "id": "geo-body-char", "revision": 1,
        "vertices": corners([-0.25, -0.5, -0.25], [0.25, 0.5, 0.25]), "indices": [0, 1, 2]
    })
}

pub(super) fn character_config(overrides: serde_json::Value) -> serde_json::Value {
    let mut value = serde_json::json!({
        "offset": 0.01,
        "maxSlopeClimbAngle": std::f64::consts::FRAC_PI_4,
        "minSlopeSlideAngle": std::f64::consts::FRAC_PI_4,
        "autostep": {"enabled": true, "maxHeight": 0.3, "minWidth": 0.2, "includeDynamicBodies": false},
        "snapToGround": {"enabled": true, "distance": 0.2}
    });
    if let Some(object) = overrides.as_object() {
        for (key, field) in object {
            value[key.clone()] = field.clone();
        }
    }
    value
}

fn character_body(character: serde_json::Value, spawn: (f64, f64)) -> serde_json::Value {
    serde_json::json!({
        "id": "body-char", "type": "kinematic",
        "initialPose": {"translation": [spawn.0, spawn.1, 0.0], "rotation": [0, 0, 0, 1]},
        "mass": 1, "friction": 0.6, "restitution": 0,
        "character": character,
        "collider": {"kind": "render-bounds", "instanceIds": ["inst-body-char"]}
    })
}

fn character_instance(spawn: (f64, f64)) -> serde_json::Value {
    serde_json::json!({
        "id": "inst-body-char", "geometry": "geo-body-char", "material": "mat",
        "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, spawn.0, spawn.1, 0, 1]
    })
}

/// 顶面 y=0 的地面:实例平移 y=-0.05,顶点块直接给世界坐标一致的范围。
pub(super) fn ground_obstacle() -> Obstacle {
    Obstacle {
        body: serde_json::json!({
            "id": "body-ground", "type": "fixed",
            "initialPose": {"translation": [0.0, -0.05, 0.0], "rotation": [0, 0, 0, 1]},
            "mass": 1, "friction": 0.6, "restitution": 0,
            "collider": {"kind": "render-bounds", "instanceIds": ["inst-body-ground"]}
        }),
        geometry: serde_json::json!({
            "id": "geo-body-ground", "revision": 1,
            "vertices": corners([-5.0, -0.05, -5.0], [5.0, 0.05, 5.0]), "indices": [0, 1, 2]
        }),
    }
}

/// 平面障碍:cuboid [min,max](世界坐标),fixed。
pub(super) fn box_obstacle(id: &str, min: [f64; 3], max: [f64; 3]) -> Obstacle {
    let center = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    Obstacle {
        body: serde_json::json!({
            "id": id, "type": "fixed",
            "initialPose": {"translation": center, "rotation": [0, 0, 0, 1]},
            "mass": 1, "friction": 0.6, "restitution": 0,
            "collider": {"kind": "render-bounds", "instanceIds": [format!("inst-{id}")]}
        }),
        geometry: serde_json::json!({
            "id": format!("geo-{id}"), "revision": 1,
            "vertices": corners([
                min[0] - center[0], min[1] - center[1], min[2] - center[2]
            ], [
                max[0] - center[0], max[1] - center[1], max[2] - center[2]
            ]),
            "indices": [0, 1, 2]
        }),
    }
}

/// 绕 z 轴俯仰的斜坡(fixed body 带 initialPose 旋转;collider 随 body 倾斜)。
pub(super) fn ramp_obstacle(id: &str, translation: [f64; 3], pitch_z_degrees: f64) -> Obstacle {
    let half = pitch_z_degrees.to_radians() * 0.5;
    Obstacle {
        body: serde_json::json!({
            "id": id, "type": "fixed",
            "initialPose": {"translation": translation,
                "rotation": [0.0, 0.0, half.sin(), half.cos()]},
            "mass": 1, "friction": 0.6, "restitution": 0,
            "collider": {"kind": "render-bounds", "instanceIds": [format!("inst-{id}")]}
        }),
        geometry: serde_json::json!({
            "id": format!("geo-{id}"), "revision": 1,
            "vertices": corners([-2.0, -0.1, -1.0], [2.0, 0.1, 1.0]), "indices": [0, 1, 2]
        }),
    }
}

pub(super) fn translation_of(packet: &RenderPacket, instance: &str) -> [f32; 3] {
    let instance = packet
        .instances
        .iter()
        .find(|candidate| candidate.id == instance)
        .unwrap_or_else(|| panic!("instance {instance} missing"));
    [
        instance.transform[12],
        instance.transform[13],
        instance.transform[14],
    ]
}

pub(super) fn flat_world() -> (NativePhysicsHost, RenderPacket) {
    Scene::new(
        CHARACTER_HALF_Y + CHARACTER_GAP,
        character_config(serde_json::json!(null)),
        vec![ground_obstacle()],
    )
    .mount()
}
