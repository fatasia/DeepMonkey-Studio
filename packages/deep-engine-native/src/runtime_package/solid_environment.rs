use serde::Deserialize;
use serde_json::Value;

use crate::fog::FogSettings;
use crate::runtime_package::runtime_content_sha256;

/// 已验证的静态光照贴图描述符；仅绑定运行包中的真实纹理与 UV 流。
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct StaticLightmapDescriptor {
    schema: String,
    schema_version: u32,
    texture_id: String,
    texture_hash: ContentHash,
    uv_set: u8,
    color_space: String,
    intensity: f64,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ContentHash {
    algorithm: String,
    value: String,
}

/// 解码后的纯色环境：作者背景色（已抵消固定 ACES）与可选作者雾、作者色彩分级。
#[derive(Debug, Clone, Copy)]
pub(super) struct DecodedSolidEnvironment {
    pub(super) background: [f64; 3],
    pub(super) fog: Option<FogSettings>,
    pub(super) grading: Option<crate::author_grading::AuthorGrading>,
}

pub(super) fn validate_static_lightmap(
    environment: &Value,
    render_packet: &Value,
) -> Result<Option<StaticLightmapDescriptor>, String> {
    let Some(raw) = environment.get("staticLightmap") else {
        return Ok(None);
    };
    let descriptor: StaticLightmapDescriptor = serde_json::from_value(raw.clone())
        .map_err(|error| format!("static lightmap descriptor: {error}"))?;
    if descriptor.schema != "deep-engine.static-lightmap"
        || descriptor.schema_version != 1
        || descriptor.texture_id.is_empty()
        || descriptor.texture_hash.algorithm != "sha256"
        || !descriptor
            .texture_hash
            .value
            .chars()
            .all(|value| value.is_ascii_hexdigit())
        || descriptor.texture_hash.value.len() != 64
        || descriptor.uv_set > 1
        || !matches!(descriptor.color_space.as_str(), "linear" | "srgb")
        || !descriptor.intensity.is_finite()
        || !(0.0..=64.0).contains(&descriptor.intensity)
        || descriptor.width == 0
        || descriptor.height == 0
        || descriptor.width > 16_384
        || descriptor.height > 16_384
    {
        return Err("invalid static lightmap descriptor".into());
    }
    let textures = render_packet
        .get("textures")
        .and_then(Value::as_array)
        .ok_or_else(|| "static lightmap render packet textures are missing".to_string())?;
    let texture = textures
        .iter()
        .find(|value| value.get("id").and_then(Value::as_str) == Some(&descriptor.texture_id))
        .ok_or_else(|| {
            format!(
                "static lightmap texture {} is missing",
                descriptor.texture_id
            )
        })?;
    let semantic = texture.get("semantic").and_then(Value::as_str);
    if !matches!(semantic, Some("occlusion") | Some("emissive")) {
        return Err("static lightmap texture must use occlusion or emissive semantic".into());
    }
    if texture.get("width").and_then(Value::as_u64) != Some(u64::from(descriptor.width))
        || texture.get("height").and_then(Value::as_u64) != Some(u64::from(descriptor.height))
    {
        return Err("static lightmap texture dimensions differ from descriptor".into());
    }
    if runtime_content_sha256(texture) != descriptor.texture_hash.value {
        return Err("static lightmap texture hash does not match descriptor".into());
    }
    let key = if descriptor.uv_set == 0 { "uv0" } else { "uv1" };
    let has_uv = render_packet
        .get("geometries")
        .and_then(Value::as_array)
        .is_some_and(|geometries| {
            geometries.iter().any(|geometry| {
                geometry
                    .get(key)
                    .and_then(Value::as_array)
                    .is_some_and(|values| values.len() >= 6)
            })
        });
    if !has_uv {
        return Err(format!(
            "static lightmap UV{} is missing",
            descriptor.uv_set
        ));
    }
    Ok(Some(descriptor))
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

/// 作者色彩分级六通道 wire 合同（v9 档）：hue/saturation/brightness/contrast
/// 必填，temperature/tint 为可选扩展（缺省 0，与 Web `colorGrading` 同形）。
/// 数值校验在 `AuthorGrading::new` 里 fail-fast，与 TS `scalar()` 范围一致。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuthorColorGrading {
    hue: f32,
    saturation: f32,
    brightness: f32,
    contrast: f32,
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    tint: Option<f32>,
}

impl AuthorColorGrading {
    fn grading(self) -> Result<crate::author_grading::AuthorGrading, String> {
        crate::author_grading::AuthorGrading::new(
            self.hue,
            self.saturation,
            self.brightness,
            self.contrast,
            self.temperature.unwrap_or(0.0),
            self.tint.unwrap_or(0.0),
        )
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
    /// v9 作者色彩分级；旧档声明该字段在 decode 档位门被拒（档位名必须
    /// 真实描述包内容，与 fog 的档位门同一纪律）。
    #[serde(default)]
    color_grading: Option<AuthorColorGrading>,
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
        (8, lighting) => {
            source.output_transform == "native-aces-studio-v8"
                && lighting.is_none_or(|light| light.validate().is_ok())
                && source.ibl.is_none()
        }
        // v9 是作者色彩分级档：colorGrading 必须声明；继承 v8 的 studio（builtin
        // IBL）语义，同时允许 no-ibl（普通纯色场景的分级，雾/灯光同样可选）。
        // 数值/范围非法走下方专属错误消息（与 fog 同路径）。
        (9, lighting) => {
            source.output_transform == "native-aces-grading-v9"
                && source.color_grading.is_some()
                && lighting.is_none_or(|light| light.validate().is_ok())
                && source.ibl.is_none()
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
            != if source.schema_version == 8 {
                "solid-background-builtin-ibl"
            } else if source.schema_version == 6 {
                "solid-background-prefiltered-ibl"
            } else if source.schema_version == 9 {
                // v9 双 kind：builtin-ibl（studio 语义延续）或 no-ibl（普通纯色
                // 场景的分级）；两者之外在下方同一失败路径拒绝。
                if source.kind == "solid-background-builtin-ibl"
                    || source.kind == "solid-background-no-ibl"
                {
                    source.kind.as_str()
                } else {
                    ""
                }
            } else {
                "solid-background-no-ibl"
            }
        || (source.schema_version != 6 && value.get("ibl").is_some())
        // deny-unknown 不覆盖已声明的 Option 字段：非 v7/v8/v9 档声明 fog、
        // 非 v9 档声明 colorGrading 一律拒绝（档位名必须真实描述包内容）。
        || (![7, 8, 9].contains(&source.schema_version) && value.get("fog").is_some())
        || (source.schema_version != 9 && value.get("colorGrading").is_some())
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
    let grading = source
        .color_grading
        .map(|grading| {
            grading.grading().map_err(|error| {
                super::RuntimePackageError(format!(
                    "solid environment author color grading: {error}"
                ))
            })
        })
        .transpose()?;
    // Three 的 Color 背景不经 tone mapping；抵消现有固定 ACES，保持作者 sRGB。
    Ok(DecodedSolidEnvironment {
        background: source.background_srgb.map(inverse_output),
        fog,
        grading,
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
    fn builtin_studio_profile_keeps_background_fog_and_lighting_contract() {
        let mut value = fog_source();
        value["schemaVersion"] = serde_json::json!(8);
        value["kind"] = serde_json::json!("solid-background-builtin-ibl");
        value["outputTransform"] = serde_json::json!("native-aces-studio-v8");
        value["lighting"] = serde_json::json!({"direction":[0,1,0],"radiance":[1,1,1],
            "exposure":1.05,"shadows":true,"globalIlluminationIntensity":0.8});
        let decoded = decode(&value, "scene.environment", 1).unwrap();
        assert!(decoded.fog.is_some());
        assert!(decoded.grading.is_none());
        assert!(lighting(&value).is_some());
        let mut wrong = value;
        wrong["kind"] = serde_json::json!("solid-background-no-ibl");
        assert!(decode(&wrong, "scene.environment", 1).is_err());
    }

    fn grading_source() -> serde_json::Value {
        let mut value = fog_source();
        value["schemaVersion"] = serde_json::json!(9);
        value["kind"] = serde_json::json!("solid-background-builtin-ibl");
        value["outputTransform"] = serde_json::json!("native-aces-grading-v9");
        value["colorGrading"] = serde_json::json!({"hue":30,"saturation":0.5,
            "brightness":-0.25,"contrast":0.1,"temperature":0.8,"tint":-0.4});
        value
    }

    /// v9 档：六通道解码进 AuthorGrading，temperature/tint 可选缺省 0，
    /// lighting/fog 与 v8 一样可选兼容。
    #[test]
    fn grading_profile_decodes_six_channels_with_optional_channels_defaulting_to_zero() {        let decoded = decode(&grading_source(), "scene.environment", 1).unwrap();
        let grading = decoded.grading.expect("v9 declares author color grading");
        assert_eq!(
            grading.pack(),
            [
                1.0, 0.0, 1.0, 0.0, 30.0, 0.5, -0.25, 0.1, 0.8, -0.4, 0.0, 0.0
            ]
        );
        // temperature/tint 缺省 = 精确中性通道，与显式 0 等价。
        let mut minimal = grading_source();
        minimal["colorGrading"] = serde_json::json!({"hue":-45,"saturation":0.25,
            "brightness":0.05,"contrast":0.05});
        let decoded = decode(&minimal, "scene.environment", 1).unwrap();
        assert_eq!(
            decoded.grading.unwrap().pack(),
            [
                1.0, 0.0, 1.0, 0.0, -45.0, 0.25, 0.05, 0.05, 0.0, 0.0, 0.0, 0.0
            ]
        );
        // lighting 与 fog 在 v9 仍可选（studio 语义延续）。
        let mut with_light = grading_source();
        with_light["lighting"] = serde_json::json!({"direction":[0,1,0],"radiance":[0,0,0],
            "exposure":1.05,"shadows":false});
        assert!(decode(&with_light, "scene.environment", 1).is_ok());
        assert!(
            decode(&grading_source(), "scene.environment", 1)
                .unwrap()
                .fog
                .is_some()
        );
        // 六通道全零也是合法 v9（作者显式中性），pack 恒中性。
        let mut neutral = grading_source();
        neutral["colorGrading"] = serde_json::json!({"hue":0,"saturation":0,
            "brightness":0,"contrast":0,"temperature":0,"tint":0});
        let decoded = decode(&neutral, "scene.environment", 1).unwrap();
        assert!(decoded.grading.unwrap().is_neutral());
    }

    /// 旧包兼容与 fail-closed：旧档带 colorGrading 拒绝、v9 缺字段/越界/
    /// 未知字段/变换名错误拒绝。
    #[test]
    fn grading_contract_stays_fail_closed_for_legacy_and_invalid_packages() {
        // v8 及更早档声明 colorGrading → 档位门拒绝（未升级 outputTransform 的包
        // 不能夹带新效果）。
        let mut legacy_v8 = grading_source();
        legacy_v8["schemaVersion"] = serde_json::json!(8);
        legacy_v8["outputTransform"] = serde_json::json!("native-aces-studio-v8");
        assert!(decode(&legacy_v8, "scene.environment", 1).is_err());
        let mut legacy_v7 = grading_source();
        legacy_v7["schemaVersion"] = serde_json::json!(7);
        legacy_v7["outputTransform"] = serde_json::json!("native-aces-fog-v7");
        assert!(decode(&legacy_v7, "scene.environment", 1).is_err());
        let mut legacy_v1 = source();
        legacy_v1["colorGrading"] = grading_source()["colorGrading"].clone();
        assert!(decode(&legacy_v1, "scene.environment", 1).is_err());
        // v9 缺 colorGrading 拒绝。
        let mut without = grading_source();
        without.as_object_mut().unwrap().remove("colorGrading");
        assert!(decode(&without, "scene.environment", 1).is_err());
        // 数值非法：越界、缺必填通道、未知字段、字符串数字。
        for (key, value) in [
            ("hue", serde_json::json!(180.1)),
            ("saturation", serde_json::json!(-1.1)),
            ("brightness", serde_json::json!(1.0001)),
            ("contrast", serde_json::json!("0.1")),
            ("temperature", serde_json::json!(1.0001)),
            ("tint", serde_json::json!(-1.0001)),
            ("extra", serde_json::json!(true)),
            // JSON 大数在 f32 反序列化后成为 inf，必须被有限性校验拦下。
            ("brightness", serde_json::json!(1e300)),
        ] {
            let mut invalid = grading_source();
            invalid["colorGrading"][key] = value;
            assert!(decode(&invalid, "scene.environment", 1).is_err(), "{key}");
        }
        let mut missing = grading_source();
        missing["colorGrading"]
            .as_object_mut()
            .unwrap()
            .remove("saturation");
        assert!(decode(&missing, "scene.environment", 1).is_err());
        // 变换名/kind 错误与 kind 档位语义保持 fail-closed。
        // （no-ibl 现在是 v9 的合法 kind，见
        // grading_profile_admits_plain_no_ibl_kind_and_rejects_unknown_kinds；
        // 这里用 prefiltered-ibl——HDR v6 专属档——验证 kind 仍然 fail-closed。）
        let mut wrong_transform = grading_source();
        wrong_transform["outputTransform"] = serde_json::json!("native-aces-studio-v8");
        assert!(decode(&wrong_transform, "scene.environment", 1).is_err());
        let mut wrong_kind = grading_source();
        wrong_kind["kind"] = serde_json::json!("solid-background-prefiltered-ibl");
        assert!(decode(&wrong_kind, "scene.environment", 1).is_err());
        // v9 声明 ibl 拒绝（builtin IBL 语义继承 v8）。
        let mut with_ibl = grading_source();
        with_ibl["ibl"] = serde_json::json!({"schema":"x"});
        assert!(decode(&with_ibl, "scene.environment", 1).is_err());
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

    /// F4 逐字段对拍：v9 档扩展 no-ibl kind——普通纯色场景（非 studio）的作者
    /// 分级 + 可选雾/灯光在同一载荷携带；三档 kind 之外仍拒绝。
    #[test]
    fn grading_profile_admits_plain_no_ibl_kind_and_rejects_unknown_kinds() {
        // no-ibl v9（Web compileSceneEnvironment 对 skybox:none 场景的输出形态）。
        let mut plain = grading_source();
        plain["kind"] = serde_json::json!("solid-background-no-ibl");
        let decoded = decode(&plain, "scene.environment", 1).unwrap();
        assert!(decoded.grading.is_some());
        assert!(decoded.fog.is_some());
        // 雾可选：普通场景无天气时不声明 fog 仍然合法。
        let mut without_fog = plain.clone();
        without_fog.as_object_mut().unwrap().remove("fog");
        assert!(decode(&without_fog, "scene.environment", 1).is_ok());
        // lighting 同样可选。
        let mut lit = plain;
        lit["lighting"] = serde_json::json!({"direction":[0,1,0],"radiance":[0,0,0],
            "exposure":1.05,"shadows":false});
        assert!(decode(&lit, "scene.environment", 1).is_ok());
        // 三档 kind 之外（prefiltered-ibl 是 HDR v6 专属）拒绝。
        let mut wrong = grading_source();
        wrong["kind"] = serde_json::json!("solid-background-prefiltered-ibl");
        assert!(decode(&wrong, "scene.environment", 1).is_err());
    }
}


/// F3 探针网格解码:环境 JSON 的 `irradianceProbes` 载荷 → 记录流扁平数组。
/// v1 双形态按 `levels` 键分派(与 Web 合同一致):
/// - 旧单层:网格头 + 探针记录(与 Web packNativeProbeGridRecords 同合同),
///   解析路径逐字不变;
/// - v2 级联:布局头 + 每层"网格头 + 探针"(与 Web packNativeProbeGridLevels
///   同合同),最终过 `decode_probe_grid_cascade` 全合同复核。
/// 非法输入一律 fail-closed。
pub(super) fn decode_probe_grid(
    environment: &Value,
) -> Result<Option<Vec<crate::probe_gi_abi::IrradianceProbeRecord>>, String> {
    let Some(raw) = environment.get("irradianceProbes") else {
        return Ok(None);
    };
    let object = raw
        .as_object()
        .ok_or_else(|| "probe grid payload must be an object".to_string())?;
    if object.get("schema").and_then(Value::as_str) != Some("deep-engine.probe-grid")
        || object.get("schemaVersion").and_then(Value::as_u64) != Some(1)
    {
        return Err("unsupported probe grid schema".into());
    }
    // v1 双形态分派:levels 键存在 = v2 多层级联(顶层单层字段并存会被
    // 级联合同拒绝);否则旧单层载荷,解析逐字不变。
    if object.get("levels").is_some() {
        return decode_probe_grid_cascade_payload(object).map(Some);
    }
    let (header, probes) = parse_grid_level(object, &ProbeGridLevelContext::single(), 1)?;
    let mut records = vec![header];
    records.extend(probes);
    Ok(Some(records))
}

/// 解析错误的定位前缀:单层保持既有逐字错误信息("probe grid"/"probe record"),
/// 级联层提供层号定位("probe grid level {i}"/"level {i} probe record")。
struct ProbeGridLevelContext {
    fields: String,
    records: String,
}

impl ProbeGridLevelContext {
    fn single() -> Self {
        Self {
            fields: "probe grid".to_string(),
            records: "probe record".to_string(),
        }
    }

    fn level(index: usize) -> Self {
        Self {
            fields: format!("probe grid level {index}"),
            records: format!("level {index} probe record"),
        }
    }
}

/// 单层/级联层共用的载荷解析:读 origin/gridSize/spacing、编码网格头(编码时
/// 校验几何合同)、逐条解析并校验探针记录。`base_probe_records` 是写进层头
/// padding 的"本层首条探针记录号"(单层恒 1;级联 = 布局头 + 前面所有层全部
/// 记录 + 本层网格头,与 Rust/Web 打包器一致)。返回(网格头记录, 探针记录)。
fn parse_grid_level(
    object: &serde_json::Map<String, Value>,
    context: &ProbeGridLevelContext,
    base_probe_records: usize,
) -> Result<
    (
        crate::probe_gi_abi::IrradianceProbeRecord,
        Vec<crate::probe_gi_abi::IrradianceProbeRecord>,
    ),
    String,
> {
    use crate::probe_gi_abi::IrradianceProbeRecord;
    use crate::probe_gi_grid::{ProbeGiGridError, ProbeGiGridHeader};
    let fields_prefix = &context.fields;
    let origin = object
        .get("origin")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{fields_prefix} origin must be an array"))?;
    let grid = object
        .get("gridSize")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{fields_prefix} size must be an array"))?;
    let probes = object
        .get("probes")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{fields_prefix} probes must be an array"))?;
    let spacing = object
        .get("spacing")
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{fields_prefix} spacing must be finite"))?;
    let point = |values: &[Value], name: &str| -> Result<[f32; 3], String> {
        values
            .iter()
            .map(|value| {
                value
                    .as_f64()
                    .map(|value| value as f32)
                    .ok_or_else(|| format!("{fields_prefix} {name} must be finite"))
            })
            .collect::<Result<Vec<_>, _>>()
            .map(|values| [values[0], values[1], values[2]])
    };
    let origin = point(origin, "origin")?;
    let unsigned = |value: Option<u64>| -> Result<u32, String> {
        u32::try_from(
            value
                .ok_or_else(|| format!("{fields_prefix} size must be unsigned integers [2,64]"))?,
        )
        .map_err(|_| format!("{fields_prefix} size must be unsigned integers [2,64]"))
    };
    let grid_size = [
        unsigned(grid.first().and_then(Value::as_u64))?,
        unsigned(grid.get(1).and_then(Value::as_u64))?,
        unsigned(grid.get(2).and_then(Value::as_u64))?,
    ];
    let header = ProbeGiGridHeader {
        origin,
        spacing: spacing as f32,
        grid_size,
        probe_count: probes.len() as u32,
    }
    .encode_with_base(base_probe_records)
    .map_err(|error: ProbeGiGridError| format!("{fields_prefix} header rejected: {error:?}"))?;
    let record_prefix = &context.records;
    let mut parsed = Vec::with_capacity(probes.len());
    for (index, probe) in probes.iter().enumerate() {
        let item = probe
            .as_object()
            .ok_or_else(|| format!("{record_prefix} {index} must be an object"))?;
        let irradiance = point(
            item.get("irradiance")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("{record_prefix} {index} irradiance must be an array"))?,
            "irradiance",
        )?;
        let read = |name: &str| -> Result<f32, String> {
            item.get(name)
                .and_then(Value::as_f64)
                .map(|value| value as f32)
                .ok_or_else(|| format!("{record_prefix} {index} {name} must be finite"))
        };
        let mut record = IrradianceProbeRecord::zero();
        record.irradiance = irradiance;
        record.validity = read("validity")?;
        record.mean_distance = read("meanDistance")?;
        record.distance_variance = read("distanceVariance")?;
        record.occlusion_floor = item
            .get("occlusionFloor")
            .and_then(Value::as_f64)
            .map(|value| value as f32)
            .unwrap_or(0.0);
        if let Some(offset) = item.get("positionOffset").and_then(Value::as_array) {
            record.position_offset = point(offset, "positionOffset")?;
        }
        record
            .validate()
            .map_err(|error| format!("{record_prefix} {index} rejected: {error:?}"))?;
        parsed.push(record);
    }
    Ok((header, parsed))
}

/// v2 级联载荷(`levels` 键存在)→ v2 记录流:record 0 = 布局头,随后每层
/// "网格头 + 探针"按细→粗排布(与 Web packNativeProbeGridLevels 同合同)。
/// 合同:顶层旧单层字段与 levels 并存一律拒绝;层数 1..=4;最后过
/// `decode_probe_grid_cascade` 全合同复核(粗层 spacing 严格递增、粗层范围
/// 逐轴包含细层、记录流精确排布、总预算),非法输入 fail-closed。
fn decode_probe_grid_cascade_payload(
    object: &serde_json::Map<String, Value>,
) -> Result<Vec<crate::probe_gi_abi::IrradianceProbeRecord>, String> {
    use crate::probe_gi_grid::{
        PROBE_GI_GRID_MAX_LEVELS, ProbeGiGridLayoutHeader, decode_probe_grid_cascade,
    };
    for key in ["origin", "spacing", "gridSize", "probes"] {
        if object.get(key).is_some() {
            return Err(format!(
                "cascade probe grid must not declare single-level field {key}"
            ));
        }
    }
    let levels = object
        .get("levels")
        .and_then(Value::as_array)
        .ok_or_else(|| "probe grid levels must be an array".to_string())?;
    if levels.is_empty() || levels.len() > PROBE_GI_GRID_MAX_LEVELS {
        return Err(format!(
            "probe grid level count {} outside [1, {PROBE_GI_GRID_MAX_LEVELS}]",
            levels.len()
        ));
    }
    let layout = ProbeGiGridLayoutHeader {
        level_count: levels.len() as u32,
        levels_start_record: 1,
    }
    .encode()
    .map_err(|error| format!("probe grid layout header rejected: {error:?}"))?;
    let mut records = vec![layout];
    let mut cursor = 1usize; // levels 起始记录号:布局头之后紧跟首层网格头。
    for (index, level) in levels.iter().enumerate() {
        let level_object = level
            .as_object()
            .ok_or_else(|| format!("probe grid level {index} must be an object"))?;
        // 本层首条探针记录号 = 当前游标(本层网格头号) + 1。
        let (header, probes) = parse_grid_level(
            level_object,
            &ProbeGridLevelContext::level(index),
            cursor + 1,
        )?;
        records.push(header);
        cursor += 1;
        let probe_count = probes.len();
        records.extend(probes);
        cursor += probe_count;
    }
    // 级联全合同复核:层间嵌套/精确排布/预算,与 renderer init 的装载解码同源。
    decode_probe_grid_cascade(&records)
        .map_err(|error| format!("probe grid cascade rejected: {error:?}"))?;
    Ok(records)
}


#[cfg(test)]
mod probe_grid_tests {
    use super::*;

    #[test]
    fn decodes_grid_into_header_and_records() {
        let environment = serde_json::json!({
            "irradianceProbes": {
                "schema": "deep-engine.probe-grid", "schemaVersion": 1,
                "origin": [-3, -2, -3], "spacing": 2, "gridSize": [2, 2, 2],
                "probes": [
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1000000,"distanceVariance":0}
                ]
            }
        });
        let records = decode_probe_grid(&environment).unwrap().expect("grid must decode");
        assert_eq!(records.len(), 9);
        // 头解码合同:网格头 + 8 探针。
        let header = crate::probe_gi_grid::ProbeGiGridHeader::decode(&records[0]).unwrap();
        assert_eq!(header.probe_count, 8);
        assert_eq!(header.grid_size, [2, 2, 2]);
        // 缺字段(无 irradianceProbes)→ None;坏 schema → Err。
        assert!(decode_probe_grid(&serde_json::json!({})).unwrap().is_none());
        assert!(decode_probe_grid(&serde_json::json!({
            "irradianceProbes": {"schema": "wrong", "schemaVersion": 1}
        })).is_err());
        // 探针记录非法(validity 越界)→ Err。
        let bad = serde_json::json!({
            "irradianceProbes": {"schema": "deep-engine.probe-grid", "schemaVersion": 1,
                "origin": [-3, -2, -3], "spacing": 2, "gridSize": [2, 2, 2],
                "probes": [
                    {"irradiance":[0.5,0.25,0.125],"validity":2,"meanDistance":1,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0},
                    {"irradiance":[0.5,0.25,0.125],"validity":1,"meanDistance":1,"distanceVariance":0}
                ]}
        });
        assert!(decode_probe_grid(&bad).is_err());
    }

    /// 级联层 JSON:2×2×2、8 支确定性探针(与单层测试同探针形状)。
    fn cascade_level(origin: [f64; 3], spacing: f64, validity: f64) -> serde_json::Value {
        let probes: Vec<serde_json::Value> = (0..8)
            .map(|_| {
                serde_json::json!({
                    "irradiance": [0.5, 0.25, 0.125],
                    "validity": validity,
                    "meanDistance": 1000.0,
                    "distanceVariance": 0.0
                })
            })
            .collect();
        serde_json::json!({
            "origin": origin, "spacing": spacing, "gridSize": [2, 2, 2],
            "probes": probes
        })
    }

    fn cascade_environment(levels: Vec<serde_json::Value>) -> serde_json::Value {
        serde_json::json!({
            "irradianceProbes": {
                "schema": "deep-engine.probe-grid", "schemaVersion": 1,
                "levels": levels
            }
        })
    }

    /// v2 级联载荷 → 布局头 + 每层"网格头 + 探针"记录流;层头 padding=
    /// 本层首条探针记录号,记录流可被 renderer 同款 decode_probe_grid_cascade
    /// 解码(细→粗两层、记录精确排布)。
    #[test]
    fn decodes_cascade_levels_into_v2_record_stream() {
        let environment = cascade_environment(vec![
            cascade_level([0.0, 0.0, 0.0], 2.0, 1.0),
            cascade_level([0.0, 0.0, 0.0], 4.0, 1.0),
        ]);
        let records = decode_probe_grid(&environment)
            .unwrap()
            .expect("cascade must decode");
        // 布局头 + (层头+8 探针) × 2 层。
        assert_eq!(records.len(), 1 + (1 + 8) + (1 + 8));
        let layout = crate::probe_gi_grid::ProbeGiGridLayoutHeader::decode(&records[0]).unwrap();
        assert_eq!(layout.level_count, 2);
        assert_eq!(layout.levels_start_record, 1);
        // 层头 padding = 本层首条探针记录号:细层 = 2(布局头+层头之后),
        // 粗层 = 11(布局头 + 细层 9 条 + 粗层层头之后)。
        let fine =
            crate::probe_gi_grid::ProbeGiGridHeader::decode_with_base(&records[1], 2).unwrap();
        let coarse =
            crate::probe_gi_grid::ProbeGiGridHeader::decode_with_base(&records[10], 11).unwrap();
        assert_eq!(fine.spacing, 2.0);
        assert_eq!(coarse.spacing, 4.0);
        // renderer 装载端同款级联解码必须接受该记录流(细→粗、精确排布)。
        let cascade = crate::probe_gi_grid::decode_probe_grid_cascade(&records).unwrap();
        assert_eq!(cascade.levels, vec![fine, coarse]);
        assert_eq!(cascade.header_records, vec![1, 10]);
    }

    /// 互斥合同:顶层旧单层字段与 levels 并存一律拒绝(fail-closed)。
    #[test]
    fn cascade_payload_rejects_single_level_field_coexistence() {
        let mut environment = cascade_environment(vec![cascade_level([0.0; 3], 2.0, 1.0)]);
        environment["irradianceProbes"]["origin"] = serde_json::json!([0, 0, 0]);
        assert!(decode_probe_grid(&environment).is_err());
        let mut environment = cascade_environment(vec![cascade_level([0.0; 3], 2.0, 1.0)]);
        environment["irradianceProbes"]["probes"] = serde_json::json!([]);
        assert!(decode_probe_grid(&environment).is_err());
    }

    /// 层序/包含性非法:粗层 spacing 未严格递增、粗层范围未逐轴包含细层,
    /// 都在级联全合同复核处 fail-closed。
    #[test]
    fn cascade_payload_rejects_level_order_and_containment_violations() {
        // 层序非法:粗层 spacing 与细层相等(未严格递增)。
        let equal_spacing = cascade_environment(vec![
            cascade_level([0.0, 0.0, 0.0], 2.0, 1.0),
            cascade_level([0.0, 0.0, 0.0], 2.0, 1.0),
        ]);
        let error = decode_probe_grid(&equal_spacing).unwrap_err();
        assert!(error.contains("cascade rejected"), "{error}");
        // 包含性非法:粗层 origin 偏移导致范围不再逐轴包含细层。
        let not_containing = cascade_environment(vec![
            cascade_level([0.0, 0.0, 0.0], 2.0, 1.0),
            cascade_level([10.0, 0.0, 0.0], 4.0, 1.0),
        ]);
        let error = decode_probe_grid(&not_containing).unwrap_err();
        assert!(error.contains("cascade rejected"), "{error}");
    }

    /// 层数越界与层内探针非法:空层表/超 4 层/层内 validity 越界全部拒绝,
    /// 错误信息带层号定位。
    #[test]
    fn cascade_payload_rejects_level_count_and_invalid_records() {
        let empty = cascade_environment(vec![]);
        let error = decode_probe_grid(&empty).unwrap_err();
        assert!(error.contains("level count 0"), "{error}");
        let five = cascade_environment((0..5).map(|_| cascade_level([0.0; 3], 1.0, 1.0)).collect());
        assert!(
            decode_probe_grid(&five)
                .unwrap_err()
                .contains("outside [1, 4]")
        );
        let invalid_probe = cascade_environment(vec![cascade_level([0.0; 3], 2.0, 2.0)]);
        let error = decode_probe_grid(&invalid_probe).unwrap_err();
        assert!(error.contains("level 0 probe record"), "{error}");
        // 非数组 levels 与缺 schema 一并 fail-closed。
        let mut not_array = cascade_environment(vec![cascade_level([0.0; 3], 2.0, 1.0)]);
        not_array["irradianceProbes"]["levels"] = serde_json::json!(1);
        assert!(decode_probe_grid(&not_array).is_err());
        let mut wrong_schema = cascade_environment(vec![cascade_level([0.0; 3], 2.0, 1.0)]);
        wrong_schema["irradianceProbes"]["schema"] = serde_json::json!("wrong");
        assert!(decode_probe_grid(&wrong_schema).is_err());
    }
}
