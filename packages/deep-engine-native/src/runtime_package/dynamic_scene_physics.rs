use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

use super::dynamic_scene::DynamicSceneRuntime;
use super::{RuntimePackageError, fail};

const MAX_PHYSICS_BODIES: usize = 16_384;
const MAX_PHYSICS_JOINTS: usize = 16_384;
const MAX_COLLIDER_INSTANCES: usize = 65_536;
const MAX_COLLIDER_HULL_POINTS: usize = 65_536;
const MAX_COLLIDER_VERTICES: usize = 65_536;
const MAX_COLLIDER_INDICES: usize = 196_608;

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
    /// T17 齿轮耦合;旧运行包省略时为空。
    #[serde(default)]
    pub gears: Vec<DynamicGearConstraintRuntime>,
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
    pub initial_linear_velocity: Option<[f64; 3]>,
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
    #[serde(default)]
    pub points: Vec<[f64; 3]>,
    #[serde(default)]
    pub positions: Vec<[f64; 3]>,
    #[serde(default)]
    pub indices: Vec<u32>,
    #[serde(default)]
    pub primitive: Option<DynamicPhysicsPrimitiveColliderRuntime>,
    #[serde(default)]
    pub precision: Option<DynamicPhysicsColliderPrecisionRuntime>,
}

