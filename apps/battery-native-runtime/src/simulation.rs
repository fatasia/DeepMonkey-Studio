use serde_json::{Value, json};

use crate::{
    model::{MODEL_VERSION, PinoRuntime, TIME_STEPS},
    physics::ocv,
    safety,
    transfer::{TransferCalibration, accepted_transfer_calibration},
    types::{PinoOutput, ProfilePoint, Segment, TwinState},
};

pub fn profile(segments: &[Segment], default_temperature: f32) -> Vec<ProfilePoint> {
    let total = segments
        .iter()
        .map(|item| item.duration_minutes)
        .sum::<f32>()
        .max(0.01);
    (0..TIME_STEPS)
        .map(|index| {
            let time = total * index as f32 / (TIME_STEPS - 1) as f32;
            let mut elapsed = 0.0;
            let segment = segments
                .iter()
                .find(|item| {
                    elapsed += item.duration_minutes;
                    time <= elapsed
                })
                .unwrap_or_else(|| segments.last().expect("validated non-empty segments"));
            ProfilePoint {
                time_minutes: time,
                current_c_rate: segment.current_c_rate,
                ambient_temperature_c: segment.ambient_temperature_c.unwrap_or(default_temperature),
            }
        })
        .collect()
}

pub fn simulate(
    runtime: &PinoRuntime,
    state: &TwinState,
    segments: &[Segment],
    scenario: &str,
    execution_mode: &str,
    requested_resolution_minutes: f32,
) -> anyhow::Result<Value> {
    let points = profile(segments, state.temperature_c);
    let total_minutes = points.last().map_or(0.0, |point| point.time_minutes);
    let out_of_domain = domain_reasons(state, segments, total_minutes);
    let calibration = accepted_transfer_calibration(&state.transfer_context);
    let adapted_domain = !out_of_domain.is_empty() && calibration.is_some();
    let fallback = execution_mode == "dynamic" && !out_of_domain.is_empty() && !adapted_domain;
    let baseline = baseline(state, &points);
    let mut pino = if fallback {
        None
    } else {
        Some(runtime.infer(state, &points)?)
    };
    let correction_trace =
        apply_transfer_calibration(pino.as_mut(), &points, state, calibration.as_ref());
    let risk_score = pino
        .as_ref()
        .map_or(0.0, |output| normalized_risk(&output.risk_features));
    let fast_weight = pino.as_ref().map_or(0.0, |output| output.fast_weight);
    let operator_weight = pino.as_ref().map_or(0.0, |output| output.operator_weight);
    let qualified = !fallback
        && (out_of_domain.is_empty() || adapted_domain)
        && (operator_weight >= 0.75 || risk_score >= 3.0);
    let uncertainty_pct = if fallback {
        3.0
    } else {
        (1.5 + 1.5 * risk_score).min(12.0)
    };
    let candidate_engine = if fallback {
        "spm-conservation-solver"
    } else {
        "spm-pino-transformer"
    };
    let route_path = if fallback {
        vec!["验证域判断", "SPM 守恒回退"]
    } else if qualified {
        vec!["验证域判断", "SPM-PINO 多物理算子", "TwinMoE 采纳"]
    } else {
        vec!["验证域判断", "SPM-PINO 双专家", "电热基线保留"]
    };
    let output_points = points.iter().enumerate().map(|(index, point)| {
        let (baseline_soc, baseline_voltage, baseline_temperature) = baseline[index];
        let pino_soc = pino.as_ref().map_or(baseline_soc, |output| output.soc[index]);
        let pino_voltage = pino.as_ref().map_or_else(
            || ocv(&state.chemistry, pino_soc),
            |output| output.voltage[index],
        );
        json!({
            "timeMinutes": point.time_minutes,
            "currentCRate": point.current_c_rate,
            "ambientTemperatureC": point.ambient_temperature_c,
            "baselineSocPct": baseline_soc * 100.0,
            "baselineVoltageV": baseline_voltage,
            "pinoSocPct": pino_soc * 100.0,
            "pinoSocLowPct": (pino_soc * 100.0 - uncertainty_pct).max(0.0),
            "pinoSocHighPct": (pino_soc * 100.0 + uncertainty_pct).min(100.0),
            "pinoVoltageV": pino_voltage,
            "temperatureC": pino.as_ref().map_or(baseline_temperature, |output| output.temperature[index]),
        })
    }).collect::<Vec<_>>();
    let final_baseline = baseline.last().map_or(state.soc, |value| value.0) * 100.0;
    let final_candidate = output_points
        .last()
        .and_then(|point| point["pinoSocPct"].as_f64())
        .unwrap_or(f64::from(final_baseline));
    let safety_projection = safety::project_profile_shadow(state, segments);
    let warnings = warnings(&out_of_domain, adapted_domain, fallback, &safety_projection);
    let calibration_evidence = calibration.as_ref().map(TransferCalibration::evidence);
    let calibration_gain = calibration
        .as_ref()
        .map(|value| value.validation_gain_pct() / 100.0);
    let max_voltage = maximum(&output_points, "baselineVoltageV");
    let candidate_max_voltage = maximum(&output_points, "pinoVoltageV");
    let max_temperature = maximum(&output_points, "temperatureC");
    Ok(json!({
        "twinId": null,
        "scenarioName": scenario,
        "status": "native-candidate",
        "primaryEngine": "electro-thermal-baseline",
        "candidateEngine": candidate_engine,
        "points": output_points,
        "summary": {
            "durationMinutes": total_minutes,
            "initialSocPct": state.soc * 100.0,
            "finalSocPct": final_baseline,
            "candidateFinalSocPct": final_candidate,
            "maxVoltageV": max_voltage,
            "candidateMaxVoltageV": candidate_max_voltage,
            "maxTemperatureC": max_temperature,
            "throughputAh": throughput_ah(state, &points),
            "physicsRiskScore": risk_score,
            "uncertaintyHalfWidthPct": uncertainty_pct,
        },
        "routing": {
            "shadowCandidateQualified": qualified,
            "fastWeight": fast_weight,
            "operatorWeight": operator_weight,
            "riskScore": risk_score,
            "routePath": route_path,
            "netBenefit": {
                "source": if calibration.is_some() { "held-out-adapter-validation" } else { "native-model-gates" },
                "expectedAccuracyGain": calibration_gain,
                "computePenalty": if pino.is_some() { 0.03 } else { 0.0 },
                "positive": calibration_gain.is_none_or(|gain| gain > 0.03),
            },
        },
        "domain": {
            "status": if adapted_domain { "adapted-domain" } else if out_of_domain.is_empty() { "in-domain" } else { "out-of-domain" },
            "reasons": out_of_domain,
            "validationRange": validation_range(),
            "calibration": {
                "requested": state.transfer_context.is_some(),
                "applied": calibration.is_some() && pino.is_some(),
                "status": if fallback { "solver-fallback" } else if calibration.is_some() { "calibrated-pino" } else { "native-pino" },
                "similarity": calibration.as_ref().map(TransferCalibration::similarity),
                "validationGainPct": calibration.as_ref().map(TransferCalibration::validation_gain_pct),
            },
        },
        "evidence": {
            "runtime": "rust-ort",
            "modelVersion": MODEL_VERSION,
            "fallbackActivated": fallback,
            "fallbackReasons": if fallback { json!(out_of_domain) } else { json!([]) },
            "outOfDomain": !out_of_domain.is_empty(),
            "adaptedDomain": adapted_domain,
            "routeRiskFeatures": pino.as_ref().map_or_else(Vec::new, |output| output.risk_features.clone()),
            "uncertaintyMethod": if fallback { "spm-fixed-envelope" } else { "twin-moe-risk-envelope-v1" },
            "transferCalibrationApplied": calibration.is_some() && pino.is_some(),
            "transferCalibration": calibration_evidence,
            "transferCorrectionTrace": correction_trace,
            "profileSampling": { "requestedResolutionMinutes": requested_resolution_minutes, "modelTimeSteps": TIME_STEPS },
        },
        "safetyProjection": safety_projection,
        "warnings": warnings,
    }))
}

