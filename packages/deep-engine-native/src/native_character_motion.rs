//! T16 切片 1:kinematic 角色的运动状态机与固定步长推进(Native 侧)。
//!
//! 合同(只读规范):`packages/contracts/src/scene.ts` 的
//! `SceneCharacterControllerState`;Web 同语义消费:
//! `apps/web/src/viewer/rapierCharacterController.ts`。
//!
//! 职责边界:
//! - Rapier `KinematicCharacterController::move_shape`(0.35 形状 API)只负责
//!   「期望位移 → 碰撞约束后的可行位移、接地/滑坡判定」;重力、跳跃、落地分级
//!   是宿主职责(Rapier 文档明确不做),由本模块以固定步长 f32 半隐式欧拉积分;
//! - 参数默认值与归一化范围与 Web `normalizeCharacterController` 一致
//!   (Rapier 默认:offset 0.01、坡度 45°、自动台阶关、贴地 0.2);
//! - 确定性协议:全部输入按**固定 tick**采样——平面速度是持续态、跳跃请求是
//!   置位后待消费的一次性标志、根运动增量由宿主在 tick 前排队且只被下一个
//!   tick 消费一次。渲染帧率只决定一次 `advance` 跑多少固定 tick,不改变逐
//!   tick 输入(证明见 `native_character_motion_tests.rs`)。
//!
//! 积分顺序(半隐式欧拉,固定不变):tick 开始读竖直速度 → (接地时)消费跳跃
//! → `v·dt` 进期望位移 → `move_shape` → 写回 kinematic 位姿 → tick 末依
//! 接地结果分级落地/施加重力。同一输入序列逐位复现同一 tick 序列。

use std::collections::VecDeque;

use rapier3d::control::{
    CharacterAutostep, CharacterLength, EffectiveCharacterMovement, KinematicCharacterController,
};
use rapier3d::math::{
    Pose,
    glamx::{Quat, Vec3},
};
use rapier3d::prelude::{QueryPipeline, RigidBody, SharedShape};

use crate::runtime_package::DynamicPhysicsCharacterControllerRuntime;

/// 环形事件历史上限:超出丢弃最旧事件,内存有界;消费方用 [`CharacterMotionState::take_events`] 排空。
const MAX_EVENT_HISTORY: usize = 1024;

/// 「自动上步」事件的最小抬升量(米):低于它的竖直位移视为数值噪声,不入账。
const STEP_EVENT_MIN_RISE_M: f32 = 1.0e-3;

/// 与 Web `RAPIER_CHARACTER_DEFAULTS` 同值的 Rapier 0.35 默认参数(弧度/米)。
pub const CHARACTER_RAPIER_DEFAULT_OFFSET_M: f64 = 0.01;
pub const CHARACTER_RAPIER_DEFAULT_MAX_SLOPE_RAD: f64 = std::f64::consts::FRAC_PI_4;
pub const CHARACTER_RAPIER_DEFAULT_MIN_SLIDE_RAD: f64 = std::f64::consts::FRAC_PI_4;
pub const CHARACTER_RAPIER_DEFAULT_AUTOSTEP_MAX_HEIGHT_M: f64 = 0.3;
pub const CHARACTER_RAPIER_DEFAULT_AUTOSTEP_MIN_WIDTH_M: f64 = 0.2;
pub const CHARACTER_RAPIER_DEFAULT_SNAP_DISTANCE_M: f64 = 0.2;

