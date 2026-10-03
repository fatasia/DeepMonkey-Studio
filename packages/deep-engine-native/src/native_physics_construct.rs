//! `NativePhysicsHost` 构造期装配,自 `native_physics.rs` 原样拆出:刚体/碰撞体插入、
//! 关节装配、T17 齿轮耦合器构建,以及凸包退化守卫与位姿换算。
//! 除方法可见性(`pub(super)` 供宿主构造入口调用)与导入路径调整外逐字未改;
//! `NativePhysicsHost` 公共 API 路径与可见性零变化。

use std::collections::HashMap;

use rapier3d::{
    math::{
        Pose,
        glamx::{Mat4, Quat, Vec3},
    },
    prelude::*,
};

use super::{BodyBinding, GearCoupling, JointEndpoint, NativePhysicsHost, vec3};
use crate::contract::RenderPacket;
use crate::native_character_motion::{CharacterDriver, CharacterMotionConfig};
use crate::runtime_package::{
    DynamicGearConstraintRuntime, DynamicPhysicsBodyRuntime, DynamicPhysicsJointRuntime,
};

impl NativePhysicsHost {
    pub(super) fn insert_body(
        &mut self,
        packet: &RenderPacket,
        body: &DynamicPhysicsBodyRuntime,
    ) -> Result<(RigidBodyHandle, BodyBinding), String> {
        let pose = pose(body.initial_pose.translation, body.initial_pose.rotation)?;
        let builder = match body.r#type.as_str() {
            "dynamic" => {
                let mut builder = RigidBodyBuilder::dynamic().ccd_enabled(true);
                if let Some(velocity) = body.initial_linear_velocity {
                    builder = builder.linvel(vec3(velocity)?);
                }
                builder
            }
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
        if instances.is_empty() {
            return Err(format!(
                "physics body {} has no collider instances",
                body.id
            ));
        }
        // render-bounds 半尺寸;角色驱动器形状假设「collider = 包围盒」,非 render-bounds
        // 来源已在上方 fail-closed,这里只由 render-bounds 分支赋值。
        let mut render_half = Vec3::ZERO;
        // T17 角色驱动器形状沿 render-bounds 包围盒;其他来源刚体局部几何非包围盒,
        // 与「角色形状 = 包围盒」假设矛盾,fail-closed。
        if body.r#type == "kinematic"
            && body.character.is_some()
            && body.collider.kind != "render-bounds"
        {
            return Err(format!(
                "physics body {} character controller requires a render-bounds collider",
                body.id
            ));
        }
        let shape_builder = match body.collider.kind.as_str() {
            "render-bounds" => {
                if !min.is_finite() || !max.is_finite() {
                    return Err(format!(
                        "physics body {} has no finite render bounds",
                        body.id
                    ));
                }
                let half = ((max - min) * 0.5).max(Vec3::splat(0.01));
                render_half = half;
                ColliderBuilder::cuboid(half.x, half.y, half.z).translation((max + min) * 0.5)
            }
            "convex-hull" => {
                let points: Vec<Vec3> = body
                    .collider
                    .points
                    .iter()
                    .map(|point| Vec3::new(point[0] as f32, point[1] as f32, point[2] as f32))
                    .collect();
                ensure_non_degenerate_hull(&points)
                    .map_err(|error| format!("physics body {}: {error}", body.id))?;
                ColliderBuilder::convex_hull(&points)
                    .ok_or_else(|| format!("physics body {} convex hull is degenerate", body.id))?
            }
            "simplified-mesh" => {
                let vertices: Vec<Vec3> = body
                    .collider
                    .positions
                    .iter()
                    .map(|point| Vec3::new(point[0] as f32, point[1] as f32, point[2] as f32))
                    .collect();
                let indices: Vec<[u32; 3]> = body
                    .collider
                    .indices
                    .chunks_exact(3)
                    .map(|triangle| [triangle[0], triangle[1], triangle[2]])
                    .collect();
                ColliderBuilder::trimesh(vertices, indices).map_err(|error| {
                    format!("physics body {} triangle mesh rejected: {error}", body.id)
                })?
            }
            "primitive" => {
                let primitive = body.collider.primitive.as_ref().ok_or_else(|| {
                    format!(
                        "physics body {} primitive collider has no geometry",
                        body.id
                    )
                })?;
                let meter = |value: Option<f64>, field: &str| -> Result<f32, String> {
                    let value = value.ok_or_else(|| {
                        format!(
                            "physics body {} primitive collider missing {field}",
                            body.id
                        )
                    })?;
                    if !value.is_finite() || value.abs() > f32::MAX as f64 {
                        return Err(format!(
                            "physics body {} collider value exceeds f32 range",
                            body.id
                        ));
                    }
                    Ok(value as f32)
                };
                match primitive.shape.as_str() {
                    "cuboid" => {
                        let extents = primitive.half_extents.ok_or_else(|| {
                            format!(
                                "physics body {} cuboid collider missing halfExtents",
                                body.id
                            )
                        })?;
                        ColliderBuilder::cuboid(
                            extents[0] as f32,
                            extents[1] as f32,
                            extents[2] as f32,
                        )
                    }
                    "sphere" => ColliderBuilder::ball(meter(primitive.radius, "radius")?),
                    "cylinder" => ColliderBuilder::cylinder(
                        meter(primitive.half_height, "halfHeight")?,
                        meter(primitive.radius, "radius")?,
                    ),
                    other => {
                        return Err(format!(
                            "physics body {} has an unsupported primitive collider shape: {other}",
                            body.id
                        ));
                    }
                }
            }
            "sdf-grid" => {
                // F6:SDF 凹体碰撞桥——与 Web sdfCollisionBridge 算法逐位同构的
                // Freudenthal 六四面体零等值面提取 → trimesh collider。
                // 载荷已在运行包校验层收敛(kind=sdf-grid 仅 fixed、precision 必带)。
                let sdf = body.collider.sdf.as_ref().ok_or_else(|| {
                    format!("physics body {} sdf-grid collider has no payload", body.id)
                })?;
                let grid = crate::physics_sdf_mesh::SdfMeshInput {
                    origin: [
                        sdf.origin[0] as f32,
                        sdf.origin[1] as f32,
                        sdf.origin[2] as f32,
                    ],
                    cell_size: sdf.cell_size as f32,
                    dimensions: [
                        sdf.dimensions[0] as usize,
                        sdf.dimensions[1] as usize,
                        sdf.dimensions[2] as usize,
                    ],
                    distances: &sdf
                        .distances
                        .iter()
                        .map(|value| *value as f32)
                        .collect::<Vec<f32>>(),
                };
                let mesh = crate::physics_sdf_mesh::extract_sdf_collision_mesh(&grid)
                    .map_err(|error| format!("physics body {}: {error}", body.id))?;
                let vertices: Vec<Vec3> = mesh
                    .positions
                    .chunks_exact(3)
                    .map(|vertex| Vec3::new(vertex[0], vertex[1], vertex[2]))
                    .collect();
                let indices: Vec<[u32; 3]> = mesh
                    .indices
                    .chunks_exact(3)
                    .map(|triangle| [triangle[0], triangle[1], triangle[2]])
                    .collect();
                ColliderBuilder::trimesh(vertices, indices).map_err(|error| {
                    format!("physics body {} SDF collision mesh rejected: {error}", body.id)
                })?
            }
            other => {
                return Err(format!(
                    "physics body {} has an unsupported collider kind: {other}",
                    body.id
                ));
            }
        };
        let mut collider = shape_builder
            .friction(body.friction as f32)
            .restitution(body.restitution as f32);
        if body.r#type == "dynamic" {
            collider = collider.mass(body.mass as f32);
        }
        self.colliders
            .insert_with_parent(collider.build(), handle, &mut self.bodies);
        // T16:角色控制器消费面。合同「character 仅 kinematic 刚体消费」——
        // 带 character 配置的 kinematic 才有驱动器(重力/跳跃/状态机);
        // 无配置的 kinematic 保持「宿主显式设位姿」语义(如移动平台)。
        // 驱动器形状与自身碰撞体同用 render-bounds 包围盒,状态机从接地静止起跑。
        let character = if body.r#type == "kinematic" {
            body.character.as_ref().map(|config| {
                // 带 character 的 kinematic 必为 render-bounds(上方 fail-closed),
                // 驱动器形状与 collider 同用包围盒。
                CharacterDriver::new(
                    SharedShape::cuboid(render_half.x, render_half.y, render_half.z),
                    CharacterMotionConfig::from_runtime(Some(config)),
                    (render_half.y * 2.0) as f32,
                )
            })
        } else {
            None
        };
        Ok((
            handle,
            BodyBinding {
                body_id: body.id.clone(),
                handle,
                dynamic: body.r#type == "dynamic",
                instances,
                character,
            },
        ))
    }

    pub(super) fn insert_joint(
        &mut self,
        handles: &HashMap<String, RigidBodyHandle>,
        world: RigidBodyHandle,
        joint: &DynamicPhysicsJointRuntime,
        joint_endpoints: &mut HashMap<String, JointEndpoint>,
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
        // revolute(弧度)与 prismatic(米)共享锚点/限位/速度马达语义;multibody 解析层已限 revolute。
        let prismatic = joint.kind == "prismatic";
        let axis = if prismatic {
            JointAxis::LinX
        } else {
            JointAxis::AngX
        };
        let axis_vector = vec3(joint.axis)?;
        let mut descriptor: GenericJoint = if prismatic {
            PrismaticJointBuilder::new(axis_vector)
                .local_anchor1(parent_anchor)
                .local_anchor2(vec3(joint.local_anchor)?)
                .build()
                .into()
        } else {
            RevoluteJointBuilder::new(axis_vector)
                .local_anchor1(parent_anchor)
                .local_anchor2(vec3(joint.local_anchor)?)
                .build()
                .into()
        };
        if joint.limits.enabled {
            descriptor.set_limits(axis, [joint.limits.min as f32, joint.limits.max as f32]);
        }
        // T17 位置伺服:enabled 时覆盖速度目标(target 为关节坐标,revolute rad/prismatic m);
        // motor.enabled 是马达总开关(解析层强制伺服开启时必须为 true),此处双保险。
        let position = joint
            .motor
            .position
            .as_ref()
            .filter(|position| position.enabled);
        if joint.motor.enabled || position.is_some() {
            // 位置伺服走加速度基模型(增益与刚体惯量解耦,任意惯量体数值稳定);
            // 速度马达保持 ForceBased(与 T17 既有速度马达黄金同口径)。
            descriptor.set_motor_model(
                axis,
                if position.is_some() {
                    MotorModel::AccelerationBased
                } else {
                    MotorModel::ForceBased
                },
            );
            if let Some(position) = position {
                descriptor.set_motor_position(
                    axis,
                    position.target as f32,
                    position.stiffness as f32,
                    position.damping as f32,
                );
            } else {
                descriptor.set_motor_velocity(
                    axis,
                    joint.motor.target_velocity as f32,
                    joint.motor.strength as f32,
                );
            }
        }
        if joint.solver == "multibody" {
            self.multibody_joints
                .insert(parent, child, descriptor, true)
                .ok_or_else(|| format!("physics multibody joint {} topology rejected", joint.id))?;
        } else {
            let handle = self.impulse_joints.insert(parent, child, descriptor, true);
            // T17:齿轮耦合器按关节 ID 取端点档案(句柄/模型体/kind/轴)。
            joint_endpoints.insert(
                joint.id.clone(),
                JointEndpoint {
                    handle,
                    model_body: child,
                    revolute: !prismatic,
                    axis: axis_vector,
                },
            );
        }
        Ok(())
    }

    /// T17:按运行包 gears 构建齿轮耦合器;引用缺失或关节已被移除即 fail-closed。
    pub(super) fn insert_gear_couplings(
        &mut self,
        joint_endpoints: &HashMap<String, JointEndpoint>,
        gears: &[DynamicGearConstraintRuntime],
    ) -> Result<(), String> {
        for gear in gears {
            let driver = joint_endpoints
                .get(&gear.driver_joint_id)
                .ok_or_else(|| format!("physics gear {} driver joint missing", gear.id))?;
            let follower = joint_endpoints
                .get(&gear.follower_joint_id)
                .ok_or_else(|| format!("physics gear {} follower joint missing", gear.id))?;
            if driver.revolute != follower.revolute {
                return Err(format!("physics gear {} mixes joint kinds", gear.id));
            }
            // 位置伺服用加速度基模型:增益与从动体惯量解耦(ForceBased 下小惯量轮的
            // 等效 ωn·dt 远超稳定界,与 Web 端同因同修)。
            self.impulse_joints
                .get_mut(follower.handle, false)
                .ok_or("physics gear follower joint vanished")?
                .data
                .set_motor_model(
                    if follower.revolute {
                        JointAxis::AngX
                    } else {
                        JointAxis::LinX
                    },
                    MotorModel::AccelerationBased,
                );
            let initial_translation = self
                .bodies
                .get(driver.model_body)
                .ok_or("physics gear driver body vanished")?
                .translation();
            self.gear_couplings.push(GearCoupling {
                driver_body: driver.model_body,
                follower_joint: follower.handle,
                axis: driver.axis,
                revolute: driver.revolute,
                driver_initial_translation: initial_translation,
                ratio: gear.ratio as f32,
                stiffness: gear.stiffness as f32,
                damping: gear.damping as f32,
                previous_raw: None,
                continuous: 0.0,
            });
        }
        Ok(())
    }
}