fn apply_transfer_calibration(
    output: Option<&mut PinoOutput>,
    profile: &[ProfilePoint],
    state: &TwinState,
    calibration: Option<&TransferCalibration>,
) -> Vec<Value> {
    let (Some(output), Some(calibration)) = (output, calibration) else {
        return Vec::new();
    };
    profile.iter().enumerate().map(|(index, point)| {
        let (voltage_delta, soc_delta_pct) = calibration.correction(
            point.current_c_rate, point.ambient_temperature_c, output.soc[index], state.soh,
        );
        let ramp = index as f32 / (profile.len() - 1).max(1) as f32;
        output.soc[index] = (output.soc[index] + ramp * soc_delta_pct / 100.0).clamp(0.0, 1.0);
        output.voltage[index] += voltage_delta;
        json!({ "timeMinutes": point.time_minutes, "voltageDeltaV": voltage_delta, "socDeltaPct": ramp * soc_delta_pct })
    }).collect()
}

fn baseline(state: &TwinState, profile: &[ProfilePoint]) -> Vec<(f32, f32, f32)> {
    let mut soc = state.soc;
    let mut temperature = state.temperature_c;
    let mut previous = 0.0;
    profile
        .iter()
        .map(|point| {
            let delta_hours = (point.time_minutes - previous).max(0.0) / 60.0;
            previous = point.time_minutes;
            soc = (soc + point.current_c_rate * delta_hours / state.soh.max(0.5)).clamp(0.0, 1.0);
            temperature += (point.current_c_rate.powi(2) * 0.08
                - (temperature - point.ambient_temperature_c) * 0.04)
                * delta_hours;
            (
                soc,
                ocv(&state.chemistry, soc) + point.current_c_rate * 0.025,
                temperature,
            )
        })
        .collect()
}

