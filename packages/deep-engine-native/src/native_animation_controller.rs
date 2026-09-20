use std::collections::HashMap;

use crate::runtime_package::{
    DynamicAnimationControllerCommand, DynamicAnimationControllerRuntime, DynamicSceneRuntime,
};

/// R11 动画状态机产品宿主(Native 侧)。与 Web 消费方
/// `apps/web/src/delivery/dynamicAnimationControllerPlayback.ts` 的
/// `DynamicAnimationControllerPlayer` 一一同构:
/// - 构造即取包内持久 `activeStateId` 与持久参数;
/// - `start` 播放活动态 clip(produce PlayClip 命令);
/// - `evaluate` 按声明顺序解析至多一条满足条件的转场边;
/// - `set_parameter` 只接受已声明的参数(未知参数 fail-closed 返回 false)。
///
/// 包 ABI(v2/v3)只携带 `modelId`/`clipId` 引用,不携带 clip 关键帧轨道
/// (clip 采样数据仍只在导入模型里)。因此 Native 宿主的可交付部分是
/// 确定性命令轨迹与活动态推进;时间线 TRS 通道由既有
/// `apply_dynamic_playback_step` 逐帧采样,与状态机并行共存(同 Web 行为)。
#[derive(Debug, Clone, PartialEq)]
pub enum NativeAnimationControllerCommand {
    /// Start of the package-authored active clip. Fields mirror the Web sink
    /// call `playClip(modelId, clipId, loop)`.
    PlayClip {
        state_id: String,
        model_id: String,
        clip_id: String,
        r#loop: bool,
    },
    /// One applied transition. Fields mirror the Web sink call
    /// `transitionClip({ modelId, fromClipId, toClipId, durationMs, loop })`
    /// plus the resolved edge identity.
    TransitionClip {
        transition_id: String,
        model_id: String,
        from_clip_id: String,
        to_clip_id: String,
        duration_ms: u64,
        r#loop: bool,
        next_state_id: String,
    },
}

impl NativeAnimationControllerCommand {
    /// Canonical cross-end comparison key: same fields the Web player emits,
    /// joined in a fixed order, so a Web/Native receipt diff is a string diff.
    pub fn canonical(&self) -> String {
        match self {
            Self::PlayClip {
                state_id,
                model_id,
                clip_id,
                r#loop,
            } => {
                format!(
                    "animation-controller-v1|play|state={state_id}|model={model_id}|clip={clip_id}|loop={loop}"
                )
            }
            Self::TransitionClip {
                transition_id,
                model_id,
                from_clip_id,
                to_clip_id,
                duration_ms,
                r#loop,
                next_state_id,
            } => {
                format!(
                    "animation-controller-v1|transition|edge={transition_id}|model={model_id}|from={from_clip_id}|to={to_clip_id}|durationMs={duration_ms}|loop={loop}|next={next_state_id}"
                )
            }
        }
    }
}

/// Stateful product-player host for the dynamic-runtime v2/v3 clip controller.
#[derive(Debug, Clone)]
pub struct NativeAnimationControllerHost {
    active_state_id: String,
    parameters: HashMap<String, bool>,
    commands: Vec<NativeAnimationControllerCommand>,
    started: bool,
}

impl NativeAnimationControllerHost {
    /// Builds the host from an already validated runtime. `None` when the
    /// scene carries no controller channel; the controller references were
    /// validated at parse time, so construction cannot fail.
    pub fn from_runtime(runtime: &DynamicSceneRuntime) -> Option<Self> {
        let controller = runtime.animation_controller.as_ref()?;
        Some(Self {
            active_state_id: controller.active_state_id.clone(),
            parameters: controller.parameters.clone(),
            commands: Vec::new(),
            started: false,
        })
    }

    pub fn active_state_id(&self) -> &str {
        &self.active_state_id
    }

    pub fn started(&self) -> bool {
        self.started
    }

    /// Deterministic command trail in application order; this is the Native
    /// side of the cross-end对拍基准.
    pub fn commands(&self) -> &[NativeAnimationControllerCommand] {
        &self.commands
    }

    /// Starts the package-authored active clip. A missing state fails closed
    /// and changes nothing (parse validation makes this unreachable today,
    /// but the host must not guess).
    pub fn start(&mut self, runtime: &DynamicSceneRuntime) -> Result<(), String> {
        let controller = runtime
            .animation_controller
            .as_ref()
            .ok_or("content has no animation controller channel")?;
        let state = state_of(controller, &self.active_state_id)
            .ok_or_else(|| format!("active state {} is missing", self.active_state_id))?;
        self.commands
            .push(NativeAnimationControllerCommand::PlayClip {
                state_id: state.id.clone(),
                model_id: state.model_id.clone(),
                clip_id: state.clip_id.clone(),
                r#loop: state.r#loop,
            });
        self.started = true;
        Ok(())
    }

    /// Updates one declared parameter. Unknown parameters are rejected
    /// (`false`) exactly like the Web `setParameter`; applied transitions are
    /// evaluated by the caller on the same clock as the Web mount sequence.
    pub fn set_parameter(&mut self, name: &str, value: bool) -> bool {
        match self.parameters.get_mut(name) {
            Some(slot) => {
                *slot = value;
                true
            }
            None => false,
        }
    }