/// 角色运动参数(状态机全部可调项)。跳跃/重力/落地分级是 T16 新增参数,
/// 合同 `SceneCharacterControllerState` 未覆盖;宿主未显式配置时用这里的默认值。
#[derive(Debug, Clone, PartialEq)]
pub struct CharacterMotionConfig {
    /// 与环境的保持间隙(米);合同 `character.offset`。
    pub offset_m: f64,
    /// 最大可走坡角(弧度);合同 `character.maxSlopeClimbAngle`。
    pub max_slope_climb_angle_rad: f64,
    /// 开始自动下滑的最小坡角(弧度);合同 `character.minSlopeSlideAngle`。
    pub min_slope_slide_angle_rad: f64,
    /// 自动台阶;`None` 表示关闭(合同 `autostep.enabled=false`)。
    pub autostep: Option<CharacterAutostepConfig>,
    /// 贴地吸附;`None` 表示关闭(合同 `snapToGround.enabled=false`)。
    pub snap_to_ground: Option<CharacterSnapToGroundConfig>,
    /// 起跳竖直速度(m/s,向上为正)。
    pub jump_speed_mps: f64,
    /// 角色重力标量(m/s²,沿 -Y)。
    pub gravity_mps2: f64,
    /// 落地冲击分级下限:|落地竖直速度| 低于它为 [`LandingImpact::Light`]。
    pub landing_light_speed_mps: f64,
    /// 落地冲击分级上限:不低于它为 [`LandingImpact::Hard`],之间为 Normal。
    pub landing_hard_speed_mps: f64,
}

/// 自动台阶参数(合同 `character.autostep`)。
#[derive(Debug, Clone, PartialEq)]
pub struct CharacterAutostepConfig {
    /// 可自动跨越的最大台阶高(米)。
    pub max_height_m: f64,
    /// 台阶之后需要的最小可站立宽度(米)。
    pub min_width_m: f64,
    /// 是否也自动跨越 dynamic 刚体。
    pub include_dynamic_bodies: bool,
}

/// 贴地吸附参数(合同 `character.snapToGround`)。
#[derive(Debug, Clone, PartialEq)]
pub struct CharacterSnapToGroundConfig {
    /// 吸附距离(米)。
    pub distance_m: f64,
}

impl Default for CharacterMotionConfig {
    fn default() -> Self {
        Self {
            offset_m: CHARACTER_RAPIER_DEFAULT_OFFSET_M,
            max_slope_climb_angle_rad: CHARACTER_RAPIER_DEFAULT_MAX_SLOPE_RAD,
            min_slope_slide_angle_rad: CHARACTER_RAPIER_DEFAULT_MIN_SLIDE_RAD,
            autostep: None,
            snap_to_ground: Some(CharacterSnapToGroundConfig {
                distance_m: CHARACTER_RAPIER_DEFAULT_SNAP_DISTANCE_M,
            }),
            jump_speed_mps: 5.0,
            gravity_mps2: 9.81,
            landing_light_speed_mps: 3.0,
            landing_hard_speed_mps: 8.0,
        }
    }
}

