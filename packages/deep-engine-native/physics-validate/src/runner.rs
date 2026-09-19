//! 固定步长确定性场景执行器:按 scene-spec-v1.json 构建 Rapier 世界,
//! 由宿主精确调用 `step()` 共 `steps` 次(timestep-mode=Fixed,无 Variable),
//! 每步记录全部刚体 [tx,ty,tz,qx,qy,qz,qw] 为 FrameRecord。
//! 无 sleep、无线程、无随机、无真实时间:同一 spec 任意次运行必须逐位一致。

use crate::contract::FrameRecord;
use rapier3d::math::glamx::Vec3;
use rapier3d::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct SceneSpec {
    pub schema: String,
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub id: String,
    pub timestep: TimestepSpec,
    pub gravity: [f64; 3],
    pub ground: GroundSpec,
    pub bodies: Vec<BodySpec>,
    #[serde(default)]
    pub contract: serde_json::Value,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct TimestepSpec {
    pub mode: String,
    pub dt: f64,
    pub steps: u32,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct GroundSpec {
    pub kind: String,
    #[serde(rename = "halfExtents")]
    pub half_extents: [f64; 3],
    pub translation: [f64; 3],
    pub friction: f64,
    pub restitution: f64,
    #[serde(rename = "bodyType")]
    pub body_type: String,
    #[serde(rename = "canSleep")]
    pub can_sleep: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct BodySpec {
    pub id: String,
    pub shape: ShapeSpec,
    pub translation: [f64; 3],
    pub linvel: [f64; 3],
    #[serde(rename = "bodyType")]
    pub body_type: String,
    #[serde(rename = "canSleep")]
    pub can_sleep: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct ShapeSpec {
    pub kind: String,
    pub radius: f64,
}

/// 运行结果:frames[0] = 初始状态(step=0),其后每步一帧。
pub struct RunOutcome {
    pub frames: Vec<FrameRecord>,
}

fn f64x3(values: [f64; 3]) -> [f32; 3] {
    [values[0] as f32, values[1] as f32, values[2] as f32]
}

pub fn run_scene(spec: &SceneSpec) -> RunOutcome {
    assert_eq!(spec.schema, "deep-engine.physics-scene", "schema mismatch");
    assert_eq!(spec.schema_version, 1, "schemaVersion mismatch");
    assert_eq!(spec.timestep.mode, "fixed", "仅支持 fixed timestep");

    let gravity = Vec3::new(
        spec.gravity[0] as f32,
        spec.gravity[1] as f32,
        spec.gravity[2] as f32,
    );
    let mut integration_parameters = IntegrationParameters::default();
    integration_parameters.dt = spec.timestep.dt as f32;

    let mut physics_pipeline = PhysicsPipeline::new();
    let mut island_manager = IslandManager::new();
    let mut broad_phase = BroadPhaseBvh::new();
    let mut narrow_phase = NarrowPhase::new();
    let mut bodies = RigidBodySet::new();
    let mut colliders = ColliderSet::new();
    let mut impulse_joints = ImpulseJointSet::new();
    let mut multibody_joints = MultibodyJointSet::new();
    let mut ccd_solver = CCDSolver::new();
    let hooks = ();
    let no_events = ();

    let mut handles: Vec<(String, RigidBodyHandle)> = Vec::new();

    let ground_body = RigidBodyBuilder::fixed()
        .translation(Vec3::new(
            spec.ground.translation[0] as f32,
            spec.ground.translation[1] as f32,
            spec.ground.translation[2] as f32,
        ))
        .can_sleep(spec.ground.can_sleep)
        .build();
    let ground_handle = bodies.insert(ground_body);
    let ground_collider = ColliderBuilder::cuboid(
        spec.ground.half_extents[0] as f32,
        spec.ground.half_extents[1] as f32,
        spec.ground.half_extents[2] as f32,
    )
    .friction(spec.ground.friction as f32)
    .restitution(spec.ground.restitution as f32)
    .build();
    colliders.insert_with_parent(ground_collider, ground_handle, &mut bodies);

    for body_spec in &spec.bodies {
        let translation = f64x3(body_spec.translation);
        let linvel = f64x3(body_spec.linvel);
        let builder = if body_spec.body_type == "dynamic" {
            RigidBodyBuilder::dynamic()
        } else {
            RigidBodyBuilder::fixed()
        };
        let rigid_body = builder
            .translation(Vec3::new(translation[0], translation[1], translation[2]))
            .linvel(Vec3::new(linvel[0], linvel[1], linvel[2]))
            .can_sleep(body_spec.can_sleep)
            .build();
        let handle = bodies.insert(rigid_body);
        let collider = ColliderBuilder::ball(body_spec.shape.radius as f32)
            .friction(spec.ground.friction as f32)
            .restitution(spec.ground.restitution as f32)
            .build();
        colliders.insert_with_parent(collider, handle, &mut bodies);
        handles.push((body_spec.id.clone(), handle));
    }

    let record = |step: u32, bodies: &RigidBodySet| -> FrameRecord {
        FrameRecord {
            step,
            bodies: handles
                .iter()
                .map(|(id, handle)| {
                    let body = bodies.get(*handle).expect("rigid body present");
                    let rotation = body.rotation();
                    (
                        id.clone(),
                        [
                            body.translation().x,
                            body.translation().y,
                            body.translation().z,
                            rotation.x,
                            rotation.y,
                            rotation.z,
                            rotation.w,
                        ],
                    )
                })
                .collect(),
        }
    };

    let mut frames = Vec::with_capacity(spec.timestep.steps as usize + 1);
    frames.push(record(0, &bodies));
    for step in 1..=spec.timestep.steps {
        physics_pipeline.step(
            gravity,
            &integration_parameters,
            &mut island_manager,
            &mut broad_phase,
            &mut narrow_phase,
            &mut bodies,
            &mut colliders,
            &mut impulse_joints,
            &mut multibody_joints,
            &mut ccd_solver,
            &hooks,
            &no_events,
        );
        frames.push(record(step, &bodies));
    }

    RunOutcome { frames }
}

pub fn parse_spec(bytes: &[u8]) -> Result<SceneSpec, String> {
    serde_json::from_slice(bytes).map_err(|error| format!("scene spec: {error}"))
}
