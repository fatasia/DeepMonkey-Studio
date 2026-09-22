use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

use super::dynamic_scene::DynamicSceneRuntime;
use super::{RuntimePackageError, fail};

const MAX_PHYSICS_BODIES: usize = 16_384;
const MAX_PHYSICS_JOINTS: usize = 16_384;
const MAX_COLLIDER_INSTANCES: usize = 65_536;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsRuntime {
    pub schema: String,
    pub schema_version: u32,
    pub enabled: bool,
    pub playing: bool,
    pub gravity: [f64; 3],
    pub bodies: Vec<DynamicPhysicsBodyRuntime>,
    pub joints: Vec<DynamicPhysicsJointRuntime>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsBodyRuntime {
    pub id: String,
    pub r#type: String,
    pub initial_pose: DynamicPhysicsPoseRuntime,
    pub mass: f64,
    pub friction: f64,
    pub restitution: f64,
    #[serde(default)]
    pub character: Option<DynamicPhysicsCharacterControllerRuntime>,
    pub collider: DynamicPhysicsColliderRuntime,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsCharacterControllerRuntime {
    #[serde(default)]
    pub offset: Option<f64>,
    #[serde(default)]
    pub max_slope_climb_angle: Option<f64>,
    #[serde(default)]
    pub min_slope_slide_angle: Option<f64>,
    #[serde(default)]
    pub autostep: Option<DynamicPhysicsAutostepRuntime>,
    #[serde(default)]
    pub snap_to_ground: Option<DynamicPhysicsSnapToGroundRuntime>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsAutostepRuntime {
    pub enabled: bool,
    #[serde(default)]
    pub max_height: Option<f64>,
    #[serde(default)]
    pub min_width: Option<f64>,
    #[serde(default)]
    pub include_dynamic_bodies: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsSnapToGroundRuntime {
    pub enabled: bool,
    #[serde(default)]
    pub distance: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsPoseRuntime {
    pub translation: [f64; 3],
    pub rotation: [f64; 4],
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsColliderRuntime {
    pub kind: String,
    pub instance_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsJointRuntime {
    pub id: String,
    pub kind: String,
    pub solver: String,
    pub body_id: String,
    pub connected_body_id: Option<String>,
    pub world_anchor: [f64; 3],
    pub local_anchor: [f64; 3],
    pub axis: [f64; 3],
    pub limits: DynamicPhysicsLimitsRuntime,
    pub motor: DynamicPhysicsMotorRuntime,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsLimitsRuntime {
    pub enabled: bool,
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsMotorRuntime {
    pub enabled: bool,
    pub target_velocity: f64,
    pub strength: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DynamicPhysicsCommand {
    Configure { playing: bool, gravity: [f64; 3] },
    UpsertBody(DynamicPhysicsBodyRuntime),
    UpsertJoint(DynamicPhysicsJointRuntime),
}

impl DynamicSceneRuntime {
    /// Stable native host command order: world configuration, sorted bodies,
    /// then sorted joints. The host can consume this without reading author JSON.
    pub fn physics_commands(&self) -> Vec<DynamicPhysicsCommand> {
        let Some(physics) = &self.physics else {
            return Vec::new();
        };
        let mut bodies = physics.bodies.clone();
        bodies.sort_by(|left, right| left.id.cmp(&right.id));
        let mut joints = physics.joints.clone();
        joints.sort_by(|left, right| left.id.cmp(&right.id));
        let mut commands = Vec::with_capacity(1 + bodies.len() + joints.len());
        commands.push(DynamicPhysicsCommand::Configure {
            playing: physics.playing,
            gravity: physics.gravity,
        });
        commands.extend(bodies.into_iter().map(DynamicPhysicsCommand::UpsertBody));
        commands.extend(joints.into_iter().map(DynamicPhysicsCommand::UpsertJoint));
        commands
    }
}

pub(super) fn validate_physics_runtime(
    root: &Value,
    physics: &DynamicPhysicsRuntime,
) -> Result<(), RuntimePackageError> {
    if physics.schema != "deep-engine.physics-runtime"
        || physics.schema_version != 1
        || !physics.enabled
        || physics.gravity.iter().any(|value| !value.is_finite())
        || physics.bodies.is_empty()
        || physics.bodies.len() > MAX_PHYSICS_BODIES
        || physics.joints.len() > MAX_PHYSICS_JOINTS
    {
        return fail("dynamic physics envelope is invalid");
    }
    let mut previous = "";
    let mut body_ids = HashSet::new();
    for body in &physics.bodies {
        if !valid_resource_id(&body.id)
            || (!previous.is_empty() && body.id.as_str() <= previous)
            || !body_ids.insert(body.id.as_str())
            || !matches!(body.r#type.as_str(), "fixed" | "dynamic" | "kinematic")
            || (body.character.is_some() && body.r#type != "kinematic")
            || body
                .character
                .as_ref()
                .is_some_and(|character| !valid_character_controller(character))
            || body
                .initial_pose
                .translation
                .iter()
                .chain(body.initial_pose.rotation.iter())
                .any(|value| !value.is_finite())
            || body
                .initial_pose
                .rotation
                .iter()
                .map(|value| value * value)
                .sum::<f64>()
                <= 1e-18
            || !body.mass.is_finite()
            || body.mass <= 0.0
            || !body.friction.is_finite()
            || !(0.0..=2.0).contains(&body.friction)
            || !body.restitution.is_finite()
            || !(0.0..=1.0).contains(&body.restitution)
            || body.collider.kind != "render-bounds"
            || body.collider.instance_ids.is_empty()
            || body.collider.instance_ids.len() > MAX_COLLIDER_INSTANCES
            || body
                .collider
                .instance_ids
                .iter()
                .any(|id| !valid_resource_id(id))
            || !strictly_sorted_unique(&body.collider.instance_ids)
        {
            return fail("dynamic physics body is invalid");
        }
        previous = &body.id;
    }
    previous = "";
    let mut joint_ids = HashSet::new();
    let mut multibody_parent: HashMap<&str, Option<&str>> = HashMap::new();
    for (index, joint) in physics.joints.iter().enumerate() {
        if physics_joint_field_missing(root, index, "connectedBodyId")
            || !valid_resource_id(&joint.id)
            || (!previous.is_empty() && joint.id.as_str() <= previous)
            || !joint_ids.insert(joint.id.as_str())
            || joint.kind != "revolute"
            || !matches!(joint.solver.as_str(), "impulse" | "multibody")
            || !body_ids.contains(joint.body_id.as_str())
            || joint
                .connected_body_id
                .as_deref()
                .is_some_and(|id| !body_ids.contains(id) || id == joint.body_id)
            || joint
                .world_anchor
                .iter()
                .chain(joint.local_anchor.iter())
                .chain(joint.axis.iter())
                .any(|value| !value.is_finite())
            || joint.axis.iter().all(|value| value.abs() <= 1e-9)
            || !joint.limits.min.is_finite()
            || !joint.limits.max.is_finite()
            || joint.limits.min > joint.limits.max
            || !joint.motor.target_velocity.is_finite()
            || !joint.motor.strength.is_finite()
            || joint.motor.strength < 0.0
            || joint.solver == "multibody" && (joint.limits.enabled || joint.motor.enabled)
        {
            return fail("dynamic physics joint is invalid or unsupported");
        }
        if joint.solver == "multibody"
            && multibody_parent
                .insert(joint.body_id.as_str(), joint.connected_body_id.as_deref())
                .is_some()
        {
            return fail("dynamic multibody child can have only one parent");
        }
        previous = &joint.id;
    }
    for child in multibody_parent.keys() {
        let mut current = Some(*child);
        let mut visited = HashSet::new();
        while let Some(id) = current {
            if !visited.insert(id) {
                return fail("dynamic multibody graph contains a cycle");
            }
            current = multibody_parent.get(id).copied().flatten();
        }
    }
    Ok(())
}

fn valid_character_controller(character: &DynamicPhysicsCharacterControllerRuntime) -> bool {
    let angle_valid = |value: Option<f64>| {
        value.is_none_or(|value| {
            value.is_finite() && (0.0..=std::f64::consts::FRAC_PI_2).contains(&value)
        })
    };
    let length_valid = |value: Option<f64>| {
        value.is_none_or(|value| value.is_finite() && value > 0.0 && value <= 10.0)
    };
    character
        .offset
        .is_none_or(|value| value.is_finite() && value > 0.0 && value <= 10.0)
        && angle_valid(character.max_slope_climb_angle)
        && angle_valid(character.min_slope_slide_angle)
        && character
            .autostep
            .as_ref()
            .is_none_or(|step| length_valid(step.max_height) && length_valid(step.min_width))
        && character
            .snap_to_ground
            .as_ref()
            .is_none_or(|snap| length_valid(snap.distance))
}

fn strictly_sorted_unique(values: &[String]) -> bool {
    values.windows(2).all(|pair| pair[0] < pair[1])
}

fn physics_joint_field_missing(root: &Value, index: usize, field: &str) -> bool {
    root.get("physics")
        .and_then(|value| value.get("joints"))
        .and_then(Value::as_array)
        .and_then(|joints| joints.get(index))
        .and_then(Value::as_object)
        .is_none_or(|joint| !joint.contains_key(field))
}

fn valid_resource_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=256).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
}
