use std::collections::HashMap;

use rapier3d::{
    math::{
        Pose,
        glamx::{Mat4, Quat, Vec3},
    },
    prelude::*,
};

use crate::{
    contract::RenderPacket,
    runtime_package::{
        DynamicPhysicsBodyRuntime, DynamicPhysicsCommand, DynamicPhysicsJointRuntime,
        DynamicSceneRuntime,
    },
};

const FIXED_TIMESTEP_SECONDS: f64 = 1.0 / 60.0;
const MAX_CATCH_UP_SECONDS: f64 = 0.2;

struct BodyBinding {
    handle: RigidBodyHandle,
    dynamic: bool,
    instances: Vec<(String, Mat4)>,
}

/// Transactionally constructed Rapier product host. `new` builds every body,
/// collider and joint before the caller publishes it into live PlayerContent.
pub struct NativePhysicsHost {
    playing: bool,
    accumulator: f64,
    gravity: Vec3,
    pipeline: PhysicsPipeline,
    integration: IntegrationParameters,
    islands: IslandManager,
    broad_phase: BroadPhaseBvh,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    ccd: CCDSolver,
    bindings: Vec<BodyBinding>,
}

impl NativePhysicsHost {
    pub fn from_runtime(
        runtime: &DynamicSceneRuntime,
        packet: &RenderPacket,
    ) -> Result<Option<Self>, String> {
        let Some(physics) = &runtime.physics else {
            return Ok(None);
        };
        let physics_body_ids: std::collections::HashSet<_> =
            physics.bodies.iter().map(|body| body.id.as_str()).collect();
        if runtime.animation.as_ref().is_some_and(|animation| {
            animation
                .tracks
                .iter()
                .any(|track| physics_body_ids.contains(track.target_id.as_str()))
        }) {
            return Err(
                "dynamic animation and physics cannot both own the same rigid body transform"
                    .into(),
            );
        }
        let mut host = Self {
            playing: false,
            accumulator: 0.0,
            gravity: Vec3::ZERO,
            pipeline: PhysicsPipeline::new(),
            integration: IntegrationParameters::default(),
            islands: IslandManager::new(),
            broad_phase: BroadPhaseBvh::new(),
            narrow_phase: NarrowPhase::new(),
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            ccd: CCDSolver::new(),
            bindings: Vec::new(),
        };
        host.integration.dt = FIXED_TIMESTEP_SECONDS as f32;
        host.integration.num_solver_iterations = 8;
        let world = host.bodies.insert(RigidBodyBuilder::fixed().build());
        let mut handles = HashMap::new();
        for command in runtime.physics_commands() {
            match command {
                DynamicPhysicsCommand::Configure { playing, gravity } => {
                    host.playing = playing;
                    host.gravity = vec3(gravity)?;
                }
                DynamicPhysicsCommand::UpsertBody(body) => {
                    let (handle, binding) = host.insert_body(packet, &body)?;
                    handles.insert(body.id, handle);
                    host.bindings.push(binding);
                }
                DynamicPhysicsCommand::UpsertJoint(joint) => {
                    host.insert_joint(&handles, world, &joint)?
                }
            }
        }
        host.bindings
            .sort_by(|left, right| left.instances[0].0.cmp(&right.instances[0].0));
        Ok(Some(host))
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    /// Runtime-only floating-origin shift. Velocities, joints and author IDs are unchanged.
    pub fn rebase(&mut self, delta: [f32; 3]) {
        let offset = Vec3::from_array(delta);
        for (_, body) in self.bodies.iter_mut() {
            let next = body.translation() + offset;
            body.set_translation(next, false);
        }
    }

    pub fn advance(
        &mut self,
        delta_seconds: f64,
        packet: &mut RenderPacket,
    ) -> Result<usize, String> {
        if !self.playing || !delta_seconds.is_finite() || delta_seconds <= 0.0 {
            return Ok(0);
        }
        self.accumulator = (self.accumulator + delta_seconds).min(MAX_CATCH_UP_SECONDS);
        let mut steps = 0;
        while self.accumulator >= FIXED_TIMESTEP_SECONDS {
            self.pipeline.step(
                self.gravity,
                &self.integration,
                &mut self.islands,
                &mut self.broad_phase,
                &mut self.narrow_phase,
                &mut self.bodies,
                &mut self.colliders,
                &mut self.impulse_joints,
                &mut self.multibody_joints,
                &mut self.ccd,
                &(),
                &(),
            );
            self.accumulator -= FIXED_TIMESTEP_SECONDS;
            steps += 1;
        }
        if steps == 0 {
            return Ok(0);
        }
        self.sync_packet(packet)
    }

    fn insert_body(
        &mut self,
        packet: &RenderPacket,
        body: &DynamicPhysicsBodyRuntime,
    ) -> Result<(RigidBodyHandle, BodyBinding), String> {
        let pose = pose(body.initial_pose.translation, body.initial_pose.rotation)?;
        let builder = match body.r#type.as_str() {
            "dynamic" => RigidBodyBuilder::dynamic().ccd_enabled(true),
            "kinematic" => RigidBodyBuilder::kinematic_position_based(),
            "fixed" => RigidBodyBuilder::fixed(),
            _ => return Err(format!("physics body {} has an unsupported type", body.id)),
        };
        let handle = self.bodies.insert(builder.pose(pose).build());
        let geometry_by_id: HashMap<_, _> = packet
            .geometries
            .iter()
            .map(|geometry| (geometry.id.as_str(), geometry))
            .collect();
        let instance_by_id: HashMap<_, _> = packet
            .instances
            .iter()
            .map(|instance| (instance.id.as_str(), instance))
            .collect();
        let inverse_pose =
            Mat4::from_rotation_translation(pose.rotation, pose.translation).inverse();
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        let mut instances = Vec::new();
        for instance_id in &body.collider.instance_ids {
            let instance = instance_by_id.get(instance_id.as_str()).ok_or_else(|| {
                format!("physics body {} instance missing: {instance_id}", body.id)
            })?;
            let geometry = geometry_by_id
                .get(instance.geometry.as_str())
                .ok_or_else(|| {
                    format!(
                        "physics body {} geometry missing: {}",
                        body.id, instance.geometry
                    )
                })?;
            let world = Mat4::from_cols_array(&instance.transform);
            let local = inverse_pose * world;
            for vertex in geometry.vertices.chunks_exact(6) {
                let point = local.transform_point3(Vec3::new(vertex[0], vertex[1], vertex[2]));
                min = min.min(point);
                max = max.max(point);
            }
            instances.push((instance.id.clone(), local));
        }
        if instances.is_empty() || !min.is_finite() || !max.is_finite() {
            return Err(format!(
                "physics body {} has no finite render bounds",
                body.id
            ));
        }
        let half = ((max - min) * 0.5).max(Vec3::splat(0.01));
        let center = (max + min) * 0.5;
        let mut collider = ColliderBuilder::cuboid(half.x, half.y, half.z)
            .translation(center)
            .friction(body.friction as f32)
            .restitution(body.restitution as f32);
        if body.r#type == "dynamic" {
            collider = collider.mass(body.mass as f32);
        }
        self.colliders
            .insert_with_parent(collider.build(), handle, &mut self.bodies);
        Ok((
            handle,
            BodyBinding {
                handle,
                dynamic: body.r#type == "dynamic",
                instances,
            },
        ))
    }

    fn insert_joint(
        &mut self,
        handles: &HashMap<String, RigidBodyHandle>,
        world: RigidBodyHandle,
        joint: &DynamicPhysicsJointRuntime,
    ) -> Result<(), String> {
        let child = *handles
            .get(&joint.body_id)
            .ok_or_else(|| format!("physics joint {} child missing", joint.id))?;
        let parent = joint
            .connected_body_id
            .as_ref()
            .map(|id| {
                handles
                    .get(id)
                    .copied()
                    .ok_or_else(|| format!("physics joint {} parent missing", joint.id))
            })
            .transpose()?
            .unwrap_or(world);
        let parent_anchor = if joint.connected_body_id.is_some() {
            let parent_body = self
                .bodies
                .get(parent)
                .ok_or("physics parent body vanished")?;
            parent_body
                .position()
                .inverse_transform_point(vec3(joint.world_anchor)?)
        } else {
            vec3(joint.world_anchor)?
        };
        let mut descriptor = RevoluteJointBuilder::new(vec3(joint.axis)?)
            .local_anchor1(parent_anchor)
            .local_anchor2(vec3(joint.local_anchor)?)
            .build();
        if joint.limits.enabled {
            descriptor.set_limits([joint.limits.min as f32, joint.limits.max as f32]);
        }
        if joint.motor.enabled {
            descriptor.set_motor_model(MotorModel::ForceBased);
            descriptor.set_motor_velocity(
                joint.motor.target_velocity as f32,
                joint.motor.strength as f32,
            );
        }
        if joint.solver == "multibody" {
            self.multibody_joints
                .insert(parent, child, descriptor, true)
                .ok_or_else(|| format!("physics multibody joint {} topology rejected", joint.id))?;
        } else {
            self.impulse_joints.insert(parent, child, descriptor, true);
        }
        Ok(())
    }

    fn sync_packet(&self, packet: &mut RenderPacket) -> Result<usize, String> {
        let mut index: HashMap<_, _> = packet
            .instances
            .iter_mut()
            .map(|instance| (instance.id.clone(), instance))
            .collect();
        let mut changed = 0;
        for binding in &self.bindings {
            if !binding.dynamic {
                continue;
            }
            let body = self
                .bodies
                .get(binding.handle)
                .ok_or("physics body vanished")?;
            let world =
                Mat4::from_rotation_translation(body.rotation().normalize(), body.translation());
            for (id, local) in &binding.instances {
                let instance = index
                    .get_mut(id)
                    .ok_or_else(|| format!("physics instance vanished: {id}"))?;
                instance.transform = (world * *local).to_cols_array();
                changed += 1;
            }
        }
        Ok(changed)
    }
}

