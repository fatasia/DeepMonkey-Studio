use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::DefaultBodyLimit,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    model::{MODEL_VERSION, PinoRuntime},
    pinn::{MODEL_VERSION as PINN_MODEL_VERSION, PinnRuntime},
    simulation,
    types::{
        AssimilateRequest, InitializeRequest, PinnInferenceRequest, SimulateRequest, TwinState,
    },
};

type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

struct TwinRecord {
    state: TwinState,
    evidence: Option<Value>,
    simulation_count: u64,
    assimilation_count: u64,
}

pub struct AppState {
    runtime: PinoRuntime,
    pinn: PinnRuntime,
    twins: RwLock<HashMap<String, TwinRecord>>,
}

impl AppState {
    pub fn new(runtime: PinoRuntime, pinn: PinnRuntime) -> Self {
        Self {
            runtime,
            pinn,
            twins: RwLock::new(HashMap::new()),
        }
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/research/release/status", get(release_status))
        .route("/inference/batterymformer-pinn", post(pinn_inference))
        .route("/research/digital-twin/status", get(twin_status))
        .route("/research/digital-twin/initialize", post(initialize))
        .route(
            "/research/digital-twin/simulate-short-horizon",
            post(simulate),
        )
        .route("/research/digital-twin/assimilate-cycle", post(assimilate))
        .route("/research/digital-twin/{twin_id}/evidence", get(evidence))
        .with_state(state)
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ready",
        "runtime": "rust-ort",
        "model": "battery.spm-pino",
        "modelVersion": MODEL_VERSION,
        "items": ["batterymformer-pinn", "spm-pino", "twin-moe", "spm-fallback"],
        "itemCount": 4,
    }))
}

async fn release_status() -> Json<Value> {
    Json(json!({
        "ready": true,
        "runtime": "rust-ort",
        "productionTrafficPolicy": "dynamic-risk-route",
        "routedModels": ["battery.batterymformer-pinn", "battery.spm-pino", "battery.twin-moe"],
        "fallbackModels": ["battery.spm-fallback"],
        "modelVersion": MODEL_VERSION,
        "pinnModelVersion": PINN_MODEL_VERSION,
    }))
}

async fn pinn_inference(
    State(state): State<Arc<AppState>>,
    Json(input): Json<PinnInferenceRequest>,
) -> ApiResult {
    let output = state
        .pinn
        .infer(input)
        .map_err(|error| internal(&format!("BatteryMFormer PINN 推理失败：{error}")))?;
    Ok(Json(json!({
        "runtime": "rust-ort",
        "modelVersion": PINN_MODEL_VERSION,
        "output": output,
    })))
}

async fn twin_status(State(state): State<Arc<AppState>>) -> Json<Value> {
    let active = state.twins.read().map_or(0, |twins| twins.len());
    Json(json!({
        "status": "ready",
        "runtime": "rust-ort",
        "activeTwins": active,
        "experts": ["electrothermal", "spm-pino", "spm-conservation"],
        "router": "twin-moe-risk-route-v1",
        "capabilities": ["state-assimilation", "short-horizon-multiphysics", "domain-guard", "gated-transfer-calibration", "risk-uncertainty-envelope", "shadow-clf-cbf", "evidence-replay"],
        "validationRange": {
            "chemistry": ["lfp"],
            "horizonMinutes": [0.25, 10.0],
            "currentCRate": [-1.8, 1.8],
            "temperatureC": [10.0, 45.0],
            "initialSocPct": [20.0, 85.0],
        },
    }))
}

async fn initialize(
    State(state): State<Arc<AppState>>,
    Json(input): Json<InitializeRequest>,
) -> ApiResult {
    validate_range(
        input.nominal_capacity_ah,
        f32::EPSILON,
        2000.0,
        "nominal_capacity_ah",
    )?;
    validate_range(input.soh, 0.5, 1.05, "soh")?;
    validate_range(input.soc, 0.0, 1.0, "soc")?;
    validate_range(input.temperature_c, -30.0, 80.0, "temperature_c")?;
    if !["lfp", "ncm", "na-ion"].contains(&input.chemistry.as_str()) {
        return bad_request("不支持的化学体系");
    }
    let now = epoch_seconds();
    let twin_id = format!("twin-{}", Uuid::new_v4());
    let twin_state = TwinState {
        chemistry: input.chemistry,
        nominal_capacity_ah: input.nominal_capacity_ah,
        soh: input.soh,
        soc: input.soc,
        temperature_c: input.temperature_c,
        created_at: now,
        updated_at: now,
        transfer_context: input.transfer_context,
    };
    state.twins.write().map_err(lock_error)?.insert(
        twin_id.clone(),
        TwinRecord {
            state: twin_state.clone(),
            evidence: None,
            simulation_count: 0,
            assimilation_count: 0,
        },
    );
    Ok(Json(
        json!({ "twinId": twin_id, "state": twin_state, "runtime": "rust-ort" }),
    ))
}