impl CharacterMotionConfig {
    /// 从运行包角色配置构造,缺省字段回落 Rapier/Web 同款默认。
    /// 运行包解析层(`runtime_package::validate_physics_runtime`)已对数值范围
    /// fail-closed;这里再做一次与 Web 一致的钳制,保证世界构建不炸。
    pub fn from_runtime(character: Option<&DynamicPhysicsCharacterControllerRuntime>) -> Self {
        let source = character;
        let clamp_angle = |value: Option<f64>| -> f64 {
            let raw = value.unwrap_or(CHARACTER_RAPIER_DEFAULT_MAX_SLOPE_RAD);
            raw.clamp(0.0, std::f64::consts::FRAC_PI_2)
        };
        let clamp_length = |value: Option<f64>, fallback: f64| -> f64 {
            let raw = value.unwrap_or(fallback);
            raw.clamp(1.0e-4, 10.0)
        };
        let autostep = source
            .and_then(|character| character.autostep.as_ref())
            .filter(|step| step.enabled);
        let snap = source
            .and_then(|character| character.snap_to_ground.as_ref())
            .filter(|snap| snap.enabled);
        Self {
            offset_m: clamp_length(
                source.and_then(|c| c.offset),
                CHARACTER_RAPIER_DEFAULT_OFFSET_M,
            ),
            max_slope_climb_angle_rad: clamp_angle(source.and_then(|c| c.max_slope_climb_angle)),
            min_slope_slide_angle_rad: source
                .and_then(|c| c.min_slope_slide_angle)
                .map(|raw| raw.clamp(0.0, std::f64::consts::FRAC_PI_2))
                .unwrap_or(CHARACTER_RAPIER_DEFAULT_MIN_SLIDE_RAD),
            autostep: autostep.map(|step| CharacterAutostepConfig {
                max_height_m: clamp_length(
                    step.max_height,
                    CHARACTER_RAPIER_DEFAULT_AUTOSTEP_MAX_HEIGHT_M,
                ),
                min_width_m: clamp_length(
                    step.min_width,
                    CHARACTER_RAPIER_DEFAULT_AUTOSTEP_MIN_WIDTH_M,
                ),
                include_dynamic_bodies: step.include_dynamic_bodies.unwrap_or(false),
            }),
            snap_to_ground: snap.map(|snap| CharacterSnapToGroundConfig {
                distance_m: snap
                    .distance
                    .map(|raw| raw.clamp(1.0e-4, 10.0))
                    .unwrap_or(CHARACTER_RAPIER_DEFAULT_SNAP_DISTANCE_M),
            }),
            ..Self::default()
        }
    }

    fn to_rapier_controller(&self) -> KinematicCharacterController {
        KinematicCharacterController {
            up: Vec3::Y,
            offset: CharacterLength::Absolute(self.offset_m as f32),
            slide: true,
            autostep: self.autostep.as_ref().map(|step| CharacterAutostep {
                max_height: CharacterLength::Absolute(step.max_height_m as f32),
                min_width: CharacterLength::Absolute(step.min_width_m as f32),
                include_dynamic_bodies: step.include_dynamic_bodies,
            }),
            max_slope_climb_angle: self.max_slope_climb_angle_rad as f32,
            min_slope_slide_angle: self.min_slope_slide_angle_rad as f32,
            snap_to_ground: self
                .snap_to_ground
                .as_ref()
                .map(|snap| CharacterLength::Absolute(snap.distance_m as f32)),
            ..KinematicCharacterController::default()
        }
    }
}

/// 运动阶段(坡度/台阶/跳跃/落地的状态判定出口)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CharacterMotionPhase {
    /// 站立且未在下滑:坡角 ≤ min_slide。
    Grounded,
    /// 站在超过 min_slide 的坡上,滑行位移由 Rapier slide 计算给出。
    SlidingDownSlope,
    /// 离地(跳跃/走落台缘):竖直速度被宿主积分。
    Airborne,
}

/// 落地冲击分级(下落速度分级:T16 状态机落地判定出口)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LandingImpact {
    /// |冲击速度| < landing_light_speed。
    Light,
    /// 介于 light 与 hard 之间。
    Normal,
    /// |冲击速度| ≥ landing_hard_speed。
    Hard,
}

/// 一次阶段跃迁事件(golden 轨迹的观测点)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CharacterMotionEventKind {
    /// 接地状态消费了跳跃请求。
    Jumped,
    /// 自动台阶抬升(期望位移无竖直分量而实际被抬升)。`height_m` 为本次抬升量。
    SteppedUp { height_m: f32 },
    /// 落地。`impact_speed_mps` 为触地前竖直速度绝对值。
    Landed {
        impact_speed_mps: f32,
        impact: LandingImpact,
    },
}

/// 带固定 tick 序号的事件。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CharacterMotionEvent {
    pub tick: u64,
    pub kind: CharacterMotionEventKind,
}

