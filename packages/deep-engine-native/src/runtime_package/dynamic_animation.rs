//! 动画运行时的载荷类型(控制器/轨道/关键帧/采样),自 `dynamic_scene.rs`
//! 原样拆出;可见性与反序列化语义不变,由 `dynamic_scene` `pub use` 引回。

use std::collections::HashMap;

use serde::Deserialize;

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
    /// T14 clip 事件标记。缺省（旧包）为空集，语义不变；`time` 单位秒，
    /// clip 时长不在包 ABI 内，`0 <= time < duration` 由消费端时钟 fail-closed。
    #[serde(default)]
    pub events: Vec<DynamicAnimationEventMarker>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DynamicAnimationEventMarker {
    pub clip_id: String,
    pub event_id: String,
    pub time: f64,
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
