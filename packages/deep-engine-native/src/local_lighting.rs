use serde::{Deserialize, Deserializer};

pub const MAX_LOCAL_LIGHTS: usize = 16;
#[derive(Debug, Default, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalLightKind {
    #[default]
    #[serde(skip)]
    Disabled,
    Directional,
    Point,
    Spot,
    Hemisphere,
}
#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalLight {
    pub kind: LocalLightKind,
    pub position: [f32; 3],
    pub direction: [f32; 3],
    pub radiance: [f32; 3],
    #[serde(default)]
    pub ground_radiance: Option<[f32; 3]>,
    #[serde(default)]
    pub shadow_softness: Option<f32>,
    pub range: f32,
    pub decay: f32,
    pub inner_cos: f32,
    pub outer_cos: f32,
    #[serde(default)]
    pub cast_shadow: bool,
    /// E02 IES 光域网引用；缺省=既有全向/锥形行为，旧载荷字节不变。
    #[serde(default)]
    pub ies: Option<crate::runtime_package::LightIes>,
}
impl LocalLight {
    pub fn validate(&self) -> bool {
        let norm = self.direction.iter().map(|v| v * v).sum::<f32>();
        self.kind != LocalLightKind::Disabled
            && self.shadow_softness.is_none_or(|value| {
                self.kind == LocalLightKind::Spot
                    && value.is_finite()
                    && (0.0..=1.0).contains(&value)
            })
            && (self.kind == LocalLightKind::Hemisphere) == self.ground_radiance.is_some()
            && self.ground_radiance.is_none_or(|rgb| {
                rgb.iter()
                    .all(|v| v.is_finite() && (0.0..=256.0).contains(v))
            })
            && (self.ies.is_none() || self.kind == LocalLightKind::Spot)
            && self.ies.as_ref().is_none_or(|ies| ies.validate().is_ok())
            && (!self.cast_shadow
                || ((self.kind == LocalLightKind::Point
                    || (self.kind == LocalLightKind::Spot
                        && self.outer_cos > 0.001
                        && self.outer_cos < 0.999999))
                    && (self.range == 0.0 || self.range > 0.0001)))
            && self
                .position
                .iter()
                .all(|v| v.is_finite() && v.abs() <= 1_000_000.0)
            && self.direction.iter().all(|v| v.is_finite())
            && (norm - 1.0).abs() < 0.0001
            && self
                .radiance
                .iter()
                .all(|v| v.is_finite() && (0.0..=256.0).contains(v))
            && self.range.is_finite()
            && (0.0..=1_000_000.0).contains(&self.range)
            && self.decay.is_finite()
            && (0.0..=4.0).contains(&self.decay)
            && self.inner_cos.is_finite()
            && self.outer_cos.is_finite()
            && (-1.0..=1.0).contains(&self.outer_cos)
            && (self.outer_cos..=1.0).contains(&self.inner_cos)
    }
    pub fn rows(&self) -> [[f32; 4]; 4] {
        let kind = match self.kind {
            LocalLightKind::Disabled => 0.0,
            LocalLightKind::Directional => 1.0,
            LocalLightKind::Point => 2.0,
            LocalLightKind::Spot => 3.0,
            LocalLightKind::Hemisphere => 4.0,
        };
        let position = self.ground_radiance.unwrap_or(self.position);
        [
            [position[0], position[1], position[2], self.range],
            [
                self.direction[0],
                self.direction[1],
                self.direction[2],
                kind,
            ],
            [
                self.radiance[0],
                self.radiance[1],
                self.radiance[2],
                self.outer_cos,
            ],
            [self.inner_cos, self.decay, 0.0, 0.0],
        ]
    }
}
pub fn decode<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<[LocalLight; MAX_LOCAL_LIGHTS], D::Error> {
    let lights = Vec::<LocalLight>::deserialize(deserializer)?;
    if lights.is_empty()
        || lights.len() > MAX_LOCAL_LIGHTS
        || lights.iter().any(|v| !v.validate())
        || !crate::local_shadow::validate_budget(&lights)
    {
        return Err(serde::de::Error::custom(
            "invalid or over-budget local light array",
        ));
    }
    let mut result = std::array::from_fn(|_| LocalLight::default());
    result[..lights.len()].clone_from_slice(&lights);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn hemisphere_preserves_ground_rgb_direction_and_legacy_rows() {
        let light: LocalLight = serde_json::from_value(json!({"kind":"hemisphere","position":[0,0,0],
            "direction":[0,1,0],"radiance":[2,1,0],"groundRadiance":[0,0.5,3],"range":0,"decay":2,"innerCos":1,"outerCos":0})).unwrap();
        assert!(light.validate());
        assert_eq!(light.rows()[0], [0.0, 0.5, 3.0, 0.0]);
        assert_eq!(light.rows()[1], [0.0, 1.0, 0.0, 4.0]);
        assert!(
            !LocalLight {
                ground_radiance: None,
                ..light.clone()
            }
            .validate()
        );
        assert!(
            !LocalLight {
                kind: LocalLightKind::Point,
                ..light.clone()
            }
            .validate()
        );
        assert!(
            !LocalLight {
                cast_shadow: true,
                ..light.clone()
            }
            .validate()
        );
        assert!(
            !LocalLight {
                ground_radiance: Some([f32::NAN, 0.0, 0.0]),
                ..light
            }
            .validate()
        );
    }
    #[derive(Deserialize)]
    struct Payload {
        #[serde(deserialize_with = "decode")]
        lights: [LocalLight; MAX_LOCAL_LIGHTS],
    }
    #[test]
    fn rejects_unbounded_or_ambiguous_local_lights() {
        let local = json!({"kind":"spot","position":[2,4,0],"direction":[0,-1,0],"radiance":[2,1,0],"range":12,"decay":2,"innerCos":0.9,"outerCos":0.7});
        let parsed: Payload = serde_json::from_value(json!({"lights":[local.clone()]})).unwrap();
        assert_eq!(parsed.lights[0].rows()[1], [0.0, -1.0, 0.0, 3.0]);
        assert_eq!(parsed.lights[1], LocalLight::default());
        for softness in [0.0, 0.25, 1.0] {
            let mut soft = local.clone();
            soft["shadowSoftness"] = json!(softness);
            let parsed: Payload = serde_json::from_value(json!({"lights":[soft]})).unwrap();
            assert_eq!(parsed.lights[0].shadow_softness, Some(softness as f32));
        }
        for (key, value) in [
            ("kind", json!("area")),
            ("direction", json!([0, 0, 0])),
            ("range", json!(-1)),
            ("decay", json!(5)),
            ("shadowSoftness", json!(1.01)),
            ("shadowSoftness", json!(-0.01)),
            ("innerCos", json!(0.5)),
            ("futureShadow", json!(false)),
        ] {
            let mut invalid = local.clone();
            invalid[key] = value;
            assert!(serde_json::from_value::<Payload>(json!({"lights":[invalid]})).is_err());
        }
        for values in [vec![], vec![local; 17]] {
            assert!(serde_json::from_value::<Payload>(json!({"lights":values})).is_err());
        }
        let mut point_ies = json!({"kind":"point","position":[2,4,0],"direction":[0,-1,0],
            "radiance":[2,1,0],"range":12,"decay":2,"innerCos":1,"outerCos":0});
        point_ies["ies"] = json!({"profileId":"cone"});
        assert!(serde_json::from_value::<Payload>(json!({"lights":[point_ies]})).is_err());
    }
}