/// 单个角色的运动状态(逐固定 tick 演进)。
#[derive(Debug, Clone)]
pub struct CharacterMotionState {
    pub phase: CharacterMotionPhase,
    /// 竖直速度(m/s);接地时恒 0,滞空由宿主按 -gravity 积分。
    vertical_velocity_mps: f32,
    /// 滞空期间缓冲的跳跃请求(落地后的第一个接地 tick 消费)。
    jump_buffered: bool,
    events: VecDeque<CharacterMotionEvent>,
}

impl Default for CharacterMotionState {
    fn default() -> Self {
        Self {
            phase: CharacterMotionPhase::Grounded,
            vertical_velocity_mps: 0.0,
            jump_buffered: false,
            events: VecDeque::new(),
        }
    }
}

impl CharacterMotionState {
    pub fn vertical_velocity_mps(&self) -> f32 {
        self.vertical_velocity_mps
    }

    pub fn events(&self) -> impl Iterator<Item = &CharacterMotionEvent> {
        self.events.iter()
    }

    /// 排空事件历史(确定性顺序:发生序)。
    pub fn take_events(&mut self) -> std::vec::IntoIter<CharacterMotionEvent> {
        self.events.drain(..).collect::<Vec<_>>().into_iter()
    }

    fn push_event(&mut self, tick: u64, kind: CharacterMotionEventKind) {
        if self.events.len() == MAX_EVENT_HISTORY {
            self.events.pop_front();
        }
        self.events.push_back(CharacterMotionEvent { tick, kind });
    }

    fn landing_impact(
        &self,
        config: &CharacterMotionConfig,
        impact_speed_mps: f32,
    ) -> LandingImpact {
        let impact = impact_speed_mps as f64;
        if impact >= config.landing_hard_speed_mps {
            LandingImpact::Hard
        } else if impact >= config.landing_light_speed_mps {
            LandingImpact::Normal
        } else {
            LandingImpact::Light
        }
    }
}

/// 一个固定 tick 的角色输入(全部按固定 tick 采样,见模块文档的确定性协议)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CharacterTickInput {
    /// 根运动世界系平移增量(米):动画根运动自上一固定 tick 的累计值。
    pub root_translation: [f64; 3],
    /// 根运动世界系旋转增量 (x, y, z, w):`qPrev⁻¹ ⊗ qCurrent`,恒等用 `[0,0,0,1]`。
    pub root_rotation: [f64; 4],
    /// 显式平面速度(m/s,世界 XZ):宿主持续态,AI/导航/用户输入叠加用。
    pub planar_velocity_mps: [f64; 2],
    /// 跳跃请求:置位后保留至被接地 tick 消费(一次)。
    pub jump_requested: bool,
}

impl Default for CharacterTickInput {
    fn default() -> Self {
        Self {
            root_translation: [0.0; 3],
            root_rotation: [0.0, 0.0, 0.0, 1.0],
            planar_velocity_mps: [0.0; 2],
            jump_requested: false,
        }
    }
}

/// 一个固定 tick 的角色推进输出(观测用;事件经状态环形历史由宿主排空)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CharacterTickOutput {
    /// `move_shape` 实际允许的世界系位移。
    pub applied_translation: [f32; 3],
    /// 推进后是否接地。
    pub grounded: bool,
    /// 推进后是否处于下坡滑行。
    pub sliding: bool,
}

/// [`CharacterDriver::begin_tick`] 的中间产物:`solve` 与 `finish_tick` 的输入。
#[derive(Debug, Clone, Copy)]
pub struct CharacterTickPlan {
    /// tick 开始时的角色位姿(move_shape 的形状位姿基准)。
    pub pose: Pose,
    /// 本次 tick 的输入(已从驱动器队列消费)。
    pub input: CharacterTickInput,
    /// 期望世界系位移(根运动 + 平面速度·dt + 竖直速度·dt)。
    pub desired: Vec3,
}

