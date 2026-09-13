use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwinState {
    pub chemistry: String,
    pub nominal_capacity_ah: f32,
    pub soh: f32,
    pub soc: f32,
    pub temperature_c: f32,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_context: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct InitializeRequest {
    #[serde(default = "default_chemistry")]
    pub chemistry: String,
    #[serde(default = "default_capacity")]
    pub nominal_capacity_ah: f32,
    #[serde(default = "default_soh")]
    pub soh: f32,
    #[serde(default = "default_soc")]
    pub soc: f32,
    #[serde(default = "default_temperature")]
    pub temperature_c: f32,
    pub transfer_context: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Segment {
    pub duration_minutes: f32,
    pub current_c_rate: f32,
    pub ambient_temperature_c: Option<f32>,
}

#[derive(Debug, Deserialize)]
pub struct SimulateRequest {
    pub twin_id: String,
    #[serde(default = "default_scenario")]
    pub scenario_name: String,
    #[serde(default = "default_resolution")]
    pub resolution_minutes: f32,
    pub segments: Vec<Segment>,
    #[serde(default = "default_execution")]
    pub execution_mode: String,
}

#[derive(Debug, Deserialize)]
pub struct AssimilateRequest {
    pub twin_id: String,
    pub soc: Option<f32>,
    pub soh: Option<f32>,
    pub temperature_c: Option<f32>,
}

#[derive(Clone, Debug)]
pub struct ProfilePoint {
    pub time_minutes: f32,
    pub current_c_rate: f32,
    pub ambient_temperature_c: f32,
}

#[derive(Debug)]
pub struct PinoOutput {
    pub voltage: Vec<f32>,
    pub soc: Vec<f32>,
    pub temperature: Vec<f32>,
    pub fast_weight: f32,
    pub operator_weight: f32,
    pub risk_features: Vec<f32>,
}

#[derive(Debug, Deserialize)]
pub struct PinnInferenceRequest {
    pub curves: Vec<f32>,
    pub curve_mask: Vec<f32>,
    pub condition_embedding: Vec<f32>,
    pub soh_input: Vec<f32>,
    pub cycle_features: Vec<f32>,
    pub physics_condition: Vec<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnInferenceOutput {
    pub soh_trajectory: Vec<f32>,
    pub physical_soh: Vec<f32>,
    pub physics_gate: f32,
    pub identifiability_score: f32,
    pub physical_observation_rmse: f32,
    pub physical_fit_score: f32,
    pub nominal_capacity_ah: f32,
    pub equivalent_resistance_ohm: f32,
    pub effective_diffusion_time_hours: Vec<f32>,
    pub normalized_fade_rate_per_cycle: f32,
    pub chemistry_fade_scale: f32,
    pub ocv_minimum_v: f32,
    pub ocv_span_v: f32,
    pub exchange_c_rate: f32,
    pub overpotential_scale_v: f32,
}

fn default_chemistry() -> String {
    "lfp".into()
}
fn default_capacity() -> f32 {
    100.0
}
fn default_soh() -> f32 {
    1.0
}
fn default_soc() -> f32 {
    0.8
}
fn default_temperature() -> f32 {
    25.0
}
fn default_scenario() -> String {
    "未来工况".into()
}
fn default_resolution() -> f32 {
    1.0
}
fn default_execution() -> String {
    "dynamic".into()
}