/// 凸包退化守卫(与 TS quickhull 同阈值口径):全共线/全共面的点集在
/// rapier 不一定被拒绝(实测共面 4 点会产出退化凸包),这里按
/// 「x 极值 → 距线最远 → 距面最远」三级极值显式拒绝,阈值 = 2×最大绝对坐标×1e-6。
fn ensure_non_degenerate_hull(points: &[Vec3]) -> Result<(), String> {
    if points.len() < 4 {
        return Err("convex hull requires at least 4 points".into());
    }
    let mut max_abs = 0.0f32;
    for point in points {
        for value in [point.x, point.y, point.z] {
            max_abs = max_abs.max(value.abs());
        }
    }
    let epsilon = max_abs * 2.0 * 1e-6;
    let distance = |a: usize, b: usize| (points[a] - points[b]).length();
    let mut i0 = 0;
    let mut i1 = 0;
    for (index, point) in points.iter().enumerate() {
        if point.x < points[i0].x {
            i0 = index;
        }
        if point.x > points[i1].x {
            i1 = index;
        }
    }
    if distance(i0, i1) <= epsilon {
        return Err("convex hull points are degenerate (collinear or zero extent)".into());
    }
    let line_distance = |a: usize, b: usize, p: usize| {
        let u = points[b] - points[a];
        let w = points[p] - points[a];
        let length = u.length();
        if length > 0.0 {
            u.cross(w).length() / length
        } else {
            0.0
        }
    };
    let plane_distance = |a: usize, b: usize, c: usize, p: usize| {
        let u = points[b] - points[a];
        let v = points[c] - points[a];
        let normal = u.cross(v);
        let length = normal.length();
        if length > 0.0 {
            normal.dot(points[p] - points[a]).abs() / length
        } else {
            0.0
        }
    };
    let mut i2 = 0;
    let mut best = -1.0f32;
    for index in 0..points.len() {
        let value = line_distance(i0, i1, index);
        if value > best {
            best = value;
            i2 = index;
        }
    }
    if best <= epsilon {
        return Err("convex hull points are degenerate (collinear)".into());
    }
    let mut best = -1.0f32;
    for index in 0..points.len() {
        let value = plane_distance(i0, i1, i2, index);
        if value > best {
            best = value;
        }
    }
    if best <= epsilon {
        return Err("convex hull points are degenerate (coplanar)".into());
    }
    Ok(())
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