    /// Applies at most one authored edge in declaration order, advancing the
    /// active state only after the command is recorded. Returns whether a
    /// transition applied. A runtime without the controller channel is an
    /// inconsistency and fails closed instead of silently doing nothing.
    pub fn evaluate(&mut self, runtime: &DynamicSceneRuntime) -> Result<bool, String> {
        if runtime.animation_controller.is_none() {
            return Err("content has no animation controller channel".into());
        }
        let Some(command) =
            runtime.animation_controller_command_for(&self.active_state_id, &self.parameters)
        else {
            return Ok(false);
        };
        let DynamicAnimationControllerCommand {
            transition_id,
            model_id,
            from_clip_id,
            to_clip_id,
            duration_ms,
            r#loop,
            next_state_id,
        } = command;
        self.commands
            .push(NativeAnimationControllerCommand::TransitionClip {
                transition_id,
                model_id,
                from_clip_id,
                to_clip_id,
                duration_ms,
                r#loop,
                next_state_id: next_state_id.clone(),
            });
        self.active_state_id = next_state_id;
        Ok(true)
    }
}

fn state_of<'a>(
    controller: &'a DynamicAnimationControllerRuntime,
    id: &str,
) -> Option<&'a crate::runtime_package::DynamicAnimationControllerState> {
    controller.states.iter().find(|state| state.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_package::parse_and_validate_dynamic_scene_runtime;

    fn runtime_json(parameters: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "schema":"deep-engine.dynamic-runtime","schemaVersion":2,"id":"scene","revision":1,
            "animationController":{
                "schema":"deep-engine.animation-controller","schemaVersion":1,
                "initialStateId":"robot:idle","activeStateId":"robot:idle","transitionDurationMs":250,
                "states":[
                    {"id":"robot:idle","modelId":"robot","clipId":"Idle","loop":true},
                    {"id":"robot:work","modelId":"robot","clipId":"Work Cycle","loop":true}
                ],
                "parameters":parameters,
                "transitions":[{"id":"idle-work","fromStateId":"robot:idle","toStateId":"robot:work","parameter":"advance","equals":true}]
            }
        })
    }

    #[test]
    fn mount_trail_matches_the_web_player_command_for_command() {
        // Same fixture and same expected sink calls as
        // dynamicAnimationControllerPlayback.test.ts (Web).
        let runtime = parse_and_validate_dynamic_scene_runtime(&runtime_json(
            serde_json::json!({"advance": false}),
        ))
        .unwrap();
        let mut host = NativeAnimationControllerHost::from_runtime(&runtime).unwrap();
        host.start(&runtime).unwrap();
        assert_eq!(host.active_state_id(), "robot:idle");
        assert_eq!(host.commands().len(), 1);
        assert_eq!(
            host.commands()[0].canonical(),
            "animation-controller-v1|play|state=robot:idle|model=robot|clip=Idle|loop=true"
        );
        // Persisted parameters do not satisfy the edge: no transition.
        assert!(!host.evaluate(&runtime).unwrap());

        // Unknown parameter is rejected without touching state.
        assert!(!host.set_parameter("unknown", true));
        assert_eq!(host.commands().len(), 1);

        // Declared parameter flip applies exactly one edge.
        assert!(host.set_parameter("advance", true));
        assert!(host.evaluate(&runtime).unwrap());
        assert_eq!(host.active_state_id(), "robot:work");
        assert_eq!(
            host.commands()[1].canonical(),
            "animation-controller-v1|transition|edge=idle-work|model=robot|from=Idle|to=Work Cycle|durationMs=250|loop=true|next=robot:work"
        );
        // Edge consumed: further evaluates stay no-ops (no ping-pong).
        assert!(!host.evaluate(&runtime).unwrap());
        assert_eq!(host.commands().len(), 2);
    }

    #[test]
    fn raw_command_helper_and_host_predicate_stay_byte_identical() {
        let runtime = parse_and_validate_dynamic_scene_runtime(&runtime_json(
            serde_json::json!({"advance": true}),
        ))
        .unwrap();
        let host = NativeAnimationControllerHost::from_runtime(&runtime).unwrap();
        let raw = runtime.animation_controller_command().unwrap();
        let live = runtime
            .animation_controller_command_for(host.active_state_id(), &host.parameters)
            .unwrap();
        assert_eq!(raw, live);
        assert_eq!(raw.transition_id, "idle-work");
    }

    #[test]
    fn scenes_without_a_controller_produce_no_host() {
        let runtime = parse_and_validate_dynamic_scene_runtime(&serde_json::json!({
            "schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,
            "interaction":{"schema":"deep-engine.dynamic-interaction","schemaVersion":1,"trigger":"command","action":"clear-selection","targetId":null}
        }))
        .unwrap();
        assert!(NativeAnimationControllerHost::from_runtime(&runtime).is_none());
    }

    #[test]
    fn start_fails_closed_when_the_channel_is_missing() {
        let without_controller = parse_and_validate_dynamic_scene_runtime(&serde_json::json!({
            "schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,
            "interaction":{"schema":"deep-engine.dynamic-interaction","schemaVersion":1,"trigger":"command","action":"clear-selection","targetId":null}
        }))
        .unwrap();
        let parsed = parse_and_validate_dynamic_scene_runtime(&runtime_json(
            serde_json::json!({"advance": false}),
        ))
        .unwrap();
        let mut host = NativeAnimationControllerHost::from_runtime(&parsed).unwrap();
        // A controller-less runtime cannot start or evaluate: explicit error,
        // no state change.
        assert!(host.start(&without_controller).is_err());
        assert!(host.evaluate(&without_controller).is_err());
        assert!(!host.started());
    }
}