impl CharacterDriver {
    /// 阶段 1:消费待入队输入、消费/缓冲跳跃、求期望位移。与
    /// `RigidBodySet` 无借用耦合,宿主可与读角色位姿同循环完成。
    pub fn begin_tick(&mut self, position: Pose, dt: f32, tick: u64) -> CharacterTickPlan {
        let input = CharacterTickInput {
            root_translation: self.pending_root_translation,
            root_rotation: self.pending_root_rotation,
            planar_velocity_mps: self.planar_velocity_mps,
            jump_requested: self.jump_requested,
        };
        self.pending_root_translation = [0.0; 3];
        self.pending_root_rotation = [0.0, 0.0, 0.0, 1.0];
        self.jump_requested = false;

        // 跳跃请求:接地/滑坡即消费;滞空则缓冲到落地后的第一个接地 tick。
        let grounded_like = matches!(
            self.motion.phase,
            CharacterMotionPhase::Grounded | CharacterMotionPhase::SlidingDownSlope
        );
        if input.jump_requested {
            if grounded_like {
                self.motion.vertical_velocity_mps = self.config.jump_speed_mps as f32;
                self.motion.phase = CharacterMotionPhase::Airborne;
                self.motion.jump_buffered = false;
                self.motion
                    .push_event(tick, CharacterMotionEventKind::Jumped);
            } else {
                self.motion.jump_buffered = true;
            }
        }

        // 期望位移(f64 混合后转 f32;dt 恒为固定步长)。
        let vertical_velocity = self.motion.vertical_velocity_mps;
        let desired = Vec3::new(
            (input.root_translation[0] + input.planar_velocity_mps[0] * dt as f64) as f32,
            input.root_translation[1] as f32
                + if self.motion.phase == CharacterMotionPhase::Airborne {
                    vertical_velocity * dt
                } else {
                    0.0
                },
            (input.root_translation[2] + input.planar_velocity_mps[1] * dt as f64) as f32,
        );
        CharacterTickPlan {
            pose: position,
            input,
            desired,
        }
    }

    /// 阶段 2:纯 Rapier `move_shape` 世界查询,给出碰撞约束后的可行位移与
    /// 接地/滑坡判定;不改角色状态,不借角色可变引用。查询由宿主构造
    /// (排除角色自身刚体,见 `native_physics::advance`)。
    pub fn solve(
        &self,
        query: &QueryPipeline,
        plan: &CharacterTickPlan,
        dt: f32,
    ) -> EffectiveCharacterMovement {
        self.controller.move_shape(
            dt,
            query,
            self.shape.as_ref(),
            &plan.pose,
            plan.desired,
            |_| {},
        )
    }

    /// 阶段 3:写回 kinematic 位姿并演进状态机(落地分级/台阶事件/滑坡/重力积分)。
    /// 半隐式欧拉:位置用 tick 初速度,速度在 tick 末更新;顺序固定保证逐位复现。
    /// 接地法线探针:从角色中心向下射线,返回首个命中面的世界法线。
    /// 引擎 `is_sliding_down_slope` 在纯水平移动时也会置位(把沿面滑动都算作
    /// slide),不能直接当「站在陡坡上」的语义;坡角必须来自真实的地面法线。
    pub fn probe_ground_normal(&self, query: &QueryPipeline, pose: &Pose) -> Option<Vec3> {
        let ray = rapier3d::geometry::Ray::new(pose.translation, Vec3::new(0.0, -1.0, 0.0));
        query
            .cast_ray_and_get_normal(&ray, self.half_height_m + 1.0, true)
            .map(|(_, intersection)| intersection.normal)
    }