async fn simulate(
    State(state): State<Arc<AppState>>,
    Json(input): Json<SimulateRequest>,
) -> ApiResult {
    validate_twin_id(&input.twin_id)?;
    if input.scenario_name.trim().is_empty() || input.scenario_name.chars().count() > 80 {
        return bad_request("scenario_name 必须包含 1–80 个字符");
    }
    if input.segments.is_empty() || input.segments.len() > 12 {
        return bad_request("segments 必须包含 1–12 个工况片段");
    }
    validate_range(input.resolution_minutes, 0.25, 10.0, "resolution_minutes")?;
    if !["dynamic", "both"].contains(&input.execution_mode.as_str()) {
        return bad_request("execution_mode 必须为 dynamic 或 both");
    }
    for segment in &input.segments {
        validate_range(
            segment.duration_minutes,
            f32::EPSILON,
            120.0,
            "duration_minutes",
        )?;
        validate_range(segment.current_c_rate, -3.0, 3.0, "current_c_rate")?;
        if let Some(value) = segment.ambient_temperature_c {
            validate_range(value, -30.0, 80.0, "ambient_temperature_c")?;
        }
    }
    let total_duration = input
        .segments
        .iter()
        .map(|segment| segment.duration_minutes)
        .sum::<f32>();
    if total_duration > 120.0 {
        return bad_request("短时数字孪生总时长不能超过 120 分钟");
    }
    let twin_state = state
        .twins
        .read()
        .map_err(lock_error)?
        .get(&input.twin_id)
        .map(|item| item.state.clone())
        .ok_or_else(|| not_found("数字孪生实例不存在或运行时已重启"))?;
    let mut result = simulation::simulate(
        &state.runtime,
        &twin_state,
        &input.segments,
        &input.scenario_name,
        &input.execution_mode,
        input.resolution_minutes,
    )
    .map_err(|error| internal(&format!("SPM-PINO 推理失败：{error}")))?;
    result["twinId"] = Value::String(input.twin_id.clone());
    result["executionMode"] = Value::String(input.execution_mode);
    if let Some(record) = state
        .twins
        .write()
        .map_err(lock_error)?
        .get_mut(&input.twin_id)
    {
        record.simulation_count += 1;
        record.evidence = Some(json!({
            "scenarioName": result["scenarioName"],
            "summary": result["summary"],
            "routing": result["routing"],
            "domain": result["domain"],
            "evidence": result["evidence"],
            "safetyProjection": result["safetyProjection"],
            "warnings": result["warnings"],
        }));
    }
    Ok(Json(result))
}

async fn assimilate(
    State(state): State<Arc<AppState>>,
    Json(input): Json<AssimilateRequest>,
) -> ApiResult {
    validate_twin_id(&input.twin_id)?;
    let mut twins = state.twins.write().map_err(lock_error)?;
    let record = twins
        .get_mut(&input.twin_id)
        .ok_or_else(|| not_found("数字孪生实例不存在或运行时已重启"))?;
    if let Some(value) = input.soc {
        validate_range(value, 0.0, 1.0, "soc")?;
        record.state.soc = value;
    }
    if let Some(value) = input.soh {
        validate_range(value, 0.5, 1.05, "soh")?;
        record.state.soh = value;
    }
    if let Some(value) = input.temperature_c {
        validate_range(value, -30.0, 80.0, "temperature_c")?;
        record.state.temperature_c = value;
    }
    record.state.updated_at = epoch_seconds();
    record.assimilation_count += 1;
    Ok(Json(
        json!({ "twinId": input.twin_id, "state": record.state, "runtime": "rust-ort" }),
    ))
}

async fn evidence(State(state): State<Arc<AppState>>, Path(twin_id): Path<String>) -> ApiResult {
    validate_twin_id(&twin_id)?;
    let twins = state.twins.read().map_err(lock_error)?;
    let record = twins
        .get(&twin_id)
        .ok_or_else(|| not_found("数字孪生实例不存在或运行时已重启"))?;
    Ok(Json(json!({
        "twinId": twin_id,
        "state": record.state,
        "lastSimulation": record.evidence,
        "simulationCount": record.simulation_count,
        "assimilationCount": record.assimilation_count,
        "runtime": "rust-ort",
    })))
}

fn validate_range(
    value: f32,
    minimum: f32,
    maximum: f32,
    name: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    if value.is_finite() && value >= minimum && value <= maximum {
        Ok(())
    } else {
        bad_request(&format!("{name} 超出允许范围"))
    }
}

fn validate_twin_id(twin_id: &str) -> Result<(), (StatusCode, Json<Value>)> {
    if twin_id.trim().chars().count() >= 8 {
        Ok(())
    } else {
        bad_request("twin_id 必须至少包含 8 个字符")
    }
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_secs())
}
fn bad_request<T>(message: &str) -> Result<T, (StatusCode, Json<Value>)> {
    Err((StatusCode::BAD_REQUEST, Json(json!({ "detail": message }))))
}
fn not_found(message: &str) -> (StatusCode, Json<Value>) {
    (StatusCode::NOT_FOUND, Json(json!({ "detail": message })))
}
fn internal(message: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "detail": message })),
    )
}
fn lock_error<T>(_error: T) -> (StatusCode, Json<Value>) {
    internal("运行时状态锁不可用")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_numeric_ranges() {
        assert!(validate_range(0.5, 0.0, 1.0, "soc").is_ok());
        assert!(validate_range(f32::NAN, 0.0, 1.0, "soc").is_err());
        assert!(validate_range(2.0, 0.0, 1.0, "soc").is_err());
    }

    #[test]
    fn validates_twin_identifiers() {
        assert!(validate_twin_id("twin-12345678").is_ok());
        assert!(validate_twin_id("short").is_err());
    }
}
