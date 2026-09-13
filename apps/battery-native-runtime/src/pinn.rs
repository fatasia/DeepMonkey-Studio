use std::{path::Path, sync::Mutex};

use anyhow::{Context, Result, anyhow};
use ort::{session::Session, value::Tensor};

use crate::types::{PinnInferenceOutput, PinnInferenceRequest};

pub const MODEL_VERSION: &str = "batterymformer-spm-pinn-v9-fieldcal-seed7181";
const EARLY_CYCLES: usize = 100;
const CURVE_LENGTH: usize = 300;
const CONDITION_SIZE: usize = 1024;
const PHYSICS_CONDITION_SIZE: usize = 11;
const PREDICTION_LENGTH: usize = 5000;

pub struct PinnRuntime {
    session: Mutex<Session>,
}

impl PinnRuntime {
    pub fn load(model_path: &Path) -> Result<Self> {
        let session = Session::builder()
            .context("无法创建 PINN ONNX Runtime 会话")?
            .with_intra_threads(2)
            .map_err(|error| anyhow!(error.to_string()))?
            .commit_from_file(model_path)
            .with_context(|| format!("无法加载 {}", model_path.display()))?;
        Ok(Self {
            session: Mutex::new(session),
        })
    }

    pub fn infer(&self, input: PinnInferenceRequest) -> Result<PinnInferenceOutput> {
        validate_lengths(&input)?;
        ensure_finite(&input.curves, "curves")?;
        ensure_finite(&input.curve_mask, "curve_mask")?;
        ensure_finite(&input.condition_embedding, "condition_embedding")?;
        ensure_finite(&input.soh_input, "soh_input")?;
        ensure_finite(&input.cycle_features, "cycle_features")?;
        ensure_finite(&input.physics_condition, "physics_condition")?;
        let mut session = self
            .session
            .lock()
            .map_err(|_| anyhow!("PINN 会话锁已损坏"))?;
        let outputs = session.run(ort::inputs! {
            "curves" => Tensor::from_array(([1, EARLY_CYCLES, 4, CURVE_LENGTH], input.curves))?,
            "curve_mask" => Tensor::from_array(([1, EARLY_CYCLES], input.curve_mask))?,
            "condition_embedding" => Tensor::from_array(([1, 1, CONDITION_SIZE], input.condition_embedding))?,
            "soh_input" => Tensor::from_array(([1, EARLY_CYCLES, 1], input.soh_input))?,
            "cycle_features" => Tensor::from_array(([1, EARLY_CYCLES, 2], input.cycle_features))?,
            "physics_condition" => Tensor::from_array(([1, PHYSICS_CONDITION_SIZE], input.physics_condition))?,
        })?;
        let soh_trajectory = tensor_values(&outputs["soh_trajectory"])?;
        let physical_soh = tensor_values(&outputs["physical_soh"])?;
        if soh_trajectory.len() != PREDICTION_LENGTH || physical_soh.len() != PREDICTION_LENGTH {
            return Err(anyhow!("PINN 输出轨迹长度不符合合同"));
        }
        Ok(PinnInferenceOutput {
            soh_trajectory,
            physical_soh,
            physics_gate: scalar(&outputs["physics_gate"], "physics_gate")?,
            identifiability_score: scalar(
                &outputs["identifiability_score"],
                "identifiability_score",
            )?,
            physical_observation_rmse: scalar(
                &outputs["physical_observation_rmse"],
                "physical_observation_rmse",
            )?,
            physical_fit_score: scalar(&outputs["physical_fit_score"], "physical_fit_score")?,
            nominal_capacity_ah: scalar(&outputs["nominal_capacity_ah"], "nominal_capacity_ah")?,
            equivalent_resistance_ohm: scalar(
                &outputs["equivalent_resistance_ohm"],
                "equivalent_resistance_ohm",
            )?,
            effective_diffusion_time_hours: tensor_values(&outputs["effective_diffusion_time_h"])?,
            normalized_fade_rate_per_cycle: scalar(
                &outputs["degradation_rate"],
                "degradation_rate",
            )?,
            chemistry_fade_scale: scalar(&outputs["chemistry_fade_scale"], "chemistry_fade_scale")?,
            ocv_minimum_v: scalar(&outputs["ocv_min_v"], "ocv_min_v")?,
            ocv_span_v: scalar(&outputs["ocv_span_v"], "ocv_span_v")?,
            exchange_c_rate: scalar(&outputs["exchange_c_rate"], "exchange_c_rate")?,
            overpotential_scale_v: scalar(
                &outputs["overpotential_scale_v"],
                "overpotential_scale_v",
            )?,
        })
    }
}

fn validate_lengths(input: &PinnInferenceRequest) -> Result<()> {
    let expected = [
        (
            input.curves.len(),
            EARLY_CYCLES * 4 * CURVE_LENGTH,
            "curves",
        ),
        (input.curve_mask.len(), EARLY_CYCLES, "curve_mask"),
        (
            input.condition_embedding.len(),
            CONDITION_SIZE,
            "condition_embedding",
        ),
        (input.soh_input.len(), EARLY_CYCLES, "soh_input"),
        (
            input.cycle_features.len(),
            EARLY_CYCLES * 2,
            "cycle_features",
        ),
        (
            input.physics_condition.len(),
            PHYSICS_CONDITION_SIZE,
            "physics_condition",
        ),
    ];
    for (actual, wanted, name) in expected {
        if actual != wanted {
            return Err(anyhow!("{name} 长度应为 {wanted}，实际为 {actual}"));
        }
    }
    Ok(())
}

fn ensure_finite(values: &[f32], name: &str) -> Result<()> {
    if values.iter().all(|value| value.is_finite()) {
        Ok(())
    } else {
        Err(anyhow!("{name} 包含非有限值"))
    }
}

fn scalar(value: &ort::value::DynValue, name: &str) -> Result<f32> {
    tensor_values(value)?
        .first()
        .copied()
        .ok_or_else(|| anyhow!("PINN 输出 {name} 为空"))
}

fn tensor_values(value: &ort::value::DynValue) -> Result<Vec<f32>> {
    let (_, values) = value.try_extract_tensor::<f32>()?;
    let result = values.to_vec();
    ensure_finite(&result, "PINN output")?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_wrong_tensor_lengths() {
        let input = PinnInferenceRequest {
            curves: vec![],
            curve_mask: vec![],
            condition_embedding: vec![],
            soh_input: vec![],
            cycle_features: vec![],
            physics_condition: vec![],
        };
        assert!(validate_lengths(&input).is_err());
    }
}