fn vec3(value: [f64; 3]) -> Result<Vec3, String> {
    let result = Vec3::new(value[0] as f32, value[1] as f32, value[2] as f32);
    result
        .is_finite()
        .then_some(result)
        .ok_or_else(|| "physics vector exceeds f32 range".into())
}

fn pose(translation: [f64; 3], rotation: [f64; 4]) -> Result<Pose, String> {
    let rotation = Quat::from_xyzw(
        rotation[0] as f32,
        rotation[1] as f32,
        rotation[2] as f32,
        rotation[3] as f32,
    );
    if !rotation.is_finite() || rotation.length_squared() <= 1e-12 {
        return Err("physics pose rotation is invalid".into());
    }
    Ok(Pose::from_parts(vec3(translation)?, rotation.normalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_package::parse_and_validate_dynamic_scene_runtime;

    fn packet() -> RenderPacket {
        serde_json::from_value(serde_json::json!({
            "schema":"deep-engine.render-packet","version":1,
            "geometries":[{"id":"cube","revision":1,"vertices":[-0.5,-0.5,-0.5,0,1,0, 0.5,-0.5,-0.5,0,1,0, 0,0.5,0.5,0,1,0],"indices":[0,1,2]}],
            "materials":[{"id":"mat","baseColor":[1,1,1],"metallic":0,"roughness":1}],
            "instances":[{"id":"instance-a","geometry":"cube","material":"mat","transform":[1,0,0,0,0,1,0,0,0,0,1,0,0,2,0,1]}]
        })).unwrap()
    }

    fn runtime_value(instance_id: &str) -> serde_json::Value {
        serde_json::json!({
            "schema":"deep-engine.dynamic-runtime","schemaVersion":3,"id":"scene","revision":1,
            "physics":{"schema":"deep-engine.physics-runtime","schemaVersion":1,"enabled":true,"playing":true,"gravity":[0,-9.81,0],
                "bodies":[{"id":"body-a","type":"dynamic","initialPose":{"translation":[0,2,0],"rotation":[0,0,0,1]},"mass":2,"friction":0.5,"restitution":0.1,
                    "collider":{"kind":"render-bounds","instanceIds":[instance_id]}}],"joints":[]}
        })
    }

    fn runtime(instance_id: &str) -> DynamicSceneRuntime {
        parse_and_validate_dynamic_scene_runtime(&runtime_value(instance_id)).unwrap()
    }

    fn runtime_with_joint() -> DynamicSceneRuntime {
        let mut value = runtime_value("instance-a");
        value["physics"]["joints"] = serde_json::json!([{
            "id":"joint-a","kind":"revolute","solver":"impulse","bodyId":"body-a","connectedBodyId":null,
            "worldAnchor":[0,2,0],"localAnchor":[0,0,0],"axis":[0,0,1],
            "limits":{"enabled":true,"min":-1,"max":1},
            "motor":{"enabled":true,"targetVelocity":1,"strength":4}
        }]);
        parse_and_validate_dynamic_scene_runtime(&value).unwrap()
    }

    #[test]
    fn consumes_runtime_commands_and_syncs_real_rapier_motion_to_render_instances() {
        let mut packet = packet();
        let mut host = NativePhysicsHost::from_runtime(&runtime("instance-a"), &packet)
            .unwrap()
            .unwrap();
        let before = packet.instances[0].transform[13];
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 1);
        assert!(packet.instances[0].transform[13] < before);
    }

    #[test]
    fn consumes_kinematic_body_without_faking_native_character_controller_support() {
        let mut value = runtime_value("instance-a");
        value["physics"]["bodies"] = serde_json::json!([{
            "id":"body-a","type":"kinematic","initialPose":{"translation":[0,2,0],"rotation":[0,0,0,1]},"mass":2,"friction":0.5,"restitution":0.1,
            "character":{"offset":0.02,"maxSlopeClimbAngle":0.7,"autostep":{"enabled":true,"maxHeight":0.3,"minWidth":0.2,"includeDynamicBodies":false},"snapToGround":{"enabled":true,"distance":0.2}},
            "collider":{"kind":"render-bounds","instanceIds":["instance-a"]}
        }]);
        let runtime = parse_and_validate_dynamic_scene_runtime(&value).unwrap();
        let mut packet = packet();
        let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
            .unwrap()
            .unwrap();
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 0);
        assert_eq!(
            packet.instances[0].transform,
            [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 1.0
            ]
        );
    }

    #[test]
    fn rejects_the_whole_host_before_publication_when_a_render_binding_is_missing() {
        let packet = packet();
        assert!(NativePhysicsHost::from_runtime(&runtime("missing-instance"), &packet).is_err());
        let legacy = parse_and_validate_dynamic_scene_runtime(&serde_json::json!({
            "schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,
            "interaction":{"schema":"deep-engine.dynamic-interaction","schemaVersion":1,"trigger":"command","action":"clear-selection","targetId":null}
        })).unwrap();
        assert!(
            NativePhysicsHost::from_runtime(&legacy, &packet)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn applies_impulse_joint_commands_deterministically() {
        let runtime = runtime_with_joint();
        let mut first_packet = packet();
        let mut second_packet = packet();
        let mut first = NativePhysicsHost::from_runtime(&runtime, &first_packet)
            .unwrap()
            .unwrap();
        let mut second = NativePhysicsHost::from_runtime(&runtime, &second_packet)
            .unwrap()
            .unwrap();
        for _ in 0..120 {
            first.advance(1.0 / 60.0, &mut first_packet).unwrap();
            second.advance(1.0 / 60.0, &mut second_packet).unwrap();
        }
        assert_eq!(
            first_packet.instances[0].transform,
            second_packet.instances[0].transform
        );
        assert_ne!(
            first_packet.instances[0].transform,
            packet().instances[0].transform
        );

        let mut value = runtime_value("instance-a");
        value["physics"]["joints"] = serde_json::json!([{
            "id":"joint-a","kind":"revolute","solver":"multibody","bodyId":"body-a","connectedBodyId":null,
            "worldAnchor":[0,2,0],"localAnchor":[0,0,0],"axis":[0,0,1],
            "limits":{"enabled":false,"min":0,"max":0},
            "motor":{"enabled":false,"targetVelocity":0,"strength":0}
        }]);
        let runtime = parse_and_validate_dynamic_scene_runtime(&value).unwrap();
        let mut packet = packet();
        let mut host = NativePhysicsHost::from_runtime(&runtime, &packet)
            .unwrap()
            .unwrap();
        assert_eq!(host.advance(1.0 / 60.0, &mut packet).unwrap(), 1);
    }
}
