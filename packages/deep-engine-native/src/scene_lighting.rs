use crate::mesh_abi::FrameUniform;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DirectionalLighting {
    pub direction: [f32; 3],
    pub radiance: [f32; 3],
    pub exposure: f32,
    pub shadows: bool,
    #[serde(default, deserialize_with = "crate::local_lighting::decode")]
    pub local_lights: [crate::local_lighting::LocalLight; crate::local_lighting::MAX_LOCAL_LIGHTS],
}

impl DirectionalLighting {
    pub fn validate(self) -> Result<Self, String> {
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
        Ok(self)
    }
    pub fn apply(self, frame: &mut FrameUniform) {
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
                    crate::local_shadow::matrices(*light).expect("validated local projection");
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
        if frame[14][2] > 0.0 {
            frame[13][3] = 3.0;
        }
    }
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
                ..source
            },
            DirectionalLighting {
                radiance: [f32::NAN, 0.0, 0.0],
                ..source
            },
            DirectionalLighting {
                radiance: [257.0, 0.0, 0.0],
                ..source
            },
            DirectionalLighting {
                exposure: 2.0,
                ..source
            },
        ] {
            assert!(invalid.validate().is_err());
        }
    }
}
