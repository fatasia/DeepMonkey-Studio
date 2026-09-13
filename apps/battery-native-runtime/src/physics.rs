#[derive(Clone, Copy)]
pub struct ChemistryLimits {
    pub min_voltage: f32,
    pub max_voltage: f32,
    pub ocv_low: f32,
    pub ocv_high: f32,
}

pub fn chemistry_limits(chemistry: &str) -> ChemistryLimits {
    match chemistry {
        "lfp" => ChemistryLimits {
            min_voltage: 2.8,
            max_voltage: 3.65,
            ocv_low: 3.12,
            ocv_high: 3.43,
        },
        "na-ion" => ChemistryLimits {
            min_voltage: 2.0,
            max_voltage: 4.0,
            ocv_low: 2.35,
            ocv_high: 3.85,
        },
        _ => ChemistryLimits {
            min_voltage: 3.0,
            max_voltage: 4.25,
            ocv_low: 3.05,
            ocv_high: 4.18,
        },
    }
}

pub fn ocv(chemistry: &str, soc: f32) -> f32 {
    let limits = chemistry_limits(chemistry);
    if chemistry == "lfp" {
        3.28 + 0.035 * ((soc - 0.5) * 8.0).tanh() + 0.08 * (soc - 0.5)
    } else {
        limits.ocv_low + (limits.ocv_high - limits.ocv_low) * (0.08 + 0.84 * soc)
    }
}
