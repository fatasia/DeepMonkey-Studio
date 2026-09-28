use std::collections::HashMap;

use rapier3d::{
    control::EffectiveCharacterMovement,
    math::{
        Pose,
        glamx::{Mat4, Quat, Vec3},
    },
    prelude::*,
};

use crate::{
    contract::RenderPacket,
    native_character_motion::{
        CharacterDriver, CharacterMotionConfig, CharacterMotionEvent, CharacterMotionPhase,
        CharacterTickPlan,
    },
    runtime_package::{
        DynamicPhysicsBodyRuntime, DynamicPhysicsCommand, DynamicPhysicsJointRuntime,
        DynamicSceneRuntime,
    },
};

#[cfg(test)]
#[path = "native_physics_ccd_tests.rs"]
mod ccd_tests;

#[cfg(test)]
#[path = "native_physics_golden_tests.rs"]
mod golden_tests;

#[cfg(test)]
#[path = "native_physics_mechanism_golden_tests.rs"]
mod mechanism_golden_tests;

#[cfg(test)]
#[path = "native_physics_collider_tests.rs"]
mod collider_tests;

const FIXED_TIMESTEP_SECONDS: f64 = 1.0 / 60.0;
const MAX_CATCH_UP_SECONDS: f64 = 0.2;

struct BodyBinding {
    /// 所属运行包刚体 ID(角色输入 API 的寻址键)。
    body_id: String,
    handle: RigidBodyHandle,
    dynamic: bool,
    instances: Vec<(String, Mat4)>,
    /// T16:角色驱动器;仅 `character` 配置齐全的 kinematic 刚体持有。
    character: Option<CharacterDriver>,
}

