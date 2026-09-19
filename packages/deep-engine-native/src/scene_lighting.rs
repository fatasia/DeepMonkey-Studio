use crate::mesh_abi::FrameUniform;
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DirectionalLighting {
    pub direction: [f32; 3],
    pub radiance: [f32; 3],
    pub exposure: f32,
    pub shadows: bool,
    #[serde(default, deserialize_with = "crate::local_lighting::decode")]
    pub local_lights: [crate::local_lighting::LocalLight; crate::local_lighting::MAX_LOCAL_LIGHTS],
    /// E02 IES 光度表节；缺省=无 IES 语义，旧载荷字节不变。
    #[serde(default)]
    pub light_profiles: Option<Vec<crate::runtime_package::LightProfile>>,
}

impl DirectionalLighting {
    pub fn validate(&self) -> Result<Self, String> {
        let length = self.direction.iter().map(|v| v * v).sum::<f32>();
        if self.direction.iter().any(|v| !v.is_finite())
            || (length - 1.0).abs() > 0.0001
            || self
                .radiance
                .iter()
                .any(|v| !v.is_finite() || !(0.0..=256.0).contains(v))
            || !self.exposure.is_finite()
            || !(0.55..=1.55).contains(&self.exposure)
            || !crate::local_shadow::validate_budget(&self.local_lights)
            || self.local_lights.iter().any(|light| {
                light.kind != crate::local_lighting::LocalLightKind::Disabled && !light.validate()
            })
        {
            return Err("invalid authored directional lighting".into());
        }
        validate_ies_closure(&self.local_lights, self.light_profiles.as_deref())?;
        Ok(self.clone())
    }
    pub fn apply(&self, frame: &mut FrameUniform) {
        frame[11][..3].copy_from_slice(&self.direction);
        frame[13] = [self.radiance[0], self.radiance[1], self.radiance[2], 2.0];
        frame[14] = [self.exposure, f32::from(self.shadows), 0.0, 0.0];
        for (index, light) in self.local_lights.iter().enumerate() {
            frame[15 + index * 4..19 + index * 4].copy_from_slice(&light.rows());
            if light.kind != crate::local_lighting::LocalLightKind::Disabled {
                frame[14][2] += 1.0;
            }
            if light.cast_shadow {
                let slot = frame[14][3] as usize;
                let matrices =
                    crate::local_shadow::matrices(light.clone()).expect("validated local projection");
                if slot + matrices.len() <= crate::local_shadow::MAX_LOCAL_SHADOW_VIEWS {
                    for (face, matrix) in matrices.iter().enumerate() {
                        let start = crate::local_shadow::MATRIX_ROW + (slot + face) * 4;
                        frame[start..start + 4].copy_from_slice(matrix);
                    }
                    frame[18 + index * 4][2] = (slot + 1) as f32;
                    let far = if light.range > 0.0 {
                        light.range
                    } else {
                        500.0
                    };
                    let near = (far * 0.001).clamp(0.0001, 0.05);
                    frame[18 + index * 4][3] = near * far / (far - near);
                    frame[14][3] += matrices.len() as f32;
                }
            }
        }
    }
}

