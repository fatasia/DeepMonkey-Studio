use serde_json::{Value, json};

use crate::{
    physics::{chemistry_limits, ocv},
    types::{Segment, TwinState},
};

const MIN_SOC: f32 = 0.05;
const MAX_SOC: f32 = 0.95;
const MAX_TEMPERATURE_C: f32 = 45.0;
const MAX_ABS_C_RATE: f32 = 1.8;
const TARGET_SOC: f32 = 0.80;
const CLF_CONTRACTION: f32 = 0.10;

pub fn project_profile_shadow(state: &TwinState, segments: &[Segment]) -> Value {
    let mut soc = state.soc;
    let mut temperature = state.temperature_c;
    let mut actions = Vec::with_capacity(segments.len());
    for (index, segment) in segments.iter().enumerate() {
        let action = project_current_action(state, segment, soc, temperature, index);
        soc = action["nextState"]["soc"]
            .as_f64()
            .map_or(soc, |value| value as f32);
        temperature = action["nextState"]["temperatureC"]
            .as_f64()
            .map_or(temperature, |value| value as f32);
        actions.push(action);
    }
    let intervention_count = actions
        .iter()
        .filter(|item| item["intervened"] == true)
        .count();
    let fallback_count = actions
        .iter()
        .filter(|item| item["fallbackActivated"] == true)
        .count();
    json!({
        "mode": "shadow-only",
        "productionCommandIssued": false,
        "allFeasible": actions.iter().all(|item| item["feasible"] == true),
        "interventionCount": intervention_count,
        "fallbackCount": fallback_count,
        "actions": actions,
    })
}

fn project_current_action(
    state: &TwinState,
    segment: &Segment,
    soc: f32,
    temperature_c: f32,
    segment_index: usize,
) -> Value {
    let limits = chemistry_limits(&state.chemistry);
    let hours = segment.duration_minutes / 60.0;
    let soc_gain = hours / state.soh;
    let ambient = segment.ambient_temperature_c.unwrap_or(temperature_c);
    let mut lower = -MAX_ABS_C_RATE;
    let mut upper = MAX_ABS_C_RATE;
    lower = lower.max((MIN_SOC - soc) / soc_gain);
    upper = upper.min((MAX_SOC - soc) / soc_gain);
    let resistance = 0.0015 * (1.0 + 2.0 * (1.0 - state.soh).max(0.0));
    let voltage_for = |rate: f32| {
        let next_soc = (soc + rate * soc_gain).clamp(0.0, 1.0);
        ocv(&state.chemistry, next_soc) + rate * state.nominal_capacity_ah * resistance
    };
    if voltage_for(lower) < limits.min_voltage {
        if voltage_for(upper) < limits.min_voltage {
            lower = upper + 1.0;
        } else {
            let (mut left, mut right) = (lower, upper);
            for _ in 0..60 {
                let middle = 0.5 * (left + right);
                if voltage_for(middle) < limits.min_voltage {
                    left = middle
                } else {
                    right = middle
                }
            }
            lower = lower.max(right);
        }
    }
    if lower <= upper && voltage_for(upper) > limits.max_voltage {
        if voltage_for(lower) > limits.max_voltage {
            upper = lower - 1.0;
        } else {
            let (mut left, mut right) = (lower, upper);
            for _ in 0..60 {
                let middle = 0.5 * (left + right);
                if voltage_for(middle) > limits.max_voltage {
                    right = middle
                } else {
                    left = middle
                }
            }
            upper = upper.min(left);
        }
    }
    let thermal_headroom =
        MAX_TEMPERATURE_C - temperature_c + 0.08 * (temperature_c - ambient) * hours;
    let heat_coefficient = 0.018 * state.nominal_capacity_ah.powi(2) * resistance * hours;
    if heat_coefficient > 1e-12 {
        let thermal_cap = (thermal_headroom.max(0.0) / heat_coefficient).sqrt();
        lower = lower.max(-thermal_cap);
        upper = upper.min(thermal_cap);
    }
    let target_soc = if segment.current_c_rate >= 0.0 {
        if soc <= TARGET_SOC {
            TARGET_SOC
        } else {
            MAX_SOC
        }
    } else if soc >= TARGET_SOC {
        TARGET_SOC
    } else {
        MIN_SOC
    };
    let current_error = soc - target_soc;
    let clf_radius = (1.0 - CLF_CONTRACTION).sqrt() * current_error.abs();
    lower = lower.max((target_soc - clf_radius - soc) / soc_gain);
    upper = upper.min((target_soc + clf_radius - soc) / soc_gain);
    let feasible = lower <= upper;
    let projected = if feasible {
        segment.current_c_rate.clamp(lower, upper)
    } else {
        0.0
    };
    let next_soc = (soc + projected * soc_gain).clamp(0.0, 1.0);
    let next_voltage = voltage_for(projected);
    let next_temperature = temperature_c
        + (0.018 * (projected * state.nominal_capacity_ah).powi(2) * resistance
            - 0.08 * (temperature_c - ambient))
            * hours;
    let before = (soc - target_soc).powi(2);
    let after = (next_soc - target_soc).powi(2);
    json!({
        "segmentIndex": segment_index,
        "mode": "shadow-clf-cbf-projection",
        "proposedCRate": segment.current_c_rate,
        "projectedCRate": projected,
        "intervened": (projected - segment.current_c_rate).abs() > 1e-6,
        "feasible": feasible,
        "fallbackActivated": !feasible,
        "reason": if !feasible { "CLF-CBF 约束交集为空，影子建议回退为零电流。" } else if (projected - segment.current_c_rate).abs() > 1e-6 { "候选动作已投影到 CLF-CBF 可行域。" } else { "候选动作位于可行域内。" },
        "feasibleIntervalCRate": if feasible { json!([lower, upper]) } else { Value::Null },
        "nextState": { "soc": next_soc, "voltageV": next_voltage, "temperatureC": next_temperature },
        "certificate": {
            "lyapunovBefore": before,
            "lyapunovAfter": after,
            "effectiveTargetSoc": target_soc,
            "clfPassed": after <= (1.0 - CLF_CONTRACTION) * before + 1e-6,
            "barrierMargins": {
                "socLow": next_soc - MIN_SOC,
                "socHigh": MAX_SOC - next_soc,
                "voltageLowV": next_voltage - limits.min_voltage,
                "voltageHighV": limits.max_voltage - next_voltage,
                "temperatureC": MAX_TEMPERATURE_C - next_temperature,
            },
            "activeConstraints": ["hardware-c-rate", "soc-cbf", "voltage-cbf", "temperature-cbf", "soc-clf"],
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> TwinState {
        TwinState {
            chemistry: "lfp".into(),
            nominal_capacity_ah: 100.0,
            soh: 0.9,
            soc: 0.85,
            temperature_c: 25.0,
            created_at: 0,
            updated_at: 0,
            transfer_context: None,
        }
    }

    #[test]
    fn projects_aggressive_charge() {
        let result = project_profile_shadow(
            &state(),
            &[Segment {
                duration_minutes: 30.0,
                current_c_rate: 3.0,
                ambient_temperature_c: Some(25.0),
            }],
        );
        assert_eq!(result["productionCommandIssued"], false);
        assert_eq!(result["interventionCount"], 1);
        assert!(result["actions"][0]["nextState"]["soc"].as_f64().unwrap() <= 0.950_001);
        assert_eq!(result["actions"][0]["certificate"]["clfPassed"], true);
    }
}