    pub fn finish_tick(
        &mut self,
        body: &mut RigidBody,
        plan: &CharacterTickPlan,
        movement: &EffectiveCharacterMovement,
        ground_normal: Option<Vec3>,
        dt: f32,
        tick: u64,
    ) -> CharacterTickOutput {
        let position = plan.pose;
        let config = &self.config;
        let state = &mut self.motion;

        // 写回 kinematic 位姿:平移取约束结果,旋转按根运动增量(世界系前乘)合成。
        let translation = position.translation + movement.translation;
        body.set_next_kinematic_translation(translation);
        let rotation_delta = Quat::from_xyzw(
            plan.input.root_rotation[0] as f32,
            plan.input.root_rotation[1] as f32,
            plan.input.root_rotation[2] as f32,
            plan.input.root_rotation[3] as f32,
        )
        .normalize();
        body.set_next_kinematic_rotation(rotation_delta * position.rotation);

        let vertical_velocity = state.vertical_velocity_mps;
        if movement.grounded {
            if state.phase == CharacterMotionPhase::Airborne {
                let impact = state.landing_impact(config, vertical_velocity.abs());
                state.push_event(
                    tick,
                    CharacterMotionEventKind::Landed {
                        impact_speed_mps: vertical_velocity.abs(),
                        impact,
                    },
                );
            } else if plan.desired.y.abs() < f32::EPSILON
                && movement.translation.y > STEP_EVENT_MIN_RISE_M
            {
                // 自动台阶:期望无竖直分量而被抬升;根运动自带的竖直分量不算台阶。
                state.push_event(
                    tick,
                    CharacterMotionEventKind::SteppedUp {
                        height_m: movement.translation.y,
                    },
                );
            }
            // 坡度状态:接地法线与 up 的夹角 ≥ min_slope_slide → 下坡滑行;
            // 无探针命中(罕见,如悬空贴合)回落引擎滑动标志,不虚构接地坡度。
            let slope_rad = ground_normal.map(|normal| {
                normal
                    .normalize_or_zero()
                    .dot(Vec3::Y)
                    .clamp(-1.0, 1.0)
                    .acos()
            });
            state.phase = if slope_rad
                .is_some_and(|slope| slope >= config.min_slope_slide_angle_rad as f32)
                || (slope_rad.is_none() && movement.is_sliding_down_slope)
            {
                CharacterMotionPhase::SlidingDownSlope
            } else {
                CharacterMotionPhase::Grounded
            };
            state.vertical_velocity_mps = 0.0;
            // 落地即消费缓冲的跳跃(与直接起跳同 tick 语义:位移吃满起跳速度)。
            if state.jump_buffered {
                state.jump_buffered = false;
                state.vertical_velocity_mps = config.jump_speed_mps as f32;
                state.phase = CharacterMotionPhase::Airborne;
                state.push_event(tick, CharacterMotionEventKind::Jumped);
            }
        } else if state.phase != CharacterMotionPhase::Airborne {
            // 走落台缘:无事件进入滞空;竖直速度保持离地值,交给 tick 末重力。
            state.phase = CharacterMotionPhase::Airborne;
        }
        // tick 末:滞空一律按 -gravity 积分(含起跳 tick;顺序固定保证逐位复现)。
        if state.phase == CharacterMotionPhase::Airborne {
            state.vertical_velocity_mps -= config.gravity_mps2 as f32 * dt;
        }

        CharacterTickOutput {
            applied_translation: movement.translation.to_array(),
            grounded: movement.grounded,
            sliding: movement.is_sliding_down_slope,
        }
    }
}

/// 供物理宿主构造的每角色运行时片段(控制器 + 形状 + 状态 + 待消费输入)。
///
/// 固定 tick 的推进拆成三段(`native_physics::advance` 的调用序):
/// 1. [`Self::begin_tick`]——消费待入队输入并求期望位移;
/// 2. [`Self::solve`]——纯 Rapier 世界查询(宿主构造排除角色自身刚体的查询);
/// 3. [`Self::finish_tick`]——写回 kinematic 位姿并演进状态机。
///
/// 三段合起来才是一个 tick;顺序固定保证同一输入序列逐位复现。
#[derive(Debug, Clone)]
pub struct CharacterDriver {
    pub controller: KinematicCharacterController,
    pub shape: SharedShape,
    pub config: CharacterMotionConfig,
    /// 角色形状总高(米):接地法线探针的射程基准。
    pub half_height_m: f32,
    pub motion: CharacterMotionState,
    /// 待消费根运动:排队累加,被下一个固定 tick 一次性消费。
    pub pending_root_translation: [f64; 3],
    pub pending_root_rotation: [f64; 4],
    /// 平面速度持续态(m/s,世界 XZ),每个固定 tick 采样。
    pub planar_velocity_mps: [f64; 2],
    /// 跳跃请求(置位后保留至接地 tick 消费)。
    pub jump_requested: bool,
}

