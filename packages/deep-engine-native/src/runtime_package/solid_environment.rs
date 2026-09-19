use serde::Deserialize;

use crate::fog::FogSettings;

/// 解码后的纯色环境：作者背景色（已抵消固定 ACES）与可选作者雾。
#[derive(Debug, Clone, Copy)]
pub(super) struct DecodedSolidEnvironment {
    pub(super) background: [f64; 3],
    pub(super) fog: Option<FogSettings>,
}

/// 天气雾合同 v1（见 web 侧 compileSceneWeatherFog）：exp2 唯一合法 kind，
/// 颜色是线性域 HDR 值，直接进 frame tuning，不做背景的 sRGB 逆变换。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuthorFog {
    schema_version: u32,
    kind: String,
    color_linear_rgb: [f64; 3],
    density: f64,
}

impl AuthorFog {
    fn settings(self) -> Result<FogSettings, String> {
        if self.schema_version != 1 {
            return Err(format!(
                "unsupported author fog schema {}",
                self.schema_version
            ));
        }
        if self.kind != "exp2" {
            return Err(format!("unsupported author fog kind {:?}", self.kind));
        }
        let density = self.density as f32;
        let color = self.color_linear_rgb.map(|channel| channel as f32);
        FogSettings::authored_exp2(density, color)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SolidEnvironment {
    schema: String,
    schema_version: u32,
    id: String,
    revision: u64,
    kind: String,
    background_srgb: [f64; 3],
    output_transform: String,
    #[serde(default)]
    lighting: Option<crate::scene_lighting::DirectionalLighting>,
    #[serde(default)]
    ibl: Option<serde_json::Value>,
    #[serde(default)]
    fog: Option<AuthorFog>,
}

pub(super) fn decode(
    value: &serde_json::Value,
    id: &str,
    revision: u64,
) -> Result<DecodedSolidEnvironment, super::RuntimePackageError> {
    let source: SolidEnvironment = serde_json::from_value(value.clone())
        .map_err(|error| super::RuntimePackageError(format!("solid environment: {error}")))?;
    let profile = match (source.schema_version, source.lighting) {
        (1, None) => source.output_transform == "native-aces-v1" && value.get("lighting").is_none(),
        (2, Some(light)) => {
            source.output_transform == "native-aces-light-v2"
                && light.validate().is_ok()
                && value["lighting"].get("localLights").is_none()
        }
        (3, Some(light)) => {
            source.output_transform == "native-aces-lights-v3"
                && light.validate().is_ok()
                && value["lighting"].get("localLights").is_some()
                && !has_local_shadow_fields(value)
        }
        (4, Some(light)) => {
            source.output_transform == "native-aces-spot-shadows-v4"
                && light.validate().is_ok()
                && light.local_lights.iter().any(|light| light.cast_shadow)
                && !light.local_lights.iter().any(|light| {
                    light.cast_shadow && light.kind == crate::local_lighting::LocalLightKind::Point
                })
        }
        (5, Some(light)) => {
            source.output_transform == "native-aces-local-shadows-v5"
                && light.validate().is_ok()
                && light.local_lights.iter().any(|light| {
                    light.cast_shadow && light.kind == crate::local_lighting::LocalLightKind::Point
                })
        }
        (6, Some(light)) => {
            source.output_transform == "native-aces-hdr-v6"
                && light.validate().is_ok()
                && source.ibl.is_some()
        }
        // v7 是作者雾档：声明雾就必须合法，lighting 与旧档一样可选。
        (7, lighting) => {
            source.output_transform == "native-aces-fog-v7"
                && source.fog.is_some()
                && lighting.is_none_or(|light| light.validate().is_ok())
        }
        _ => false,
    };
    if source.schema != "deep-engine.solid-environment"
        || !profile
        || source.id != id
        || id != "scene.environment"
        || source.revision != revision
        || revision != 1
        || source.kind
            != if source.schema_version == 6 {
                "solid-background-prefiltered-ibl"
            } else {
                "solid-background-no-ibl"
            }
        || (source.schema_version != 6 && value.get("ibl").is_some())
        // deny-unknown 不覆盖已声明的 Option 字段：非 v7 档声明 fog 一律拒绝。
        || (source.schema_version != 7 && value.get("fog").is_some())
        || source
            .background_srgb
            .iter()
            .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
    {
        return super::fail("unsupported solid environment identity, color or output transform");
    }
    let fog = source
        .fog
        .map(|fog| {
            fog.settings().map_err(|error| {
                super::RuntimePackageError(format!("solid environment author fog: {error}"))
            })
        })
        .transpose()?;
    // Three 的 Color 背景不经 tone mapping；抵消现有固定 ACES，保持作者 sRGB。
    Ok(DecodedSolidEnvironment {
        background: source.background_srgb.map(inverse_output),
        fog,
    })
}

fn has_local_shadow_fields(value: &serde_json::Value) -> bool {
    value["lighting"]["localLights"]
        .as_array()
        .is_some_and(|lights| lights.iter().any(|light| light.get("castShadow").is_some()))
}

pub(super) fn lighting(
    value: &serde_json::Value,
) -> Option<crate::scene_lighting::DirectionalLighting> {
    serde_json::from_value::<SolidEnvironment>(value.clone())
        .ok()?
        .lighting
}

fn inverse_output(srgb: f64) -> f64 {
    let y = if srgb <= 0.04045 {
        srgb / 12.92
    } else {
        ((srgb + 0.055) / 1.055).powf(2.4)
    };
    let a = 2.51 - 2.43 * y;
    let b = 0.03 - 0.59 * y;
    (-b + (b * b + 0.56 * a * y).sqrt()) / (2.0 * a)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> serde_json::Value {
        serde_json::json!({"schema":"deep-engine.solid-environment","schemaVersion":1,
            "id":"scene.environment","revision":1,"kind":"solid-background-no-ibl",
            "backgroundSrgb":[0.0,0.5,1.0],"outputTransform":"native-aces-v1"})
    }
    #[test]
    fn background_round_trips_fixed_output_for_all_byte_values() {
        for byte in 0..=255 {
            let input = f64::from(byte) / 255.0;
            let x = inverse_output(input);
            let y = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
            let output = if y <= 0.0031308 {
                y * 12.92
            } else {
                1.055 * y.powf(1.0 / 2.4) - 0.055
            };
            assert!((input - output).abs() < 1e-10);
        }
        assert!(decode(&source(), "scene.environment", 1).is_ok());
    }
    #[test]
    fn rejects_unknown_fields_identity_color_and_transform() {
        for (key, value) in [
            ("schemaVersion", serde_json::json!(2)),
            ("revision", serde_json::json!(2)),
            ("outputTransform", serde_json::json!("exposure-2")),
            ("backgroundSrgb", serde_json::json!([0, 0, 1.1])),
            ("backgroundSrgb", serde_json::json!([0, 0])),
            ("extra", serde_json::json!(true)),
        ] {
            let mut source = source();
            source[key] = value;
            assert!(decode(&source, "scene.environment", 1).is_err(), "{key}");
        }
        assert!(decode(&source(), "other", 1).is_err());
    }
    #[test]
    fn point_shadow_requires_v5_and_one_point_budget() {
        let mut value = source();
        let point = serde_json::json!({"kind":"point","position":[0,4,3],"direction":[0,-1,0],"radiance":[4,4,4],"range":12,"decay":2,"innerCos":1,"outerCos":0,"castShadow":true});
        value["schemaVersion"] = serde_json::json!(5);
        value["outputTransform"] = serde_json::json!("native-aces-local-shadows-v5");
        value["lighting"] = serde_json::json!({"direction":[0,1,0],"radiance":[0,0,0],"exposure":1.05,"shadows":false,"localLights":[point.clone()]});
        assert!(decode(&value, "scene.environment", 1).is_ok());
        let mut old = value.clone();
        old["schemaVersion"] = serde_json::json!(4);
        old["outputTransform"] = serde_json::json!("native-aces-spot-shadows-v4");
        assert!(decode(&old, "scene.environment", 1).is_err());
        value["lighting"]["localLights"] = serde_json::json!([point.clone(), point]);
        assert!(decode(&value, "scene.environment", 1).is_err());
    }

    fn fog_source() -> serde_json::Value {
        let mut value = source();
        value["schemaVersion"] = serde_json::json!(7);
        value["outputTransform"] = serde_json::json!("native-aces-fog-v7");
        value["fog"] = serde_json::json!({"schemaVersion":1,"kind":"exp2",
            "colorLinearRgb":[0.5,0.25,0.125],"density":0.15});
        value
    }

    #[test]
    fn authored_exp2_fog_decodes_into_hdr_settings() {
        let decoded = decode(&fog_source(), "scene.environment", 1).unwrap();
        let fog = decoded.fog.expect("v7 declares author fog");
        assert!(fog.is_authored());
        assert!(!fog.requires_output_pass());
        assert_eq!(fog.density(), 0.15);
        assert_eq!(fog.color(), [0.5, 0.25, 0.125]);
        // 雾色是线性域直通，不吃背景的 sRGB 逆变换。
        assert_eq!(decoded.background, source_background_after_inverse_output());
        // v7 的 lighting 可选：带合法灯光（省略 localLights 走默认）仍解码成功。
        let mut lit = fog_source();
        lit["lighting"] = serde_json::json!({"direction":[0,1,0],"radiance":[0,0,0],
            "exposure":1.05,"shadows":false});
        let parsed: Result<SolidEnvironment, _> = serde_json::from_value(lit.clone());
        let lighting_valid = parsed
            .as_ref()
            .ok()
            .and_then(|source| source.lighting.as_ref())
            .map(|light| light.validate().map(|_| ()))
            .unwrap_or(Ok(()));
        assert!(parsed.is_ok(), "{parsed:?}");
        assert!(lighting_valid.is_ok(), "{lighting_valid:?}");
        assert!(decode(&lit, "scene.environment", 1).is_ok());
    }

    #[test]
    fn author_fog_rejects_unknown_kind_schema_and_out_of_range_values() {
        for (key, value) in [
            ("kind", serde_json::json!("linear")),
            ("kind", serde_json::json!("exp")),
            ("schemaVersion", serde_json::json!(2)),
            ("density", serde_json::json!(8.1)),
            ("density", serde_json::json!(-0.1)),
            ("density", serde_json::json!("0.1")),
            ("colorLinearRgb", serde_json::json!([-0.1, 0.0, 0.0])),
            ("colorLinearRgb", serde_json::json!([65.0, 0.0, 0.0])),
            ("colorLinearRgb", serde_json::json!([0.5, 0.0])),
            ("extra", serde_json::json!(true)),
        ] {
            let mut source = fog_source();
            source["fog"][key] = value;
            assert!(decode(&source, "scene.environment", 1).is_err(), "{key}");
        }
        // 声明 v7 却缺雾、旧档声明雾、v7 变换名错误都 fail-closed。
        let mut without_fog = fog_source();
        without_fog.as_object_mut().unwrap().remove("fog");
        assert!(decode(&without_fog, "scene.environment", 1).is_err());
        let mut legacy_with_fog = source();
        legacy_with_fog["fog"] = fog_source()["fog"].clone();
        assert!(decode(&legacy_with_fog, "scene.environment", 1).is_err());
        let mut wrong_transform = fog_source();
        wrong_transform["outputTransform"] = serde_json::json!("native-aces-v1");
        assert!(decode(&wrong_transform, "scene.environment", 1).is_err());
    }

    fn source_background_after_inverse_output() -> [f64; 3] {
        [0.0, 0.5, 1.0].map(inverse_output)
    }
}
