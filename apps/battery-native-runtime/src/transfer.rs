use serde_json::{Value, json};

#[derive(Clone, Debug)]
pub struct TransferCalibration {
    kind: String,
    voltage_coefficients: Vec<f32>,
    soc_coefficients_pct: Vec<f32>,
    voltage_bias_v: f32,
    soc_bias_pct: f32,
    voltage_limit_v: f32,
    soc_limit_pct: f32,
    similarity: f32,
    validation_gain_pct: f32,
    fit_target: Option<String>,
    model_version: Option<String>,
}

impl TransferCalibration {
    pub fn correction(
        &self,
        current_c_rate: f32,
        temperature_c: f32,
        soc: f32,
        soh: f32,
    ) -> (f32, f32) {
        if self.voltage_coefficients.is_empty() {
            return (self.voltage_bias_v, self.soc_bias_pct);
        }
        let current = (current_c_rate / 2.0).clamp(-1.5, 1.5);
        let temperature = ((temperature_c - 25.0) / 25.0).clamp(-1.5, 1.5);
        let soc_feature = ((soc - 0.5) / 0.5).clamp(-1.0, 1.0);
        let soh_feature = ((soh - 0.8) / 0.2).clamp(-1.0, 1.0);
        let mut features = vec![
            1.0,
            current,
            temperature,
            soc_feature,
            soh_feature,
            current * temperature,
            current * soc_feature,
        ];
        if self.kind == "bounded-nonlinear-residual-v3" {
            features.extend([
                temperature * soc_feature,
                current * soh_feature,
                current * current,
                temperature * temperature,
                soc_feature * soc_feature,
                soh_feature * soh_feature,
                (1.5 * current).tanh(),
                (1.5 * temperature).tanh(),
            ]);
        }
        let voltage = dot(&features, &self.voltage_coefficients)
            .clamp(-self.voltage_limit_v, self.voltage_limit_v);
        let soc_pct = dot(&features, &self.soc_coefficients_pct)
            .clamp(-self.soc_limit_pct, self.soc_limit_pct);
        (voltage, soc_pct)
    }

    pub fn evidence(&self) -> Value {
        json!({
            "kind": self.kind,
            "fitTarget": self.fit_target,
            "modelVersion": self.model_version,
            "similarity": self.similarity,
            "validationGainPct": self.validation_gain_pct,
            "voltageLimitV": self.voltage_limit_v,
            "socLimitPct": self.soc_limit_pct,
        })
    }

    pub fn similarity(&self) -> f32 {
        self.similarity
    }

    pub fn validation_gain_pct(&self) -> f32 {
        self.validation_gain_pct
    }
}

