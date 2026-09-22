use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::Value;

use super::dynamic_scene_physics::{DynamicPhysicsRuntime, validate_physics_runtime};
use super::{RuntimePackageError, fail};

const MAX_TRACKS: usize = 4096;
const MAX_KEYFRAMES: usize = 65_536;
const MAX_EVENTS: usize = 65_536;
const MAX_CONTROLLER_STATES: usize = 512;
const MAX_CONTROLLER_PARAMETERS: usize = 128;
const MAX_CONTROLLER_TRANSITIONS: usize = 1_024;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicSceneRuntime {
    pub schema: String,
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    #[serde(default)]
    pub animation: Option<DynamicAnimationRuntime>,
    #[serde(default)]
    pub data_replay: Option<DynamicDataReplayRuntime>,
    #[serde(default)]
    pub interaction: Option<DynamicInteractionRuntime>,
    #[serde(default)]
    pub animation_controller: Option<DynamicAnimationControllerRuntime>,
    #[serde(default)]
    pub physics: Option<DynamicPhysicsRuntime>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicAnimationControllerRuntime {
    pub schema: String,
    pub schema_version: u32,
    pub initial_state_id: String,
    pub active_state_id: String,
    pub transition_duration_ms: u64,
    pub states: Vec<DynamicAnimationControllerState>,
    pub parameters: HashMap<String, bool>,
    pub transitions: Vec<DynamicAnimationControllerTransition>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicAnimationControllerState {
    pub id: String,
    pub model_id: String,
    pub clip_id: String,
    pub r#loop: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicAnimationControllerTransition {
    pub id: String,
    pub from_state_id: String,
    pub to_state_id: String,
    pub parameter: String,
    pub equals: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DynamicAnimationControllerCommand {
    pub transition_id: String,
    pub model_id: String,
    pub from_clip_id: String,
    pub to_clip_id: String,
    pub duration_ms: u64,
    pub r#loop: bool,
    pub next_state_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicAnimationRuntime {
    pub schema: String,
    pub schema_version: u32,
    pub duration_ms: u64,
    #[serde(default = "default_true")]
    pub autoplay: bool,
    #[serde(default)]
    pub r#loop: bool,
    /// B2-b 区间播放:发布包携带的入点/出点;缺省播放整条时间线。
    #[serde(default)]
    pub playback_range_ms: Option<DynamicPlaybackRangeMs>,
    pub tracks: Vec<DynamicAnimationTrack>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicPlaybackRangeMs {
    pub in_ms: u64,
    pub out_ms: u64,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicAnimationTrack {
    pub target_id: String,
    pub property: String,
    pub keyframes: Vec<DynamicAnimationKeyframe>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum DynamicAnimationTransition {
    Linear,
    Smooth,
    #[serde(rename = "ease-in")]
    EaseIn,
    #[serde(rename = "ease-out")]
    EaseOut,
    Step,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicAnimationKeyframe {
    pub time_ms: u64,
    pub value: [f64; 7],
    #[serde(default)]
    pub transition: Option<DynamicAnimationTransition>,
}

/// A sampled animation value ready for a host renderer/player to apply.
#[derive(Debug, Clone, PartialEq)]
pub struct DynamicAnimationSample {
    pub target_id: String,
    pub property: String,
    pub value: [f64; 7],
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicDataReplayRuntime {
    pub schema: String,
    pub schema_version: u32,
    pub channel: String,
    pub events: Vec<DynamicDataReplayEvent>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicDataReplayEvent {
    pub revision: u64,
    pub time_ms: u64,
    pub payload: Value,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicInteractionRuntime {
    pub schema: String,
    pub schema_version: u32,
    pub trigger: String,
    pub action: String,
    pub target_id: Option<String>,
}

impl DynamicSceneRuntime {
    /// Samples every animation track at `time_ms`. The value is clamped to the
    /// authored duration; this keeps a replay deterministic at both ends.
    pub fn sample_animation(&self, time_ms: u64) -> Vec<DynamicAnimationSample> {
        let Some(animation) = &self.animation else {
            return Vec::new();
        };
        // B2-b:发布包携带播放区间时,采样时间钳制进 [in,out];
        // 缺省保持整条时间线语义(与 Web 引擎区间合同一致)。
        let time_ms = match animation.playback_range_ms {
            Some(range) => time_ms.clamp(range.in_ms, range.out_ms),
            None => time_ms.min(animation.duration_ms),
        };
        animation
            .tracks
            .iter()
            .map(|track| {
                let value = sample_track(&track.keyframes, time_ms);
                DynamicAnimationSample {
                    target_id: track.target_id.clone(),
                    property: track.property.clone(),
                    value,
                }
            })
            .collect()
    }

    /// Returns all data-replay events visible at a replay clock position.
    pub fn replay_events_at(&self, time_ms: u64) -> Vec<&DynamicDataReplayEvent> {
        self.data_replay
            .as_ref()
            .map(|replay| {
                replay
                    .events
                    .iter()
                    .filter(|event| event.time_ms <= time_ms)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Resolves at most one controller edge in declaration order. The host
    /// applies this command and advances its active state only after success.
    pub fn animation_controller_command(&self) -> Option<DynamicAnimationControllerCommand> {
        let controller = self.animation_controller.as_ref()?;
        self.animation_controller_command_for(&controller.active_state_id, &controller.parameters)
    }

    /// Same edge resolution against a live host's active state and parameters,
    /// so the product player host (`native_animation_controller`) and the raw
    /// command helper share one deterministic predicate instead of drifting.
    pub fn animation_controller_command_for(
        &self,
        active_state_id: &str,
        parameters: &HashMap<String, bool>,
    ) -> Option<DynamicAnimationControllerCommand> {
        let controller = self.animation_controller.as_ref()?;
        let transition = controller.transitions.iter().find(|transition| {
            transition.from_state_id == active_state_id
                && parameters.get(&transition.parameter) == Some(&transition.equals)
        })?;
        let from = controller
            .states
            .iter()
            .find(|state| state.id == transition.from_state_id)?;
        let to = controller
            .states
            .iter()
            .find(|state| state.id == transition.to_state_id)?;
        Some(DynamicAnimationControllerCommand {
            transition_id: transition.id.clone(),
            model_id: to.model_id.clone(),
            from_clip_id: from.clip_id.clone(),
            to_clip_id: to.clip_id.clone(),
            duration_ms: controller.transition_duration_ms,
            r#loop: to.r#loop,
            next_state_id: to.id.clone(),
        })
    }
}

fn sample_track(keyframes: &[DynamicAnimationKeyframe], time_ms: u64) -> [f64; 7] {
    if keyframes.len() == 1 || time_ms <= keyframes[0].time_ms {
        return keyframes[0].value;
    }
    let Some((index, next)) = keyframes
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, frame)| frame.time_ms >= time_ms)
    else {
        return keyframes.last().unwrap().value;
    };
    let previous = &keyframes[index - 1];
    let span = (next.time_ms - previous.time_ms) as f64;
    let factor = if span == 0.0 {
        0.0
    } else {
        (time_ms - previous.time_ms) as f64 / span
    };
    let factor = match next
        .transition
        .as_ref()
        .unwrap_or(&DynamicAnimationTransition::Linear)
    {
        DynamicAnimationTransition::Linear => factor,
        DynamicAnimationTransition::Smooth => factor * factor * (3.0 - 2.0 * factor),
        DynamicAnimationTransition::EaseIn => factor * factor,
        DynamicAnimationTransition::EaseOut => 1.0 - (1.0 - factor) * (1.0 - factor),
        DynamicAnimationTransition::Step => 0.0,
    };
    let mut value = [0.0; 7];
    for (slot, output) in value.iter_mut().enumerate() {
        *output = previous.value[slot] + (next.value[slot] - previous.value[slot]) * factor;
    }
    value
}

/// Byte-exact cross-end frame contract with the Web consumer
/// (`apps/web/src/delivery/dynamicRuntimePlayback.ts`): sorted tracks, fixed
/// 6-decimal components, integer clock, `-0` normalized so TS `toFixed` and
/// Rust `{:.6}` produce identical bytes. Drivers hash this string once with
/// a shared SHA-256 implementation; the string itself is the contract.
pub fn canonical_dynamic_frame(
    time_ms: u64,
    samples: &[DynamicAnimationSample],
    replay_revisions: &[u64],
) -> String {
    let mut samples: Vec<&DynamicAnimationSample> = samples.iter().collect();
    samples.sort_by(|left, right| {
        (&left.target_id, &left.property).cmp(&(&right.target_id, &right.property))
    });
    let mut text = format!("dynamic-frame-v1|t={time_ms}|events=");
    for (index, revision) in replay_revisions.iter().enumerate() {
        if index > 0 {
            text.push(',');
        }
        text.push_str(&revision.to_string());
    }
    text.push_str("|tracks=");
    for (index, sample) in samples.iter().enumerate() {
        if index > 0 {
            text.push(';');
        }
        text.push_str(&sample.target_id);
        text.push('>');
        text.push_str(&sample.property);
        text.push('=');
        for (component, value) in sample.value.iter().enumerate() {
            if component > 0 {
                text.push(',');
            }
            let value = if *value == 0.0 { 0.0 } else { *value };
            text.push_str(&format!("{value:.6}"));
        }
    }
    text
}

pub fn parse_and_validate_dynamic_scene_runtime(
    value: &Value,
) -> Result<DynamicSceneRuntime, RuntimePackageError> {
    let runtime: DynamicSceneRuntime = serde_json::from_value(value.clone())
        .map_err(|error| RuntimePackageError(format!("dynamic runtime: {error}")))?;
    if runtime.schema != "deep-engine.dynamic-runtime"
        || !matches!(runtime.schema_version, 1..=3)
        || runtime.id.is_empty()
        || runtime.revision == 0
    {
        return fail("dynamic runtime has an unsupported schema or identity");
    }
    if runtime.schema_version == 1 && runtime.animation_controller.is_some() {
        return fail("dynamic runtime v1 cannot contain an animation controller");
    }
    if runtime.schema_version < 3 && runtime.physics.is_some() {
        return fail("dynamic runtime before v3 cannot contain physics");
    }
    if runtime.animation.is_none()
        && runtime.data_replay.is_none()
        && runtime.interaction.is_none()
        && runtime.animation_controller.is_none()
        && runtime.physics.is_none()
    {
        return fail("dynamic runtime requires at least one channel");
    }
    if let Some(animation) = &runtime.animation {
        if animation.schema != "deep-engine.dynamic-animation"
            || animation.schema_version != 1
            || animation.duration_ms > 86_400_000
            || animation.tracks.len() > MAX_TRACKS
        {
            return fail("dynamic animation envelope is invalid");
        }
        if let Some(range) = &animation.playback_range_ms {
            if range.in_ms >= range.out_ms || range.out_ms > animation.duration_ms {
                return fail("dynamic animation playback range is invalid");
            }
        }
        for track in &animation.tracks {
            if track.target_id.is_empty()
                || !matches!(
                    track.property.as_str(),
                    "translation" | "rotation" | "scale" | "camera-position" | "camera-target"
                        | "object-visible"
                )
                || track.keyframes.is_empty()
                || track.keyframes.len() > MAX_KEYFRAMES
            {
                return fail("dynamic animation track is invalid");
            }
            let mut previous = 0;
            for (index, frame) in track.keyframes.iter().enumerate() {
                if frame.value.iter().any(|value| !value.is_finite())
                    || frame.time_ms > animation.duration_ms
                    || index > 0 && frame.time_ms < previous
                {
                    return fail("dynamic animation keyframes must be finite and sorted");
                }
                previous = frame.time_ms;
            }
        }
    }
    if let Some(replay) = &runtime.data_replay {
        if replay.schema != "deep-engine.dynamic-data-replay"
            || replay.schema_version != 1
            || replay.channel.is_empty()
            || replay.channel.len() > 128
            || replay.events.is_empty()
            || replay.events.len() > MAX_EVENTS
        {
            return fail("dynamic data replay envelope is invalid");
        }
        let mut previous = 0;
        for (index, event) in replay.events.iter().enumerate() {
            if event.revision == 0
                || event.time_ms > 86_400_000
                || index > 0 && event.revision <= previous
            {
                return fail("dynamic data replay revisions must be strictly increasing");
            }
            previous = event.revision;
        }
    }
    if let Some(interaction) = &runtime.interaction {
        if value_field_missing(value, "interaction", "targetId") {
            return fail("dynamic interaction targetId must be explicitly null or a string");
        }
        if interaction.schema != "deep-engine.dynamic-interaction"
            || interaction.schema_version != 1
            || !matches!(
                interaction.trigger.as_str(),
                "pointer-select" | "pointer-clear" | "command"
            )
            || !matches!(
                interaction.action.as_str(),
                "select" | "clear-selection" | "clip" | "set-visible"
            )
            || (interaction.action == "clear-selection" && interaction.target_id.is_some())
            || (interaction.action != "clear-selection" && interaction.target_id.is_none())
        {
            return fail("dynamic interaction shape is invalid");
        }
    }
    if let Some(controller) = &runtime.animation_controller {
        if controller.schema != "deep-engine.animation-controller"
            || controller.schema_version != 1
            || controller.transition_duration_ms > 60_000
            || controller.states.is_empty()
            || controller.states.len() > MAX_CONTROLLER_STATES
            || controller.parameters.len() > MAX_CONTROLLER_PARAMETERS
            || controller.transitions.len() > MAX_CONTROLLER_TRANSITIONS
        {
            return fail("dynamic animation controller envelope is invalid");
        }
        let state_ids: HashSet<&str> = controller
            .states
            .iter()
            .map(|state| state.id.as_str())
            .collect();
        let transition_ids: HashSet<&str> = controller
            .transitions
            .iter()
            .map(|transition| transition.id.as_str())
            .collect();
        if state_ids.len() != controller.states.len()
            || transition_ids.len() != controller.transitions.len()
            || !state_ids.contains(controller.initial_state_id.as_str())
            || !state_ids.contains(controller.active_state_id.as_str())
            || controller.states.iter().any(|state| {
                !valid_resource_id(&state.id)
                    || !valid_resource_id(&state.model_id)
                    || state.clip_id.is_empty()
                    || state.clip_id.chars().count() > 256
            })
            || controller
                .parameters
                .keys()
                .any(|parameter| !valid_resource_id(parameter))
        {
            return fail("dynamic animation controller states are invalid");
        }
        for transition in &controller.transitions {
            let from = controller
                .states
                .iter()
                .find(|state| state.id == transition.from_state_id);
            let to = controller
                .states
                .iter()
                .find(|state| state.id == transition.to_state_id);
            if !valid_resource_id(&transition.id)
                || !valid_resource_id(&transition.from_state_id)
                || !valid_resource_id(&transition.to_state_id)
                || !valid_resource_id(&transition.parameter)
                || from.is_none()
                || to.is_none()
                || from.unwrap().model_id != to.unwrap().model_id
                || !controller.parameters.contains_key(&transition.parameter)
            {
                return fail("dynamic animation controller transition is invalid");
            }
        }
    }
    if let Some(physics) = &runtime.physics {
        validate_physics_runtime(value, physics)?;
    }
    Ok(runtime)
}

fn value_field_missing(root: &Value, parent: &str, field: &str) -> bool {
    root.get(parent)
        .and_then(Value::as_object)
        .is_none_or(|object| !object.contains_key(field))
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

#[cfg(test)]
mod tests {
    use super::super::dynamic_scene_physics::DynamicPhysicsCommand;
    use super::*;
    fn animation() -> Value {
        serde_json::json!({"schema":"deep-engine.dynamic-animation","schemaVersion":1,"durationMs":1000,"tracks":[{"targetId":"node-a","property":"translation","keyframes":[{"timeMs":0,"value":[0,0,0,0,0,0,1]},{"timeMs":1000,"value":[1,0,0,0,0,0,1]}]}]})
    }
    #[test]
    fn accepts_animation_and_replay() {
        let value = serde_json::json!({"schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,"animation":animation()});
        assert!(parse_and_validate_dynamic_scene_runtime(&value).is_ok());
    }

    #[test]
    fn accepts_camera_tracks_and_playback_policy() {
        let value = serde_json::json!({
            "schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,
            "animation":{"schema":"deep-engine.dynamic-animation","schemaVersion":1,"durationMs":1000,"autoplay":true,"loop":true,"tracks":[
                {"targetId":"scene.camera","property":"camera-position","keyframes":[{"timeMs":0,"value":[0,2,5,0,0,0,1]}]},
                {"targetId":"scene.camera","property":"camera-target","keyframes":[{"timeMs":0,"value":[0,0,0,0,0,0,1]}]}
            ]}
        });
        let runtime = parse_and_validate_dynamic_scene_runtime(&value).unwrap();
        let animation = runtime.animation.unwrap();
        assert!(animation.autoplay);
        assert!(animation.r#loop);
        assert_eq!(animation.tracks[0].property, "camera-position");
    }

    #[test]
    fn accepts_playback_range_and_clamps_sampling() {
        // B2-b:合法区间解析成功,采样时间钳制进 [in,out]。
        let value = serde_json::json!({"schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,
            "animation":{"schema":"deep-engine.dynamic-animation","schemaVersion":1,"durationMs":1000,
                "playbackRangeMs":{"inMs":200,"outMs":800},
                "tracks":[{"targetId":"node-a","property":"translation","keyframes":[
                    {"timeMs":0,"value":[0,0,0,0,0,0,1]},{"timeMs":1000,"value":[1,0,0,0,0,0,1]}]}]}});
        let runtime = parse_and_validate_dynamic_scene_runtime(&value).unwrap();
        let parsed_animation = runtime.animation.as_ref().unwrap();
        let range = parsed_animation.playback_range_ms.expect("playback range must parse");
        assert_eq!((range.in_ms, range.out_ms), (200, 800));
        // 采样:区间外请求钳到边界;区间内照常;旧包(缺字段)仍按整条时间线。
        // 关键帧 x: 0ms→0、1000ms→1 线性。
        let samples_in = runtime.sample_animation(500);
        let x_in = samples_in[0].value[0];
        assert!((x_in - 0.5).abs() < 1e-9, "区间内按原时间采样, got {x_in}");
        let x_low = runtime.sample_animation(50)[0].value[0];
        assert!((x_low - 0.2).abs() < 1e-9, "低于入点钳到 inMs=200, got {x_low}");
        let x_high = runtime.sample_animation(950)[0].value[0];
        assert!((x_high - 0.8).abs() < 1e-9, "高于出点钳到 outMs=800, got {x_high}");
        // 旧包无区间字段:100ms 处照常采样。
        let legacy = parse_and_validate_dynamic_scene_runtime(&serde_json::json!(
            {"schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,"animation":animation()}
        )).unwrap();
        let x_legacy = legacy.sample_animation(100)[0].value[0];
        assert!((x_legacy - 0.1).abs() < 1e-9);
    }

    #[test]
    fn rejects_degenerate_or_out_of_duration_playback_range() {
        let build = |in_ms: u64, out_ms: u64| {
            serde_json::json!({"schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,
                "animation":{"schema":"deep-engine.dynamic-animation","schemaVersion":1,"durationMs":1000,
                    "playbackRangeMs":{"inMs":in_ms,"outMs":out_ms},
                    "tracks":[{"targetId":"node-a","property":"translation","keyframes":[
                        {"timeMs":0,"value":[0,0,0,0,0,0,1]}]}]}})
        };
        // 退化区间(in>=out)
        assert!(parse_and_validate_dynamic_scene_runtime(&build(500, 500)).is_err());
        // 出点越时长
        assert!(parse_and_validate_dynamic_scene_runtime(&build(200, 1200)).is_err());
        // 入点负值由 serde u64 拒绝(deny_unknown_fields + 类型)
        assert!(parse_and_validate_dynamic_scene_runtime(&serde_json::json!({"schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,
            "animation":{"schema":"deep-engine.dynamic-animation","schemaVersion":1,"durationMs":1000,
                "playbackRangeMs":{"inMs":-1,"outMs":800},
                "tracks":[{"targetId":"node-a","property":"translation","keyframes":[
                    {"timeMs":0,"value":[0,0,0,0,0,0,1]}]}]}})).is_err());
    }

    #[test]
    fn consumes_v2_animation_controller_and_rejects_legacy_or_broken_references() {
        let controller = serde_json::json!({
            "schema":"deep-engine.animation-controller","schemaVersion":1,
            "initialStateId":"robot:idle","activeStateId":"robot:idle","transitionDurationMs":250,
            "states":[
                {"id":"robot:idle","modelId":"robot","clipId":"Idle","loop":true},
                {"id":"robot:work","modelId":"robot","clipId":"Work Cycle","loop":true}
            ],
            "parameters":{"advance":true},
            "transitions":[{"id":"idle-work","fromStateId":"robot:idle","toStateId":"robot:work","parameter":"advance","equals":true}]
        });
        let value = serde_json::json!({
            "schema":"deep-engine.dynamic-runtime","schemaVersion":2,"id":"scene","revision":1,
            "animationController":controller
        });
        let runtime = parse_and_validate_dynamic_scene_runtime(&value).unwrap();
        assert_eq!(
            runtime.animation_controller_command(),
            Some(DynamicAnimationControllerCommand {
                transition_id: "idle-work".into(),
                model_id: "robot".into(),
                from_clip_id: "Idle".into(),
                to_clip_id: "Work Cycle".into(),
                duration_ms: 250,
                r#loop: true,
                next_state_id: "robot:work".into(),
            })
        );

        let mut legacy = value.clone();
        legacy["schemaVersion"] = serde_json::json!(1);
        assert!(parse_and_validate_dynamic_scene_runtime(&legacy).is_err());
        let mut future = value.clone();
        future["schemaVersion"] = serde_json::json!(4);
        assert!(parse_and_validate_dynamic_scene_runtime(&future).is_err());
        let mut broken = value;
        broken["animationController"]["transitions"][0]["toStateId"] = serde_json::json!("missing");
        assert!(parse_and_validate_dynamic_scene_runtime(&broken).is_err());
    }

    #[test]
    fn consumes_v3_physics_as_deterministic_native_commands() {
        let value = serde_json::json!({
            "schema":"deep-engine.dynamic-runtime","schemaVersion":3,"id":"scene","revision":1,
            "physics":{"schema":"deep-engine.physics-runtime","schemaVersion":1,"enabled":true,"playing":true,
                "gravity":[0,-9.81,0],
                "bodies":[
                    {"id":"body-a","type":"dynamic","initialPose":{"translation":[0,2,0],"rotation":[0,0,0,1]},"mass":2,"friction":0.5,"restitution":0.1,"collider":{"kind":"render-bounds","instanceIds":["instance-a"]}},
                    {"id":"body-b","type":"fixed","initialPose":{"translation":[0,0,0],"rotation":[0,0,0,1]},"mass":1,"friction":0.4,"restitution":0,"collider":{"kind":"render-bounds","instanceIds":["instance-b"]}}
                ],
                "joints":[{"id":"joint-a","kind":"revolute","solver":"impulse","bodyId":"body-a","connectedBodyId":"body-b",
                    "worldAnchor":[0,1,0],"localAnchor":[0,0,0],"axis":[0,1,0],
                    "limits":{"enabled":true,"min":-1,"max":1},"motor":{"enabled":true,"targetVelocity":2,"strength":4}}]
            }
        });
        let runtime = parse_and_validate_dynamic_scene_runtime(&value).unwrap();
        let commands = runtime.physics_commands();
        assert_eq!(commands.len(), 4);
        assert!(matches!(
            commands[0],
            DynamicPhysicsCommand::Configure { playing: true, .. }
        ));
        assert!(
            matches!(&commands[1], DynamicPhysicsCommand::UpsertBody(body) if body.id == "body-a")
        );
        assert!(
            matches!(&commands[3], DynamicPhysicsCommand::UpsertJoint(joint) if joint.id == "joint-a")
        );

        let mut legacy = value.clone();
        legacy["schemaVersion"] = serde_json::json!(2);
        assert!(parse_and_validate_dynamic_scene_runtime(&legacy).is_err());
        let mut unsupported = value;
        unsupported["physics"]["joints"][0]["solver"] = serde_json::json!("multibody");
        assert!(parse_and_validate_dynamic_scene_runtime(&unsupported).is_err());
    }

    #[test]
    fn samples_animation_and_replay_at_clock_position() {
        let value = serde_json::json!({
            "schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,
            "animation": animation(),
            "dataReplay":{"schema":"deep-engine.dynamic-data-replay","schemaVersion":1,"channel":"telemetry",
                "events":[{"revision":1,"timeMs":100,"payload":{"value":1}},{"revision":2,"timeMs":700,"payload":{"value":2}}]}
        });
        let runtime = parse_and_validate_dynamic_scene_runtime(&value).unwrap();
        let samples = runtime.sample_animation(500);
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].target_id, "node-a");
        assert_eq!(samples[0].value[0], 0.5);
        assert_eq!(runtime.sample_animation(2_000)[0].value[0], 1.0);
        assert_eq!(runtime.replay_events_at(500).len(), 1);
        assert_eq!(runtime.replay_events_at(700).len(), 2);
    }
    #[test]
    fn rejects_unknown_and_invalid_order() {
        let mut value = serde_json::json!({"schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,"animation":animation(),"extra":true});
        assert!(parse_and_validate_dynamic_scene_runtime(&value).is_err());
        value["animation"]["tracks"][0]["keyframes"][0]["timeMs"] = serde_json::json!(1001);
        assert!(parse_and_validate_dynamic_scene_runtime(&value).is_err());
    }
    #[test]
    fn rejects_empty_and_bad_interaction() {
        let value = serde_json::json!({"schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1});
        assert!(parse_and_validate_dynamic_scene_runtime(&value).is_err());
        let value = serde_json::json!({"schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,"interaction":{"schema":"deep-engine.dynamic-interaction","schemaVersion":1,"trigger":"command","action":"clip","targetId":null}});
        assert!(parse_and_validate_dynamic_scene_runtime(&value).is_err());
        let value = serde_json::json!({"schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,"interaction":{"schema":"deep-engine.dynamic-interaction","schemaVersion":1,"trigger":"command","action":"clear-selection"}});
        assert!(parse_and_validate_dynamic_scene_runtime(&value).is_err());
    }

    #[test]
    fn canonical_frame_matches_the_web_contract_byte_for_byte() {
        // Same fixture values as dynamicRuntimePlayback.test.ts; the expected
        // string below is the golden shared by both consumers.
        let value = serde_json::json!({
            "schema":"deep-engine.dynamic-runtime","schemaVersion":1,"id":"scene","revision":1,
            "animation":{"schema":"deep-engine.dynamic-animation","schemaVersion":1,"durationMs":1000,"tracks":[
                {"targetId":"pump","property":"translation","keyframes":[{"timeMs":0,"value":[0,0,0,0,0,0,1]},{"timeMs":1000,"value":[10,2,0,0,0,0,1]}]},
                {"targetId":"pump","property":"rotation","keyframes":[{"timeMs":0,"value":[0,0,0,0,0,0,1]},{"timeMs":1000,"value":[0,0,0,0,0,1,0]}]},
                {"targetId":"pump","property":"scale","keyframes":[{"timeMs":0,"value":[1,1,1,0,0,0,1]},{"timeMs":1000,"value":[2,2,2,0,0,0,1]}]}
            ]},
            "dataReplay":{"schema":"deep-engine.dynamic-data-replay","schemaVersion":1,"channel":"telemetry","events":[{"revision":1,"timeMs":400,"payload":{"value":7}}]}
        });
        let runtime = parse_and_validate_dynamic_scene_runtime(&value).unwrap();
        let samples = runtime.sample_animation(500);
        let revisions: Vec<u64> = runtime
            .replay_events_at(500)
            .iter()
            .map(|event| event.revision)
            .collect();
        assert_eq!(
            canonical_dynamic_frame(500, &samples, &revisions),
            "dynamic-frame-v1|t=500|events=1|tracks=".to_owned()
                + "pump>rotation=0.000000,0.000000,0.000000,0.000000,0.000000,0.500000,0.500000;"
                + "pump>scale=1.500000,1.500000,1.500000,0.000000,0.000000,0.000000,1.000000;"
                + "pump>translation=5.000000,1.000000,0.000000,0.000000,0.000000,0.000000,1.000000"
        );
        let clamped = runtime.sample_animation(2_000);
        assert!(
            canonical_dynamic_frame(1_000, &clamped, &[])
                .starts_with("dynamic-frame-v1|t=1000|events=|tracks=")
        );
        // -0 must normalize exactly like the TS `value === 0 ? 0 : value` guard.
        let negative_zero = [DynamicAnimationSample {
            target_id: "pump".into(),
            property: "translation".into(),
            value: [-0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
        }];
        assert_eq!(
            canonical_dynamic_frame(0, &negative_zero, &[]),
            "dynamic-frame-v1|t=0|events=|tracks=pump>translation=0.000000,0.000000,0.000000,0.000000,0.000000,0.000000,1.000000"
        );
    }
}
