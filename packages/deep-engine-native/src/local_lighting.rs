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
}
#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalLight {
    pub kind: LocalLightKind,
    pub position: [f32; 3],
    pub direction: [f32; 3],
    pub radiance: [f32; 3],
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
        };
        [
            [
                self.position[0],
                self.position[1],
                self.position[2],
                self.range,
            ],
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
        for (key, value) in [
            ("kind", json!("area")),
            ("direction", json!([0, 0, 0])),
            ("range", json!(-1)),
            ("decay", json!(5)),
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
    }
}