pub fn accepted_transfer_calibration(context: &Option<Value>) -> Option<TransferCalibration> {
    let context = context.as_ref()?.as_object()?;
    let calibration = context.get("calibration")?.as_object()?;
    let similarity = number(context, "adapter_similarity", "adapterSimilarity")?;
    let validation_gain_pct = number(context, "validation_gain_pct", "validationGainPct")?;
    if similarity < 0.70 || validation_gain_pct < 2.0 {
        return None;
    }
    let kind =
        string(calibration, "kind", "kind").unwrap_or_else(|| "bounded-output-residual".into());
    let fit_target = string(calibration, "fit_target", "fitTarget");
    let model_version = string(calibration, "model_version", "modelVersion");
    if matches!(
        kind.as_str(),
        "conditional-linear-residual-v2" | "bounded-nonlinear-residual-v3"
    ) {
        let expected = if kind == "bounded-nonlinear-residual-v3" {
            15
        } else {
            7
        };
        let voltage_coefficients =
            numbers(calibration, "voltage_coefficients", "voltageCoefficients")?;
        let soc_coefficients_pct =
            numbers(calibration, "soc_coefficients_pct", "socCoefficientsPct")?;
        if voltage_coefficients.len() != expected || soc_coefficients_pct.len() != expected {
            return None;
        }
        let limits = calibration.get("limits")?.as_object()?;
        let voltage_limit_v = number(limits, "voltage_v", "voltageV")?;
        let soc_limit_pct = number(limits, "soc_pct", "socPct")?;
        if !(0.0 < voltage_limit_v
            && voltage_limit_v <= 0.15
            && 0.0 < soc_limit_pct
            && soc_limit_pct <= 8.0)
        {
            return None;
        }
        return Some(TransferCalibration {
            kind,
            voltage_coefficients,
            soc_coefficients_pct,
            voltage_bias_v: 0.0,
            soc_bias_pct: 0.0,
            voltage_limit_v,
            soc_limit_pct,
            similarity,
            validation_gain_pct,
            fit_target,
            model_version,
        });
    }
    let voltage_bias_v = number(calibration, "voltage_bias_v", "voltageBiasV").unwrap_or(0.0);
    let soc_bias_pct = number(calibration, "soc_bias_pct", "socBiasPct").unwrap_or(0.0);
    if voltage_bias_v.abs() > 0.15 || soc_bias_pct.abs() > 8.0 {
        return None;
    }
    Some(TransferCalibration {
        kind,
        voltage_coefficients: Vec::new(),
        soc_coefficients_pct: Vec::new(),
        voltage_bias_v,
        soc_bias_pct,
        voltage_limit_v: 0.15,
        soc_limit_pct: 8.0,
        similarity,
        validation_gain_pct,
        fit_target,
        model_version,
    })
}

fn number(values: &serde_json::Map<String, Value>, snake: &str, camel: &str) -> Option<f32> {
    values
        .get(snake)
        .or_else(|| values.get(camel))?
        .as_f64()
        .map(|value| value as f32)
        .filter(|value| value.is_finite())
}

fn numbers(values: &serde_json::Map<String, Value>, snake: &str, camel: &str) -> Option<Vec<f32>> {
    values
        .get(snake)
        .or_else(|| values.get(camel))?
        .as_array()?
        .iter()
        .map(|value| {
            value
                .as_f64()
                .map(|item| item as f32)
                .filter(|item| item.is_finite())
        })
        .collect()
}

fn string(values: &serde_json::Map<String, Value>, snake: &str, camel: &str) -> Option<String> {
    values
        .get(snake)
        .or_else(|| values.get(camel))?
        .as_str()
        .map(str::to_owned)
}

fn dot(left: &[f32], right: &[f32]) -> f32 {
    left.iter().zip(right).map(|(a, b)| a * b).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> Option<Value> {
        Some(json!({
            "adapter_similarity": 0.92,
            "validation_gain_pct": 18.0,
            "calibration": {
                "kind": "conditional-linear-residual-v2",
                "fit_target": "pino",
                "model_version": "pino-test",
                "voltage_coefficients": [0.01, 0.04, 0.03, 0.02, 0.01, 0.02, -0.01],
                "soc_coefficients_pct": [0.5, 1.2, -0.8, 0.7, 0.3, 0.4, -0.2],
                "limits": { "voltage_v": 0.15, "soc_pct": 8.0 }
            }
        }))
    }

    #[test]
    fn accepts_gated_conditioned_calibration() {
        let calibration = accepted_transfer_calibration(&context()).expect("accepted calibration");
        assert_ne!(
            calibration.correction(0.2, 25.0, 0.5, 0.95),
            calibration.correction(2.0, 55.0, 0.8, 0.8)
        );
        assert_eq!(
            calibration.evidence()["kind"],
            "conditional-linear-residual-v2"
        );
    }

    #[test]
    fn rejects_unvalidated_calibration() {
        let mut invalid = context().expect("context");
        invalid["validation_gain_pct"] = json!(1.0);
        assert!(accepted_transfer_calibration(&Some(invalid)).is_none());
    }
}