fn domain_reasons(state: &TwinState, segments: &[Segment], total: f32) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if state.chemistry != "lfp" {
        reasons.push("当前 PINO 制品仅覆盖 LFP")
    }
    if total > 10.0 {
        reasons.push("推演时域超过 PINO 验证上限 10 分钟")
    }
    if segments.iter().any(|item| item.current_c_rate.abs() > 1.8) {
        reasons.push("倍率超过 PINO 训练主要范围 1.8C")
    }
    if segments.iter().any(|item| {
        item.ambient_temperature_c
            .is_some_and(|value| !(10.0..=45.0).contains(&value))
    }) {
        reasons.push("环境温度超出 PINO 训练范围 10–45°C")
    }
    if !(0.20..=0.85).contains(&state.soc) {
        reasons.push("初始 SOC 超出 PINO 主要范围 20%–85%")
    }
    reasons
}

fn normalized_risk(features: &[f32]) -> f32 {
    let scales = [0.15, 0.08, 0.08, 0.80, 0.75, 1.20];
    features
        .iter()
        .take(scales.len())
        .zip(scales)
        .map(|(value, scale)| value.abs() / scale)
        .fold(0.0, f32::max)
}

fn throughput_ah(state: &TwinState, profile: &[ProfilePoint]) -> f32 {
    let mut previous = 0.0;
    profile
        .iter()
        .map(|point| {
            let delta = (point.time_minutes - previous).max(0.0);
            previous = point.time_minutes;
            point.current_c_rate.abs() * state.nominal_capacity_ah * delta / 60.0
        })
        .sum()
}

fn maximum(points: &[Value], key: &str) -> f64 {
    points
        .iter()
        .filter_map(|point| point[key].as_f64())
        .fold(f64::NEG_INFINITY, f64::max)
}

fn validation_range() -> Value {
    json!({ "chemistry": ["lfp"], "horizonMinutes": [0.25, 10.0], "currentCRate": [-1.8, 1.8], "temperatureC": [10.0, 45.0], "initialSocPct": [20.0, 85.0] })
}

fn warnings(reasons: &[&str], adapted: bool, fallback: bool, safety: &Value) -> Vec<String> {
    let mut output = Vec::new();
    if fallback {
        output.push(format!(
            "PINO 验证域外，已由 SPM 守恒求解器接管：{}",
            reasons.join("；")
        ))
    } else if adapted {
        output.push("验证域外工况已应用独立留出门禁通过的迁移校准。".into())
    } else if !reasons.is_empty() {
        output.push(format!(
            "PINO 验证域外，仅保留分歧观察：{}",
            reasons.join("；")
        ))
    }
    if safety["interventionCount"].as_u64().unwrap_or(0) > 0 {
        output.push("影子安全投影检测到需要限幅的工况。".into())
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> TwinState {
        TwinState {
            chemistry: "lfp".into(),
            nominal_capacity_ah: 100.0,
            soh: 0.95,
            soc: 0.5,
            temperature_c: 25.0,
            created_at: 0,
            updated_at: 0,
            transfer_context: None,
        }
    }

    #[test]
    fn matches_checkpoint_validation_domain() {
        let in_domain = Segment {
            duration_minutes: 8.0,
            current_c_rate: 1.2,
            ambient_temperature_c: Some(25.0),
        };
        assert!(domain_reasons(&state(), std::slice::from_ref(&in_domain), 8.0).is_empty());
        let out = Segment {
            duration_minutes: 12.0,
            current_c_rate: 2.0,
            ambient_temperature_c: Some(50.0),
        };
        assert_eq!(domain_reasons(&state(), &[out], 12.0).len(), 3);
    }
}
