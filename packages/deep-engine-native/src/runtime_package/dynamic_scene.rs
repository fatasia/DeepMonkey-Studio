use serde::Deserialize;
use serde_json::Value;

use super::{fail, RuntimePackageError};

const MAX_TRACKS: usize = 4096;
const MAX_KEYFRAMES: usize = 65_536;
const MAX_EVENTS: usize = 65_536;

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
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicAnimationRuntime {
    pub schema: String,
    pub schema_version: u32,
    pub duration_ms: u64,
    pub tracks: Vec<DynamicAnimationTrack>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicAnimationTrack {
    pub target_id: String,
    pub property: String,
    pub keyframes: Vec<DynamicAnimationKeyframe>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicAnimationKeyframe {
    pub time_ms: u64,
    pub value: [f64; 7],
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
        let Some(animation) = &self.animation else { return Vec::new() };
        let time_ms = time_ms.min(animation.duration_ms);
        animation.tracks.iter().map(|track| {
            let value = sample_track(&track.keyframes, time_ms);
            DynamicAnimationSample { target_id: track.target_id.clone(), property: track.property.clone(), value }
        }).collect()
    }

    /// Returns all data-replay events visible at a replay clock position.
    pub fn replay_events_at(&self, time_ms: u64) -> Vec<&DynamicDataReplayEvent> {
        self.data_replay.as_ref().map(|replay| replay.events.iter().filter(|event| event.time_ms <= time_ms).collect()).unwrap_or_default()
    }
}

fn sample_track(keyframes: &[DynamicAnimationKeyframe], time_ms: u64) -> [f64; 7] {
    if keyframes.len() == 1 || time_ms <= keyframes[0].time_ms { return keyframes[0].value; }
    let Some((index, next)) = keyframes.iter().enumerate().skip(1).find(|(_, frame)| frame.time_ms >= time_ms) else { return keyframes.last().unwrap().value; };
    let previous = &keyframes[index - 1];
    let span = (next.time_ms - previous.time_ms) as f64;
    let factor = if span == 0.0 { 0.0 } else { (time_ms - previous.time_ms) as f64 / span };
    let mut value = [0.0; 7];
    for (slot, output) in value.iter_mut().enumerate() { *output = previous.value[slot] + (next.value[slot] - previous.value[slot]) * factor; }
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
    samples.sort_by(|left, right| (&left.target_id, &left.property).cmp(&(&right.target_id, &right.property)));
    let mut text = format!("dynamic-frame-v1|t={time_ms}|events=");
    for (index, revision) in replay_revisions.iter().enumerate() {
        if index > 0 { text.push(','); }
        text.push_str(&revision.to_string());
    }
    text.push_str("|tracks=");
    for (index, sample) in samples.iter().enumerate() {
        if index > 0 { text.push(';'); }
        text.push_str(&sample.target_id);
        text.push('>');
        text.push_str(&sample.property);
        text.push('=');
        for (component, value) in sample.value.iter().enumerate() {
            if component > 0 { text.push(','); }
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
        || runtime.schema_version != 1
        || runtime.id.is_empty()
        || runtime.revision == 0
    {
        return fail("dynamic runtime has an unsupported schema or identity");
    }
    if runtime.animation.is_none() && runtime.data_replay.is_none() && runtime.interaction.is_none()
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
        for track in &animation.tracks {
            if track.target_id.is_empty()
                || !matches!(
                    track.property.as_str(),
                    "translation" | "rotation" | "scale"
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
    Ok(runtime)
}

fn value_field_missing(root: &Value, parent: &str, field: &str) -> bool {
    root.get(parent)
        .and_then(Value::as_object)
        .is_none_or(|object| !object.contains_key(field))
}

#[cfg(test)]
mod tests {
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
        let revisions: Vec<u64> = runtime.replay_events_at(500).iter().map(|event| event.revision).collect();
        assert_eq!(
            canonical_dynamic_frame(500, &samples, &revisions),
            "dynamic-frame-v1|t=500|events=1|tracks="
                .to_owned()
                + "pump>rotation=0.000000,0.000000,0.000000,0.000000,0.000000,0.500000,0.500000;"
                + "pump>scale=1.500000,1.500000,1.500000,0.000000,0.000000,0.000000,1.000000;"
                + "pump>translation=5.000000,1.000000,0.000000,0.000000,0.000000,0.000000,1.000000"
        );
        let clamped = runtime.sample_animation(2_000);
        assert!(canonical_dynamic_frame(1_000, &clamped, &[]).starts_with("dynamic-frame-v1|t=1000|events=|tracks="));
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
