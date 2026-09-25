//! Native probe irradiance producer.
//!
//! This bounded first producer updates authored probe records from the current
//! directional radiance and GI multiplier. It is a deterministic direct-light
//! seed, not a claim of multi-bounce ray-traced GI. Grid/layout headers remain
//! byte-for-byte untouched.

use crate::probe_gi_abi::IrradianceProbeRecord;
use deep_engine_native::scene_lighting::DirectionalLighting;

const PI: f32 = std::f32::consts::PI;
const MAX_IRRADIANCE: f32 = 65_504.0;

pub(crate) fn produce_direct_irradiance(
    records: &mut [IrradianceProbeRecord],
    lighting: &DirectionalLighting,
) -> bool {
    let Ok(cascade) = crate::probe_gi_grid::decode_probe_grid_cascade(records) else {
        return false;
    };
    let headers: std::collections::HashSet<usize> = if cascade.layout.is_some() {
        std::iter::once(0usize)
            .chain(cascade.header_records.iter().copied())
            .collect()
    } else {
        cascade.header_records.iter().copied().collect()
    };
    let multiplier = lighting
        .global_illumination_intensity
        .unwrap_or(1.0)
        .max(0.0);
    let scale = 0.5 * PI * multiplier * lighting.exposure;
    for (index, record) in records.iter_mut().enumerate() {
        if headers.contains(&index) || record.validity <= 0.0 {
            continue;
        }
        record.irradiance = lighting
            .radiance
            .map(|value| (value * scale).clamp(0.0, MAX_IRRADIANCE));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe_gi_grid::ProbeGiGridHeader;

    fn lighting() -> DirectionalLighting {
        DirectionalLighting {
            direction: [0.0, 1.0, 0.0],
            radiance: [2.0, 4.0, 8.0],
            exposure: 1.0,
            shadows: true,
            global_illumination_intensity: Some(0.5),
            local_lights: std::array::from_fn(|_| {
                deep_engine_native::local_lighting::LocalLight::default()
            }),
            light_profiles: None,
        }
    }

    #[test]
    fn produces_direct_irradiance_and_preserves_probe_metadata() {
        let header = ProbeGiGridHeader {
            origin: [0.0; 3],
            spacing: 2.0,
            grid_size: [2, 2, 2],
            probe_count: 8,
        };
        let mut records = vec![header.encode().unwrap()];
        records.extend((0..8).map(|index| IrradianceProbeRecord {
            validity: 1.0,
            mean_distance: 3.0,
            distance_variance: 4.0,
            occlusion_floor: 0.1,
            position_offset: [index as f32, 1.0, 2.0],
            ..IrradianceProbeRecord::zero()
        }));
        let before = records[1];
        assert!(produce_direct_irradiance(&mut records, &lighting()));
        assert_eq!(records[0], header.encode().unwrap());
        assert_eq!(records[1].mean_distance, before.mean_distance);
        assert_eq!(records[1].position_offset, before.position_offset);
        assert_eq!(records[1].irradiance, [0.5 * PI, PI, 2.0 * PI]);
    }

    #[test]
    fn invalid_layout_fails_closed_without_mutation() {
        let mut records = vec![IrradianceProbeRecord::zero()];
        let before = records.clone();
        assert!(!produce_direct_irradiance(&mut records, &lighting()));
        assert_eq!(records, before);
    }
}
