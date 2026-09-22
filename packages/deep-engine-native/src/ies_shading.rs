//! Native GPU IES resource packing. The byte layout mirrors the WebGPU E02 table:
//! 16 light parameter rows, profile metadata rows, then 361-column normalized tables.

use crate::{
    local_lighting::{LocalLight, LocalLightKind},
    runtime_package::{IesSamplingTable, LightProfile},
};

pub const IES_LIGHT_ROWS: usize = crate::local_lighting::MAX_LOCAL_LIGHTS;
pub const IES_EXPANDED_COLUMNS: usize = 361;
pub const IES_ROW_STRIDE_VEC4: usize = 91;
pub const IES_MAX_RESOURCE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct NativeIesShadingResource {
    pub rows: Vec<[f32; 4]>,
}

impl NativeIesShadingResource {
    pub fn prepare(
        lights: &[LocalLight],
        profiles: Option<&[LightProfile]>,
    ) -> Result<Self, String> {
        if lights.len() > IES_LIGHT_ROWS {
            return Err("native IES light count exceeds 16".into());
        }
        if lights
            .iter()
            .any(|light| light.kind != LocalLightKind::Disabled && !light.validate())
        {
            return Err("native IES resource received an invalid local light".into());
        }
        let profiles = profiles.unwrap_or_default();
        let mut profile_ids = std::collections::HashSet::with_capacity(profiles.len());
        let table_rows = profiles.iter().try_fold(0usize, |sum, profile| {
            profile.validate()?;
            if !profile_ids.insert(profile.profile_id.as_str()) {
                return Err(format!(
                    "native IES profile {} is duplicated",
                    profile.profile_id
                ));
            }
            sum.checked_add(profile.candela.len() * IES_ROW_STRIDE_VEC4)
                .ok_or_else(|| "native IES table size overflow".to_string())
        })?;
        let row_count = IES_LIGHT_ROWS
            .checked_add(profiles.len())
            .and_then(|v| v.checked_add(table_rows))
            .ok_or("native IES resource size overflow")?;
        if row_count * 16 > IES_MAX_RESOURCE_BYTES {
            return Err("native IES resource exceeds 16 MiB budget".into());
        }
        let mut rows = vec![[-1.0, 0.0, 0.0, 0.0]; row_count];
        let mut table_base = IES_LIGHT_ROWS + profiles.len();
        for (profile_index, profile) in profiles.iter().enumerate() {
            let sampling = IesSamplingTable::from_profile(profile);
            let count = profile.candela.len();
            let row_half_step = if count < 2 {
                0.0
            } else if profile.horizontal_symmetry == 2 {
                360.0 / (count - 1) as f64
            } else {
                180.0 / (count - 1) as f64
            };
            rows[IES_LIGHT_ROWS + profile_index] = [
                table_base as f32,
                count as f32,
                row_half_step as f32,
                profile.horizontal_symmetry as f32,
            ];
            for row in 0..count {
                let phi = if row_half_step == 0.0 {
                    0.0
                } else {
                    row as f64 * row_half_step * 0.5
                };
                for column in 0..IES_EXPANDED_COLUMNS {
                    let value =
                        sampling.intensity_factor(column as f64 * 0.5, phi, 0.0, 1.0) as f32;
                    rows[table_base + row * IES_ROW_STRIDE_VEC4 + column / 4][column % 4] =
                        if value == 0.0 { 0.0 } else { value };
                }
            }
            table_base += count * IES_ROW_STRIDE_VEC4;
        }
        for (index, light) in lights.iter().enumerate() {
            let Some(ies) = &light.ies else { continue };
            let profile_index = profiles
                .iter()
                .position(|profile| profile.profile_id == ies.profile_id)
                .ok_or_else(|| {
                    format!(
                        "native IES light references undeclared profile {}",
                        ies.profile_id
                    )
                })?;
            rows[index] = [
                profile_index as f32,
                (ies.rotation_deg.unwrap_or(0.0) * 2.0) as f32,
                ies.scale_factor.unwrap_or(1.0) as f32,
                (IES_LIGHT_ROWS + profile_index) as f32,
            ];
        }
        Ok(Self { rows })
    }

    pub fn bytes(&self) -> &[u8] {
        bytemuck::cast_slice(&self.rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{local_lighting::LocalLightKind, runtime_package::LightIes};

    fn profile() -> LightProfile {
        LightProfile {
            profile_id: "cone".into(),
            format: "LM-63-2002".into(),
            vertical_angles: vec![0.0, 90.0, 180.0],
            candela: vec![vec![1000.0, 500.0, 0.0]],
            horizontal_symmetry: 1,
            total_lumens: 1000.0,
        }
    }
    #[test]
    fn packs_normalized_native_gpu_rows_and_identity_sentinels() {
        let light = LocalLight {
            kind: LocalLightKind::Spot,
            direction: [0.0, -1.0, 0.0],
            ies: Some(LightIes {
                profile_id: "cone".into(),
                rotation_deg: Some(45.0),
                scale_factor: Some(0.5),
            }),
            ..Default::default()
        };
        let packed = NativeIesShadingResource::prepare(&[light], Some(&[profile()])).unwrap();
        assert_eq!(packed.rows[0], [0.0, 90.0, 0.5, 16.0]);
        assert_eq!(packed.rows[1], [-1.0, 0.0, 0.0, 0.0]);
        assert_eq!(packed.rows[16], [17.0, 1.0, 0.0, 1.0]);
        assert_eq!(packed.rows[17][0], 1.0);
        assert_eq!(packed.rows[17 + 45][0], 0.5);
        assert_eq!(packed.rows[17 + 90][0], 0.0);
        assert_eq!(packed.bytes().len(), packed.rows.len() * 16);
    }
}