impl CharacterDriver {
    pub fn new(shape: SharedShape, config: CharacterMotionConfig, half_height_m: f32) -> Self {
        Self {
            controller: config.to_rapier_controller(),
            shape,
            config,
            half_height_m,
            motion: CharacterMotionState::default(),
            pending_root_translation: [0.0; 3],
            pending_root_rotation: [0.0, 0.0, 0.0, 1.0],
            planar_velocity_mps: [0.0; 2],
            jump_requested: false,
        }
    }

    /// 排队一批根运动增量:平移累加,旋转按世界系前乘复合(多次排队等价一次)。
    pub fn queue_root_motion(&mut self, translation: [f64; 3], rotation: [f64; 4]) {
        self.pending_root_translation = [
            self.pending_root_translation[0] + translation[0],
            self.pending_root_translation[1] + translation[1],
            self.pending_root_translation[2] + translation[2],
        ];
        let pending = Quat::from_xyzw(
            self.pending_root_rotation[0] as f32,
            self.pending_root_rotation[1] as f32,
            self.pending_root_rotation[2] as f32,
            self.pending_root_rotation[3] as f32,
        );
        let incoming = Quat::from_xyzw(
            rotation[0] as f32,
            rotation[1] as f32,
            rotation[2] as f32,
            rotation[3] as f32,
        );
        let composed = (incoming.normalize() * pending.normalize()).normalize();
        let [x, y, z, w] = composed.to_array();
        self.pending_root_rotation = [x as f64, y as f64, z as f64, w as f64];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_match_rapier_and_web_defaults() {
        let config = CharacterMotionConfig::default();
        assert_eq!(config.offset_m, 0.01);
        assert_eq!(
            config.max_slope_climb_angle_rad,
            std::f64::consts::FRAC_PI_4
        );
        assert_eq!(
            config.min_slope_slide_angle_rad,
            std::f64::consts::FRAC_PI_4
        );
        assert_eq!(config.autostep, None);
        assert_eq!(
            config.snap_to_ground,
            Some(CharacterSnapToGroundConfig { distance_m: 0.2 })
        );
        assert_eq!(config.jump_speed_mps, 5.0);
        assert_eq!(config.gravity_mps2, 9.81);
        assert_eq!(config.landing_light_speed_mps, 3.0);
        assert_eq!(config.landing_hard_speed_mps, 8.0);
    }

    #[test]
    fn config_from_runtime_maps_contract_fields_and_clamps() {
        let character = serde_json::from_value::<DynamicPhysicsCharacterControllerRuntime>(
            serde_json::json!({
                "offset": 0.02,
                "maxSlopeClimbAngle": 0.7,
                "minSlopeSlideAngle": 0.5,
                "autostep": {"enabled": true, "maxHeight": 0.3, "minWidth": 0.2, "includeDynamicBodies": false},
                "snapToGround": {"enabled": true, "distance": 0.25}
            }),
        )
        .unwrap();
        let config = CharacterMotionConfig::from_runtime(Some(&character));
        assert_eq!(config.offset_m, 0.02);
        assert_eq!(config.max_slope_climb_angle_rad, 0.7);
        assert_eq!(config.min_slope_slide_angle_rad, 0.5);
        assert_eq!(
            config.autostep,
            Some(CharacterAutostepConfig {
                max_height_m: 0.3,
                min_width_m: 0.2,
                include_dynamic_bodies: false,
            })
        );
        assert_eq!(
            config.snap_to_ground,
            Some(CharacterSnapToGroundConfig { distance_m: 0.25 })
        );
        // 越界值钳回合同区间(与 Web normalizeCharacterController 一致)。
        let wild =
            serde_json::from_value::<DynamicPhysicsCharacterControllerRuntime>(serde_json::json!({
                "offset": 100.0,
                "maxSlopeClimbAngle": 9.0,
                "autostep": {"enabled": false},
                "snapToGround": {"enabled": false}
            }))
            .unwrap();
        let config = CharacterMotionConfig::from_runtime(Some(&wild));
        assert_eq!(config.offset_m, 10.0);
        assert_eq!(
            config.max_slope_climb_angle_rad,
            std::f64::consts::FRAC_PI_2
        );
        assert_eq!(config.autostep, None);
        assert_eq!(config.snap_to_ground, None);
        // 合同缺省:字段级回落与 Web normalizeCharacterController 同语义——
        // 贴地省略 = 关闭(Web 端对 omitted 字段不调用 enableSnapToGround);
        // 与 Rapier 结构默认(贴地 0.2)的差异是刻意的跨端一致性选择。
        let config = CharacterMotionConfig::from_runtime(None);
        assert_eq!(config.autostep, None);
        assert_eq!(config.snap_to_ground, None);
        assert_eq!(
            config.max_slope_climb_angle_rad,
            CHARACTER_RAPIER_DEFAULT_MAX_SLOPE_RAD
        );
        assert_eq!(config.offset_m, CHARACTER_RAPIER_DEFAULT_OFFSET_M);
        assert_eq!(config.jump_speed_mps, 5.0);
        assert_eq!(config.gravity_mps2, 9.81);
    }

    #[test]
    fn landing_impact_grades_by_configured_speeds() {
        let state = CharacterMotionState::default();
        let config = CharacterMotionConfig::default();
        assert_eq!(state.landing_impact(&config, 1.5), LandingImpact::Light);
        assert_eq!(state.landing_impact(&config, 3.0), LandingImpact::Normal);
        assert_eq!(state.landing_impact(&config, 7.9), LandingImpact::Normal);
        assert_eq!(state.landing_impact(&config, 8.0), LandingImpact::Hard);
        assert_eq!(state.landing_impact(&config, 20.0), LandingImpact::Hard);
    }

    #[test]
    fn queued_root_motion_accumulates_translation_and_composes_rotation() {
        let mut driver = CharacterDriver::new(
            SharedShape::cuboid(0.25, 0.5, 0.25),
            CharacterMotionConfig::default(),
            1.0,
        );
        driver.queue_root_motion([1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]);
        driver.queue_root_motion([0.5, 0.25, 0.0], [0.0, 0.0, 0.38268343, 0.92387953]);
        assert_eq!(driver.pending_root_translation, [1.5, 0.25, 0.0]);
        let rotation = driver.pending_root_rotation;
        let angle = 2.0 * rotation[3].acos();
        assert!((angle - std::f64::consts::FRAC_PI_4).abs() < 1.0e-6);
        assert!(rotation[2] > 0.0 && rotation[0].abs() < 1.0e-6 && rotation[1].abs() < 1.0e-6);
    }

    #[test]
    fn event_history_is_bounded() {
        let mut state = CharacterMotionState::default();
        for tick in 0..(MAX_EVENT_HISTORY + 64) {
            state.push_event(tick as u64, CharacterMotionEventKind::Jumped);
        }
        assert_eq!(state.events.len(), MAX_EVENT_HISTORY);
        assert_eq!(state.events.front().unwrap().tick, 64);
        assert_eq!(state.take_events().len(), MAX_EVENT_HISTORY);
        assert_eq!(state.take_events().len(), 0);
    }
}
