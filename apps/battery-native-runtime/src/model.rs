use std::{path::Path, sync::Mutex};

use anyhow::{Context, Result, anyhow};
use ort::{session::Session, value::Tensor};

use crate::types::{PinoOutput, ProfilePoint, TwinState};

pub const TIME_STEPS: usize = 64;
pub const MODEL_VERSION: &str = "spm-pino-v13.6-native-v10-guard";

pub struct PinoRuntime {
    session: Mutex<Session>,
}

impl PinoRuntime {
    pub fn load(model_path: &Path) -> Result<Self> {
        let session = Session::builder()
            .context("无法创建 ONNX Runtime 会话")?
            .with_intra_threads(2)
            .map_err(|error| anyhow!(error.to_string()))?
            .commit_from_file(model_path)
            .with_context(|| format!("无法加载 {}", model_path.display()))?;
        Ok(Self {
            session: Mutex::new(session),
        })
    }

    pub fn infer(&self, state: &TwinState, profile: &[ProfilePoint]) -> Result<PinoOutput> {
        if profile.len() != TIME_STEPS {
            return Err(anyhow!("PINO 输入必须为 {TIME_STEPS} 个时间步"));
        }
        let duration_minutes = profile
            .last()
            .map_or(0.0, |point| point.time_minutes)
            .max(0.01);
        let horizon_scale = duration_minutes * 60.0 / 240.0;
        let current = profile
            .iter()
            .map(|point| point.current_c_rate)
            .collect::<Vec<_>>();
        let temperature = profile
            .iter()
            .map(|point| point.ambient_temperature_c)
            .collect::<Vec<_>>();
        let mut delta = vec![1.0 / (TIME_STEPS - 1) as f32; TIME_STEPS];
        delta[0] = 0.0;
        let initial = vec![0.10 + 0.78 * state.soc, 0.88 - 0.55 * state.soc];
        let diffusivity = vec![0.030 * horizon_scale, 0.260 * horizon_scale];
        let flux = vec![0.00583 * horizon_scale, 0.00996 * horizon_scale];
        let mut session = self
            .session
            .lock()
            .map_err(|_| anyhow!("PINO 会话锁已损坏"))?;
        let outputs = session.run(ort::inputs! {
            "current_c_rate" => Tensor::from_array(([1, TIME_STEPS], current))?,
            "temperature_c" => Tensor::from_array(([1, TIME_STEPS], temperature))?,
            "delta_time" => Tensor::from_array(([1, TIME_STEPS], delta))?,
            "initial_concentration" => Tensor::from_array(([1, 2], initial))?,
            "diffusivity" => Tensor::from_array(([1, 2], diffusivity))?,
            "surface_flux_scale" => Tensor::from_array(([1, 2], flux))?,
            "chemistry_index" => Tensor::from_array(([1], vec![5_i64]))?,
            "initial_soc" => Tensor::from_array(([1], vec![state.soc]))?,
            "duration_hours" => Tensor::from_array(([1], vec![duration_minutes / 60.0]))?,
            "capacity_ratio" => Tensor::from_array(([1], vec![state.soh.clamp(0.5, 1.1)]))?,
        })?;
        let voltage = tensor_values(&outputs["voltage_v"])?;
        let learned_soc = tensor_values(&outputs["soc"])?;
        let first_soc = *learned_soc
            .first()
            .ok_or_else(|| anyhow!("PINO SOC 输出为空"))?;
        let soc = learned_soc
            .into_iter()
            .map(|value| (state.soc + value - first_soc).clamp(0.0, 1.0))
            .collect();
        let temperature = tensor_values(&outputs["temperature_out_c"])?;
        let weights = tensor_values(&outputs["route_weights"])?;
        Ok(PinoOutput {
            voltage,
            soc,
            temperature,
            fast_weight: *weights.first().unwrap_or(&1.0),
            operator_weight: *weights.get(1).unwrap_or(&0.0),
            risk_features: tensor_values(&outputs["route_risk_features"])?,
        })
    }
}

fn tensor_values(value: &ort::value::DynValue) -> Result<Vec<f32>> {
    let (_, values) = value.try_extract_tensor::<f32>()?;
    Ok(values.to_vec())
}