/// Transactionally constructed Rapier product host. `new` builds every body,
/// collider and joint before the caller publishes it into live PlayerContent.
pub struct NativePhysicsHost {
    playing: bool,
    accumulator: f64,
    fixed_step_count: u64,
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
    /// T16:角色世界查询专用 BVH(与 pipeline 的 broad_phase 完全独立)。
    /// `BroadPhaseBvh::update` 的 pair 事件只允许被 pipeline 消费一次:若在
    /// 构造期预填充 pipeline 的 BVH,dynamic-static 接触对事件会被吞掉,
    /// dynamic 刚体将穿透静态场景(T17 stack golden 回归证实)。查询 BVH
    /// 的 pair 事件无消费者,丢弃是安全的;仅存在角色时才逐 tick 重建。
    query_broad_phase: BroadPhaseBvh,
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
            fixed_step_count: 0,
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
            query_broad_phase: BroadPhaseBvh::new(),
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
            self.step_fixed_tick();
            self.accumulator -= FIXED_TIMESTEP_SECONDS;
            self.fixed_step_count = self.fixed_step_count.saturating_add(1);
            steps += 1;
        }
        if steps == 0 {
            return Ok(0);
        }
        self.sync_packet(packet)
    }

    /// 恰好推进 `ticks` 个固定 tick(1/60 s):确定性驱动的规范入口。
    /// 渲染帧只应经 `advance`(累加器)间接到达这里;golden/回放消费方
    /// 直接用它,与 T19 `advance_ticks` 的量化协议同型。
    pub fn advance_fixed_ticks(
        &mut self,
        ticks: usize,
        packet: &mut RenderPacket,
    ) -> Result<usize, String> {
        if !self.playing {
            return Ok(0);
        }
        for _ in 0..ticks {
            self.step_fixed_tick();
            self.fixed_step_count = self.fixed_step_count.saturating_add(1);
        }
        if ticks == 0 {
            return Ok(0);
        }
        self.sync_packet(packet)
    }

    /// 一个固定 tick(1/60 s)的完整推进。角色三段序(begin→solve→finish)
    /// 必须在 `pipeline.step` 之前完成,kinematic 下一目标位姿才会随本步提交。
    fn step_fixed_tick(&mut self) {
        let dt = FIXED_TIMESTEP_SECONDS as f32;
        let tick = self.fixed_step_count.saturating_add(1);

        // 阶段 1:消费角色输入并求期望位移(借 bindings + bodies 可变引用)。
        let mut plans: Vec<(usize, CharacterTickPlan)> = Vec::new();
        for (index, binding) in self.bindings.iter_mut().enumerate() {
            let Some(character) = &mut binding.character else {
                continue;
            };
            let Some(body) = self.bodies.get_mut(binding.handle) else {
                continue;
            };
            let plan = character.begin_tick(*body.position(), dt, tick);
            plans.push((index, plan));
        }

        // 阶段 2:纯世界查询(不可变借 bodies/colliders;排除角色自身刚体)。
        // 查询 BVH 以全量碰撞体重建(存在角色时才有成本;pair 事件丢弃安全);
        // 纯 dynamic 场景不建 BVH,pipeline 行为与 T17 基线完全一致。
        let mut movements: Vec<EffectiveCharacterMovement> = Vec::with_capacity(plans.len());
        if !plans.is_empty() {
            let modified: Vec<ColliderHandle> =
                self.colliders.iter().map(|(handle, _)| handle).collect();
            let mut query_pair_events = Vec::new();
            self.query_broad_phase.update(
                &self.integration,
                &self.colliders,
                &self.bodies,
                &modified,
                &[],
                &mut query_pair_events,
            );
        }
        let mut ground_normals: Vec<Option<Vec3>> = Vec::with_capacity(plans.len());
        let mut plan_iter = plans.iter();
        for binding in self.bindings.iter() {
            let Some(character) = &binding.character else {
                continue;
            };
            let Some((_, plan)) = plan_iter.next() else {
                break;
            };
            let query = self.query_broad_phase.as_query_pipeline(
                self.narrow_phase.query_dispatcher(),
                &self.bodies,
                &self.colliders,
                QueryFilter::default().exclude_rigid_body(binding.handle),
            );
            movements.push(character.solve(&query, plan, dt));
            // 接地法线探针:与 move_shape 同一查询面(排除角色自身),仅接地时有意义。
            ground_normals.push(if movements.last().is_some_and(|m| m.grounded) {
                character.probe_ground_normal(&query, &plan.pose)
            } else {
                None
            });
        }

        // 阶段 3:写回 kinematic 位姿并演进状态机(plans 与 movements 都按
        // 角色在 bindings 中的出现序构建,游标对齐即一一配对)。
        let mut cursor = 0usize;
        for (binding_index, binding) in self.bindings.iter_mut().enumerate() {
            let Some(character) = &mut binding.character else {
                continue;
            };
            let Some(body) = self.bodies.get_mut(binding.handle) else {
                continue;
            };
            if cursor >= plans.len() || plans[cursor].0 != binding_index {
                continue;
            }
            let (_, plan) = plans[cursor];
            let movement = &movements[cursor];
            let ground_normal = ground_normals[cursor];
            cursor += 1;
            character.finish_tick(body, &plan, &movement, ground_normal, dt, tick);
        }

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
    }

    /// Read only a physics-owned instance from the packet committed by the last step.
    pub fn instance_pose(
        &self,
        packet: &RenderPacket,
        instance_id: &str,
    ) -> Option<(u64, [f32; 3])> {
        self.bindings
            .iter()
            .any(|binding| {
                (binding.dynamic || binding.character.is_some())
                    && binding.instances.iter().any(|(id, _)| id == instance_id)
            })
            .then(|| {
                packet
                    .instances
                    .iter()
                    .find(|instance| instance.id == instance_id)
                    .map(|instance| {
                        (
                            self.fixed_step_count,
                            [
                                instance.transform[12],
                                instance.transform[13],
                                instance.transform[14],
                            ],
                        )
                    })
            })
            .flatten()
    }

    /// 当前已推进的固定 tick 数(T16 确定性驱动的 tick 观测口)。
    pub fn fixed_step_count(&self) -> u64 {
        self.fixed_step_count
    }

    /// 只读射线查询(T17 collider golden 与拾取消费):返回最近命中刚体的
    /// (body_id, toi, 世界法线)。方向会在内部归一化;不推进模拟、不写任何状态。
    /// `max_toi` 为射线参数上限(方向归一化后即米)。
    /// 实现直接遍历 collider 集合求交,而非 broad-phase BVH:broad-phase 的
    /// 变更标志被 `pipeline.step` 消费后,新建 BVH 的 `update` 会跳过全部
    /// collider(树为空 → 查询恒空)。O(n) 遍历与步进时序无关,行为恒定。
    pub fn cast_ray(
        &self,
        origin: [f32; 3],
        direction: [f32; 3],
        max_toi: f32,
    ) -> Option<(String, f32, [f32; 3])> {
        let direction = Vec3::from_array(direction);
        if !direction.is_finite() || direction.length_squared() <= 1e-12 {
            return None;
        }
        let ray = Ray::new(Vec3::from_array(origin), direction.normalize());
        let mut best: Option<(ColliderHandle, RayIntersection)> = None;
        for (handle, collider) in self.colliders.iter() {
            if !collider.is_enabled() {
                continue;
            }
            let hit =
                collider
                    .shape()
                    .cast_ray_and_get_normal(collider.position(), &ray, max_toi, true);
            if let Some(hit) = hit {
                if best
                    .as_ref()
                    .is_none_or(|(_, previous)| hit.time_of_impact < previous.time_of_impact)
                {
                    best = Some((handle, hit));
                }
            }
        }
        let (collider_handle, hit) = best?;
        let parent = self.colliders.get(collider_handle)?.parent()?;
        let binding = self
            .bindings
            .iter()
            .find(|candidate| candidate.handle == parent)?;
        Some((
            binding.body_id.clone(),
            hit.time_of_impact,
            [hit.normal.x, hit.normal.y, hit.normal.z],
        ))
    }

    /// 设置角色平面速度持续态(m/s,世界 XZ);每个固定 tick 采样直到再次设置。
    /// 返回是否命中带角色驱动器的 kinematic 刚体。
    pub fn set_character_planar_velocity(&mut self, body_id: &str, velocity_mps: [f64; 2]) -> bool {
        let Some(character) = self.character_driver_mut(body_id) else {
            return false;
        };
        character.planar_velocity_mps = velocity_mps;
        true
    }

    /// 排队一批根运动增量(米 / (x,y,z,w) 四元数):累加后由下一个固定 tick
    /// 一次性消费。多次排队先复合再消费;消费后的 tick 不再重复应用。
    /// 返回是否命中带角色驱动器的 kinematic 刚体。
    pub fn queue_character_root_motion(
        &mut self,
        body_id: &str,
        translation: [f64; 3],
        rotation: [f64; 4],
    ) -> bool {
        let Some(character) = self.character_driver_mut(body_id) else {
            return false;
        };
        character.queue_root_motion(translation, rotation);
        true
    }

    /// 请求角色跳跃:置位后由第一个接地的固定 tick 消费(滞空期缓冲)。
    /// 返回是否命中带角色驱动器的 kinematic 刚体。
    pub fn request_character_jump(&mut self, body_id: &str) -> bool {
        let Some(character) = self.character_driver_mut(body_id) else {
            return false;
        };
        character.jump_requested = true;
        true
    }

    /// 读取角色当前运动阶段(坡度/台阶/跳跃/落地状态机的观测口)。
    pub fn character_phase(&self, body_id: &str) -> Option<CharacterMotionPhase> {
        self.bindings
            .iter()
            .find(|binding| binding.body_id == body_id)?
            .character
            .as_ref()
            .map(|character| character.motion.phase)
    }

    /// 排空全部角色的阶段跃迁事件(遍历序 = bindings 序 = 构造时的稳定序)。
    pub fn drain_character_events(&mut self) -> Vec<(String, CharacterMotionEvent)> {
        let mut events = Vec::new();
        for binding in &mut self.bindings {
            let Some(character) = &mut binding.character else {
                continue;
            };
            for event in character.motion.take_events() {
                events.push((binding.body_id.clone(), event));
            }
        }
        events
    }

    fn character_driver_mut(&mut self, body_id: &str) -> Option<&mut CharacterDriver> {
        self.bindings
            .iter_mut()
            .find(|binding| binding.body_id == body_id)?
            .character
            .as_mut()
    }

    fn insert_body(
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
        // revolute(弧度)与 prismatic(米)共享锚点/限位/速度马达语义;multibody 解析层已限 revolute。
        let prismatic = joint.kind == "prismatic";
        let axis = if prismatic {
            JointAxis::LinX
        } else {
            JointAxis::AngX
        };
        let mut descriptor: GenericJoint = if prismatic {
            PrismaticJointBuilder::new(vec3(joint.axis)?)
                .local_anchor1(parent_anchor)
                .local_anchor2(vec3(joint.local_anchor)?)
                .build()
                .into()
        } else {
            RevoluteJointBuilder::new(vec3(joint.axis)?)
                .local_anchor1(parent_anchor)
                .local_anchor2(vec3(joint.local_anchor)?)
                .build()
                .into()
        };
        if joint.limits.enabled {
            descriptor.set_limits(axis, [joint.limits.min as f32, joint.limits.max as f32]);
        }
        if joint.motor.enabled {
            descriptor.set_motor_model(axis, MotorModel::ForceBased);
            descriptor.set_motor_velocity(
                axis,
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
            if !binding.dynamic && binding.character.is_none() {
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
                let next = (world * *local).to_cols_array();
                // dynamic 刚体每步必然变化;角色驱动刚体仅在实际位移时计入 changed,
                // 零输入 tick 保持 advance 返回 0(与 kinematic 静置合同一致)。
                if binding.dynamic || instance.transform != next {
                    instance.transform = next;
                    changed += 1;
                }
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
    fn kinematic_body_without_character_config_stays_put() {
        // 无 character 配置的 kinematic 刚体保持「宿主显式设位姿」合同:宿主不
        // 动它就一步不动。带 character 配置的角色由重力/输入驱动,行为见
        // native_character_motion_tests.rs。
        let mut value = runtime_value("instance-a");
        value["physics"]["bodies"] = serde_json::json!([{
            "id":"body-a","type":"kinematic","initialPose":{"translation":[0,2,0],"rotation":[0,0,0,1]},"mass":2,"friction":0.5,"restitution":0.1,
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
        assert_eq!(host.character_phase("body-a"), None);
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