#[test]
fn rejects_invalid_directional_lighting() {
    let source = DirectionalLighting {
        direction: [0.0, 0.6, 0.8],
        radiance: [1.0, 1.0, 1.0],
        exposure: 1.05,
        shadows: false,
        local_lights: std::array::from_fn(|_| crate::local_lighting::LocalLight::default()),
        light_profiles: None,
    };
    for invalid in [
            DirectionalLighting {
                direction: [0.0; 3],
                ..source.clone()
            },
            DirectionalLighting {
                radiance: [f32::NAN, 0.0, 0.0],
                ..source.clone()
            },
            DirectionalLighting {
                radiance: [257.0, 0.0, 0.0],
                ..source.clone()
            },
            DirectionalLighting {
                exposure: 2.0,
                ..source.clone()
            },
        ] {
            assert!(invalid.validate().is_err());
        }
    }

    #[test]
    fn closes_ies_references_and_rejects_undeclared_or_duplicate_profiles() {
        let profile = crate::runtime_package::LightProfile {
            profile_id: "grid.cone".into(),
            format: "LM-63-2002".into(),
            vertical_angles: vec![0.0, 45.0, 90.0],
            candela: vec![vec![1000.0, 500.0, 100.0]],
            horizontal_symmetry: 1,
            total_lumens: 1234.5,
        };
        let lighting = |local_lights: crate::local_lighting::LocalLight, profiles: Option<Vec<_>>| DirectionalLighting {
            direction: [0.0, 0.6, 0.8],
            radiance: [0.0; 3],
            exposure: 1.05,
            shadows: false,
            local_lights: {
                let mut lights = std::array::from_fn(|_| crate::local_lighting::LocalLight::default());
                lights[0] = local_lights;
                lights
            },
            light_profiles: profiles,
        };
        let spot = |ies| crate::local_lighting::LocalLight {
            kind: crate::local_lighting::LocalLightKind::Spot,
            position: [0.0, 4.0, 0.0],
            direction: [0.0, -1.0, 0.0],
            radiance: [4.0; 3],
            range: 12.0,
            decay: 2.0,
            inner_cos: 0.9,
            outer_cos: 0.7,
            cast_shadow: false,
            ies,
        };
        let ies = || Some(crate::runtime_package::LightIes {
            profile_id: "grid.cone".into(),
            rotation_deg: Some(45.0),
            scale_factor: Some(0.5),
        });
        // 合法闭合、无 ies 无 profiles（旧载荷）、声明 profiles 但灯未引用。
        assert!(lighting(spot(ies()), Some(vec![profile.clone()])).validate().is_ok());
        assert!(lighting(spot(None), None).validate().is_ok());
        assert!(lighting(spot(None), Some(vec![profile.clone()])).validate().is_ok());
        // 引用缺失声明、重复 profileId、越界旋转、坏表 → 按名拒绝。
        assert!(lighting(spot(ies()), None).validate().is_err());
        let undeclared = crate::runtime_package::LightIes { profile_id: "ghost.profile".into(), rotation_deg: None, scale_factor: None };
        assert!(lighting(spot(Some(undeclared)), Some(vec![profile.clone()])).validate().is_err());
        assert!(lighting(spot(ies()), Some(vec![profile.clone(), profile.clone()])).validate().is_err());
        let bad_rotation = crate::runtime_package::LightIes { profile_id: "grid.cone".into(), rotation_deg: Some(45.25), scale_factor: None };
        assert!(lighting(spot(Some(bad_rotation)), Some(vec![profile.clone()])).validate().is_err());
        let mut broken = profile.clone();
        broken.vertical_angles = vec![0.0, 45.0, 90.25];
        assert!(lighting(spot(ies()), Some(vec![broken])).validate().is_err());
    }

/// E02：ies 引用闭合与 lightProfiles 结构/量化验证（与 TS validateLightingIes
/// 同语义；缺 lightProfiles 而灯带 ies → 拒绝，不静默降级为全向灯）。
fn validate_ies_closure(
    lights: &[crate::local_lighting::LocalLight],
    profiles: Option<&[crate::runtime_package::LightProfile]>,
) -> Result<(), String> {
    let Some(profiles) = profiles else {
        if lights.iter().any(|light| light.ies.is_some()) {
            return Err("local light references an ies profile but no lightProfiles section is declared".into());
        }
        return Ok(());
    };
    let mut declared = std::collections::HashSet::with_capacity(profiles.len());
    for profile in profiles {
        profile
            .validate()
            .map_err(|error| format!("light profile {}: {error}", profile.profile_id))?;
        if !declared.insert(profile.profile_id.as_str()) {
            return Err(format!("light profile {} declared more than once", profile.profile_id));
        }
    }
    for light in lights {
        let Some(ies) = &light.ies else { continue };
        if !declared.contains(ies.profile_id.as_str()) {
            return Err(format!("local light references undeclared ies profile {}", ies.profile_id));
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn freezes_direction_radiance_exposure_and_preserves_legacy_prefix() {
        let source = DirectionalLighting {
            direction: [0.0, 0.6, 0.8],
            radiance: [2.0, 1.0, 0.0],
            exposure: 1.05,
            shadows: false,
            local_lights: Default::default(),
            light_profiles: None,
        };
        let mut frame = crate::mesh_abi::frame_uniform(1.0, 0.0);
        let old = frame;
        source.validate().unwrap().apply(&mut frame);
        assert_eq!(&frame[..11], &old[..11]);
        assert_eq!(frame[12], old[12]);
        assert_eq!(frame[11][..3], source.direction);
        assert_eq!(frame[13], [2.0, 1.0, 0.0, 2.0]);
        assert_eq!(frame[14], [1.05, 0.0, 0.0, 0.0]);
        for invalid in [
            DirectionalLighting {
                direction: [0.0; 3],
                ..source.clone()
            },
            DirectionalLighting {
                radiance: [f32::NAN, 0.0, 0.0],
                ..source.clone()
            },
            DirectionalLighting {
                radiance: [257.0, 0.0, 0.0],
                ..source.clone()
            },
            DirectionalLighting {
                exposure: 2.0,
                ..source.clone()
            },
        ] {
            assert!(invalid.validate().is_err());
        }
    }
}