/// T17 collider 精度标记镜像:approximate=true 时消费方不得把 collider 当精确几何。
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsColliderPrecisionRuntime {
    #[serde(default)]
    pub approximate: Option<bool>,
    #[serde(default)]
    pub reasons: Option<Vec<String>>,
    #[serde(default)]
    pub tolerance: Option<f64>,
    #[serde(default)]
    pub hull_vertex_count: Option<u64>,
    #[serde(default)]
    pub triangle_count: Option<u64>,
    #[serde(default)]
    pub topology_ok: Option<bool>,
    #[serde(default)]
    pub topology_issue_codes: Option<Vec<String>>,
    #[serde(default)]
    pub concave_source: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsPrimitiveColliderRuntime {
    pub shape: String,
    #[serde(default)]
    pub half_extents: Option<[f64; 3]>,
    #[serde(default)]
    pub radius: Option<f64>,
    #[serde(default)]
    pub half_height: Option<f64>,
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
    /// T17 位置伺服;enabled 时覆盖 target_velocity。省略时保持速度马达语义。
    #[serde(default)]
    pub position: Option<DynamicPhysicsPositionMotorRuntime>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsPositionMotorRuntime {
    pub enabled: bool,
    /// 关节坐标:revolute 为弧度、prismatic 为米(相对关节锚定初始姿态)。
    pub target: f64,
    pub stiffness: f64,
    pub damping: f64,
}

/// T17 齿轮耦合:从动关节坐标 = ratio × 主动关节坐标(位置伺服跟随)。
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicGearConstraintRuntime {
    pub id: String,
    pub driver_joint_id: String,
    pub follower_joint_id: String,
    pub ratio: f64,
    pub stiffness: f64,
    pub damping: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DynamicPhysicsCommand {
    Configure {
        playing: bool,
        gravity: [f64; 3],
    },
    UpsertBody(DynamicPhysicsBodyRuntime),
    UpsertJoint(DynamicPhysicsJointRuntime),
    /// 关节全部建立后一次性下发;host 需要关节/刚体句柄映射才能构造耦合器。
    ConfigureGears(Vec<DynamicGearConstraintRuntime>),
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
        let mut gears = physics.gears.clone();
        gears.sort_by(|left, right| left.id.cmp(&right.id));
        let mut commands = Vec::with_capacity(2 + bodies.len() + joints.len());
        commands.push(DynamicPhysicsCommand::Configure {
            playing: physics.playing,
            gravity: physics.gravity,
        });
        commands.extend(bodies.into_iter().map(DynamicPhysicsCommand::UpsertBody));
        commands.extend(joints.into_iter().map(DynamicPhysicsCommand::UpsertJoint));
        if !gears.is_empty() {
            commands.push(DynamicPhysicsCommand::ConfigureGears(gears));
        }
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
            || body.initial_linear_velocity.is_some_and(|velocity| {
                body.r#type != "dynamic"
                    || velocity
                        .iter()
                        .any(|component| !component.is_finite() || component.abs() > 1_000.0)
            })
            || !valid_collider(&body.collider)
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
            || (joint.kind != "revolute" && joint.kind != "prismatic")
            || (joint.kind == "prismatic" && joint.solver != "impulse")
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
            || joint.motor.position.as_ref().is_some_and(|position| {
                !position.target.is_finite()
                    || !position.stiffness.is_finite()
                    || position.stiffness <= 0.0
                    || !position.damping.is_finite()
                    || position.damping < 0.0
                    || (position.enabled && (joint.solver != "impulse" || !joint.motor.enabled))
            })
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
    // T17 齿轮耦合:引用既有 impulse 同类关节;ratio 非零有限、gain fail-closed。
    let joint_kind: HashMap<&str, &str> = physics
        .joints
        .iter()
        .map(|joint| (joint.id.as_str(), joint.kind.as_str()))
        .collect();
    let impulse_joints: HashSet<&str> = physics
        .joints
        .iter()
        .filter(|joint| joint.solver == "impulse")
        .map(|joint| joint.id.as_str())
        .collect();
    previous = "";
    let mut gear_ids = HashSet::new();
    for gear in &physics.gears {
        let same_kind = matches!(
            (
                joint_kind.get(gear.driver_joint_id.as_str()),
                joint_kind.get(gear.follower_joint_id.as_str()),
            ),
            (Some(driver), Some(follower)) if driver == follower
        );
        if !valid_resource_id(&gear.id)
            || (!previous.is_empty() && gear.id.as_str() <= previous)
            || !gear_ids.insert(gear.id.as_str())
            || gear.driver_joint_id == gear.follower_joint_id
            || !same_kind
            || !impulse_joints.contains(gear.driver_joint_id.as_str())
            || !impulse_joints.contains(gear.follower_joint_id.as_str())
            || !gear.ratio.is_finite()
            || gear.ratio == 0.0
            || !gear.stiffness.is_finite()
            || gear.stiffness <= 0.0
            || !gear.damping.is_finite()
            || gear.damping < 0.0
        {
            return fail("dynamic physics gear coupling is invalid or unsupported");
        }
        previous = &gear.id;
    }
    Ok(())
}

/// T17 collider 来源校验:与 TS `dynamicSceneRuntime.parseCollider` 逐条镜像——
/// 每 kind 只接受自己的几何字段;generated kinds(convex-hull/simplified-mesh)
/// 必须携带精度标记,缺失即拒整包,杜绝来源不可追溯的 collider 进入 Native。
fn valid_collider(collider: &DynamicPhysicsColliderRuntime) -> bool {
    let instance_ids_ok = !collider.instance_ids.is_empty()
        && collider.instance_ids.len() <= MAX_COLLIDER_INSTANCES
        && collider.instance_ids.iter().all(|id| valid_resource_id(id))
        && strictly_sorted_unique(&collider.instance_ids);
    let precision_ok = |required: bool| match &collider.precision {
        Some(precision) => valid_collider_precision(precision),
        None => !required,
    };
    let no_residual = |points: bool, mesh: bool, primitive: bool| {
        (!points || collider.points.is_empty())
            && (!mesh || (collider.positions.is_empty() && collider.indices.is_empty()))
            && (!primitive || collider.primitive.is_none())
    };
    match collider.kind.as_str() {
        "render-bounds" => instance_ids_ok && no_residual(true, true, true) && precision_ok(false),
        "convex-hull" => {
            instance_ids_ok
                && no_residual(false, true, true)
                && collider.points.len() >= 4
                && collider.points.len() <= MAX_COLLIDER_HULL_POINTS
                && collider
                    .points
                    .iter()
                    .all(|point| point.iter().all(|v| v.is_finite()))
                && precision_ok(true)
        }
        "simplified-mesh" => {
            instance_ids_ok
                && no_residual(true, false, true)
                && collider.positions.len() >= 3
                && collider.positions.len() <= MAX_COLLIDER_VERTICES
                && collider
                    .positions
                    .iter()
                    .all(|point| point.iter().all(|v| v.is_finite()))
                && collider.indices.len() >= 3
                && collider.indices.len() % 3 == 0
                && collider.indices.len() <= MAX_COLLIDER_INDICES
                && collider
                    .indices
                    .iter()
                    .all(|index| (*index as usize) < collider.positions.len())
                && precision_ok(true)
        }
        "primitive" => {
            instance_ids_ok
                && no_residual(true, true, false)
                && precision_ok(false)
                && collider
                    .primitive
                    .as_ref()
                    .is_some_and(valid_primitive_collider)
        }
        _ => false,
    }
}

fn valid_collider_precision(precision: &DynamicPhysicsColliderPrecisionRuntime) -> bool {
    precision
        .tolerance
        .is_none_or(|tolerance| tolerance.is_finite() && tolerance > 0.0 && tolerance <= 1e6)
        && precision.reasons.as_ref().is_none_or(|reasons| {
            reasons.len() <= 8
                && reasons
                    .iter()
                    .all(|reason| !reason.is_empty() && reason.len() <= 128)
        })
        && precision.topology_issue_codes.as_ref().is_none_or(|codes| {
            codes.len() <= 16
                && codes.iter().all(|code| {
                    (1..=32).contains(&code.len())
                        && code.chars().all(|c| c.is_ascii_uppercase() || c == '_')
                })
        })
}

fn valid_primitive_collider(primitive: &DynamicPhysicsPrimitiveColliderRuntime) -> bool {
    let meter = |value: f64| value.is_finite() && value > 0.0 && value <= 1e6;
    match primitive.shape.as_str() {
        "cuboid" => primitive
            .half_extents
            .is_some_and(|extents| extents.iter().all(|value| meter(*value))),
        "sphere" => primitive.radius.is_some_and(meter),
        "cylinder" => {
            primitive.radius.is_some_and(meter) && primitive.half_height.is_some_and(meter)
        }
        _ => false,
    }
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
