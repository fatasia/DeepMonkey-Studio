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
/// F6 SDF 体素场预算(与 TS MAX_SDF_GRID_CELLS 同源)。
const MAX_SDF_GRID_CELLS: u64 = 262_144;
/// F6 布料/软体预算护栏(与 TS parseSoftBodies 同源,超限 fail-closed)。
const MAX_SOFT_BODIES: usize = 16;
const MAX_SOFT_BODY_PARTICLES: u64 = 16_384;
const MAX_SOFT_BODY_TETS: usize = 32_768;
const MAX_SOFT_TOTAL_PARTICLES: u64 = 65_536;
const MAX_SOFT_SUBSTEPS: u32 = 16;

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
    /// F6 布料/软体 opt-in 通道;旧运行包省略时为空。Native 宿主暂不支持
    /// (Rapier 无布料/软体),非空在 host 构造期 fail-closed 拒收。
    #[serde(default)]
    pub soft_bodies: Vec<DynamicSoftBodyRuntime>,
}

/// F6 布料/软体判别联合(kind 区分;字段域与 TS parseSoftBodies 镜像)。
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicSoftBodyRuntime {
    pub kind: String,
    pub id: String,
    pub mass: f64,
    pub damping: f64,
    pub substeps: u32,
    #[serde(default)]
    pub pinned: Vec<u32>,
    #[serde(default)]
    pub ground_y: Option<f64>,
    // cloth 专属
    #[serde(default)]
    pub columns: Option<u32>,
    #[serde(default)]
    pub rows: Option<u32>,
    #[serde(default)]
    pub spacing: Option<f64>,
    #[serde(default)]
    pub compliance: Option<f64>,
    #[serde(default)]
    pub perturbation: Option<f64>,
    #[serde(default)]
    pub seed: Option<i32>,
    #[serde(default)]
    pub origin: Option<[f64; 3]>,
    #[serde(default)]
    pub wind: Option<DynamicClothWindRuntime>,
    // soft-body 专属
    #[serde(default)]
    pub positions: Vec<[f64; 3]>,
    #[serde(default)]
    pub tets: Vec<[u32; 4]>,
    #[serde(default)]
    pub compliance_distance: Option<f64>,
    #[serde(default)]
    pub compliance_volume: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicClothWindRuntime {
    pub direction: [f64; 3],
    pub base_speed: f64,
    pub gust_frequency: f64,
    pub spatial_scale: f64,
    pub seed: i32,
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
    /// F6 sdf-grid:有界 SDF 体素场载荷(kind=sdf-grid 时必带)。
    #[serde(default)]
    pub sdf: Option<DynamicPhysicsSdfGridRuntime>,
    #[serde(default)]
    pub precision: Option<DynamicPhysicsColliderPrecisionRuntime>,
}

/// F6 SDF 有界体素场(与 TS dynamicSceneRuntime.DynamicPhysicsSdfGridRuntime 同构;
/// distances 为 JSON number 形式的 f32 值,长度 = dimensions 体积)。
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPhysicsSdfGridRuntime {
    pub origin: [f64; 3],
    pub cell_size: f64,
    pub dimensions: [u64; 3],
    pub distances: Vec<f64>,
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
            // F6:sdf-grid 凹体碰撞只允许 fixed 刚体(与 TS parsePhysics 镜像)。
            || (body.collider.kind == "sdf-grid" && body.r#type != "fixed")
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
    // F6 布料/软体:预算护栏 fail-closed(与 TS parseSoftBodies 镜像);
    // 结构合法的载荷仍会被 NativePhysicsHost 拒收(Rapier 无布料/软体)。
    valid_soft_bodies(&physics.soft_bodies)?;
    Ok(())
}

/// F6 布料/软体载荷域:id 唯一升序、公共参数域、kind 专属字段域、粒子/四面体
/// 预算与总量;超限/越界一律拒整包。
fn valid_soft_bodies(soft_bodies: &[DynamicSoftBodyRuntime]) -> Result<(), RuntimePackageError> {
    if soft_bodies.len() > MAX_SOFT_BODIES {
        return fail("dynamic physics soft bodies exceed the budget");
    }
    let mut previous = "";
    let mut total_particles: u64 = 0;
    for body in soft_bodies {
        let common_ok = valid_resource_id(&body.id)
            && (previous.is_empty() || body.id.as_str() > previous)
            && body.mass.is_finite()
            && body.mass > 0.0
            && body.damping.is_finite()
            && (0.0..1.0).contains(&body.damping)
            && (1..=MAX_SOFT_SUBSTEPS).contains(&body.substeps)
            && body.ground_y.is_none_or(|ground| ground.is_finite())
            && strictly_sorted_unique_u32(&body.pinned);
        if !common_ok {
            return fail("dynamic physics soft body is invalid");
        }
        let particles: u64 = match body.kind.as_str() {
            "cloth" => {
                let (Some(columns), Some(rows), Some(spacing), Some(compliance), Some(perturbation), Some(_seed), Some(origin)) =
                    (body.columns, body.rows, body.spacing, body.compliance, body.perturbation, body.seed, body.origin)
                else {
                    return fail("dynamic physics cloth soft body is missing cloth fields");
                };
                if !body.positions.is_empty()
                    || !body.tets.is_empty()
                    || body.compliance_distance.is_some()
                    || body.compliance_volume.is_some()
                    || columns < 2
                    || rows < 2
                    || u64::from(columns) * u64::from(rows) > MAX_SOFT_BODY_PARTICLES
                    || !spacing.is_finite()
                    || !(0.0..=1e6).contains(&spacing)
                    || !compliance.is_finite()
                    || compliance < 0.0
                    || !perturbation.is_finite()
                    || perturbation < 0.0
                    || origin.iter().any(|value| !value.is_finite())
                {
                    return fail("dynamic physics cloth soft body is invalid");
                }
                if let Some(wind) = &body.wind {
                    if !wind.direction.iter().any(|component| component.abs() > 1e-9)
                        || wind.direction.iter().any(|component| !component.is_finite())
                        || !wind.base_speed.is_finite()
                        || wind.base_speed < 0.0
                        || !wind.gust_frequency.is_finite()
                        || wind.gust_frequency <= 0.0
                        || !wind.spatial_scale.is_finite()
                        || wind.spatial_scale < 0.0
                    {
                        return fail("dynamic physics cloth wind is invalid");
                    }
                }
                u64::from(columns) * u64::from(rows)
            }
            "soft-body" => {
                if body.columns.is_some()
                    || body.rows.is_some()
                    || body.spacing.is_some()
                    || body.compliance.is_some()
                    || body.perturbation.is_some()
                    || body.seed.is_some()
                    || body.origin.is_some()
                    || body.wind.is_some()
                    || body.positions.len() < 4
                    || body.positions.len() as u64 > MAX_SOFT_BODY_PARTICLES
                    || body.positions.iter().any(|point| point.iter().any(|value| !value.is_finite()))
                    || body.tets.is_empty()
                    || body.tets.len() > MAX_SOFT_BODY_TETS
                    || body
                        .tets
                        .iter()
                        .any(|tet| tet.iter().any(|index| (*index as usize) >= body.positions.len()))
                    || body.tets.iter().any(|tet| {
                        (tet[0] == tet[1]) || (tet[0] == tet[2]) || (tet[0] == tet[3])
                            || (tet[1] == tet[2]) || (tet[1] == tet[3]) || (tet[2] == tet[3])
                    })
                    || body.compliance_distance.is_none_or(|value| !value.is_finite() || value < 0.0)
                    || body.compliance_volume.is_none_or(|value| !value.is_finite() || value < 0.0)
                {
                    return fail("dynamic physics tetra soft body is invalid");
                }
                body.positions.len() as u64
            }
            _ => return fail("dynamic physics soft body kind is unsupported"),
        };
        let last_pinned = body.pinned.last().copied().unwrap_or(0);
        if last_pinned as u64 >= particles.max(1) && !body.pinned.is_empty() {
            return fail("dynamic physics soft body pinned index is out of range");
        }
        total_particles += particles;
        previous = &body.id;
    }
    if total_particles > MAX_SOFT_TOTAL_PARTICLES {
        return fail("dynamic physics soft body particle total exceeds the budget");
    }
    Ok(())
}

fn strictly_sorted_unique_u32(values: &[u32]) -> bool {
    values.windows(2).all(|pair| pair[0] < pair[1])
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
            && collider.sdf.is_none()
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
        // F6:SDF 有界体素场载荷;kind=sdf-grid 只接受 sdf 字段,其余残留拒绝。
        "sdf-grid" => {
            collider.points.is_empty()
                && collider.positions.is_empty()
                && collider.indices.is_empty()
                && collider.primitive.is_none()
                && instance_ids_ok
                && collider
                    .sdf
                    .as_ref()
                    .is_some_and(|sdf| valid_sdf_grid(sdf))
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

/// F6:SDF 体素场载荷域(每维 2..=128、cells ≤ 预算、distances 填满且有限、
/// cellSize/origin 米制有界)——与 TS parseCollider 逐条镜像。
fn valid_sdf_grid(sdf: &DynamicPhysicsSdfGridRuntime) -> bool {
    let [nx, ny, nz] = sdf.dimensions;
    let dims_ok = (2..=128).contains(&nx)
        && (2..=128).contains(&ny)
        && (2..=128).contains(&nz)
        && nx.saturating_mul(ny).saturating_mul(nz) <= MAX_SDF_GRID_CELLS;
    dims_ok
        && sdf.distances.len() as u64 == nx * ny * nz
        && sdf.distances.iter().all(|value| value.is_finite())
        && sdf.cell_size.is_finite()
        && sdf.cell_size > 0.0
        && sdf.cell_size <= 1e6
        && sdf.origin.iter().all(|value| value.is_finite())
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
