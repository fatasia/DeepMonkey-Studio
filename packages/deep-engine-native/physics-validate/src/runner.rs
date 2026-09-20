//! 固定步长确定性场景执行器:按 scene-spec-v1.json 构建 Rapier 世界,
//! 由宿主精确调用 `step()` 共 `steps` 次(timestep-mode=Fixed,无 Variable),
//! 每步记录全部刚体 [tx,ty,tz,qx,qy,qz,qw] 为 FrameRecord。
//! 无 sleep、无线程、无随机、无真实时间:同一 spec 任意次运行必须逐位一致。
//! F04/F05 通过 `joints` 字段接入 revolute 关节；WASM runner 使用同一字段构造同源约束。

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
    pub joints: Vec<JointSpec>,
    #[serde(default)]
    pub contract: serde_json::Value,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct JointSpec {
    pub id: String,
    pub kind: String,
    pub body1: String,
    pub body2: String,
    pub anchor1: [f64; 3],
    pub anchor2: [f64; 3],
    pub axis: [f64; 3],
    #[serde(default)]
    pub solver: JointSolver,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motor: Option<JointMotorSpec>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum JointSolver { #[default] Impulse, Multibody }

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JointMotorSpec {
    pub target_position: f64,
    pub target_velocity: f64,
    pub stiffness: f64,
    pub damping: f64,
    pub model: JointMotorModel,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum JointMotorModel { Acceleration, Force }

fn validate_joint_controls(joint: &JointSpec) -> Result<(), String> {
    if joint.solver == JointSolver::Multibody && (joint.motor.is_some() || joint.limits.is_some()) {
        return Err(format!("joint {}: multibody motor/limits are not supported by the paired WASM API", joint.id));
    }
    let finite_f32 = |value: f64| value.is_finite() && (value as f32).is_finite();
    if let Some([min, max]) = joint.limits {
        if !finite_f32(min) || !finite_f32(max) || min > max {
            return Err(format!("joint {}: limits must be finite f32 values with min <= max", joint.id));
        }
    }
    if let Some(motor) = &joint.motor {
        if ![motor.target_position, motor.target_velocity, motor.stiffness, motor.damping]
            .into_iter().all(finite_f32) || motor.stiffness < 0.0 || motor.damping < 0.0 {
            return Err(format!("joint {}: motor values must be finite f32 and stiffness/damping nonnegative", joint.id));
        }
    }
    Ok(())
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
    integration_parameters.num_solver_iterations = 8;

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
    handles.push(("ground".into(), ground_handle));

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

    let body_handles: std::collections::HashMap<_, _> = handles.iter().cloned().collect();
    let mut joint_ids = Vec::with_capacity(spec.joints.len());
    for joint_spec in &spec.joints {
        validate_joint_controls(joint_spec).expect("valid joint controls");
        assert_eq!(joint_spec.kind, "revolute", "仅支持 revolute joint");
        let body1 = *body_handles
            .get(&joint_spec.body1)
            .unwrap_or_else(|| panic!("joint body1 missing: {}", joint_spec.body1));
        let body2 = *body_handles
            .get(&joint_spec.body2)
            .unwrap_or_else(|| panic!("joint body2 missing: {}", joint_spec.body2));
        let mut joint = RevoluteJointBuilder::new(Vec3::new(
            joint_spec.axis[0] as f32,
            joint_spec.axis[1] as f32,
            joint_spec.axis[2] as f32,
        ))
        .local_anchor1(Vec3::new(
            joint_spec.anchor1[0] as f32,
            joint_spec.anchor1[1] as f32,
            joint_spec.anchor1[2] as f32,
        ))
        .local_anchor2(Vec3::new(
            joint_spec.anchor2[0] as f32,
            joint_spec.anchor2[1] as f32,
            joint_spec.anchor2[2] as f32,
        ))
        .build();
        if let Some([min, max]) = joint_spec.limits {
            joint.set_limits([min as f32, max as f32]);
        }
        if let Some(motor) = &joint_spec.motor {
            joint.set_motor_model(match motor.model {
                JointMotorModel::Acceleration => MotorModel::AccelerationBased,
                JointMotorModel::Force => MotorModel::ForceBased,
            });
            joint.set_motor(motor.target_position as f32, motor.target_velocity as f32,
                motor.stiffness as f32, motor.damping as f32);
        }
        let data = joint.data().clone();
        let multibody_handle = if joint_spec.solver == JointSolver::Multibody {
            Some(multibody_joints.insert(body1, body2, joint, true)
                .expect("multibody joint must form an acyclic tree with one parent per child"))
        } else { impulse_joints.insert(body1, body2, joint, true); None };
        joint_ids.push((joint_spec.id.clone(), joint_spec.kind.clone(), joint_spec.body1.clone(), joint_spec.body2.clone(), data, multibody_handle));
    }

    let record = |step: u32, bodies: &RigidBodySet, multibodies: &MultibodyJointSet| -> FrameRecord {
        FrameRecord {
            step,
            bodies: handles
                .iter()
                .filter(|(id, _)| id != "ground")
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
            joints: joint_ids
                .iter()
                .map(|(id, kind, body1, body2, data, multibody_handle)| {
                    let data = if let Some(handle) = multibody_handle {
                        let (multibody, link) = multibodies.get(*handle).expect("multibody joint present");
                        &multibody.link(link).expect("multibody link present").joint.data
                    } else { data };
                    let a1 = data.local_anchor1();
                    let a2 = data.local_anchor2();
                    let f1 = data.local_frame1.rotation;
                    let f2 = data.local_frame2.rotation;
                    crate::contract::JointState {
                        id: id.clone(),
                        kind: kind.clone(),
                        body1: body1.clone(),
                        body2: body2.clone(),
                        anchor1: [a1.x, a1.y, a1.z],
                        anchor2: [a2.x, a2.y, a2.z],
                        frame1: [f1.x, f1.y, f1.z, f1.w],
                        frame2: [f2.x, f2.y, f2.z, f2.w],
                    }
                })
                .collect(),
        }
    };

    let mut frames = Vec::with_capacity(spec.timestep.steps as usize + 1);
    frames.push(record(0, &bodies, &multibody_joints));
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
        frames.push(record(step, &bodies, &multibody_joints));
    }

    RunOutcome { frames }
}

pub fn parse_spec(bytes: &[u8]) -> Result<SceneSpec, String> {
    let spec: SceneSpec = serde_json::from_slice(bytes).map_err(|error| format!("scene spec: {error}"))?;
    for joint in &spec.joints { validate_joint_controls(joint)?; }
    Ok(spec)
}
