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
    #[serde(default)]
    steps: Option<u32>,
    #[serde(default)]
    height: Option<f64>,
    #[serde(default)]
    anisotropy: Option<f64>,
}

impl AuthorFog {
    fn settings(self) -> Result<FogSettings, String> {
        if self.schema_version != 1 {
            return Err(format!(
                "unsupported author fog schema {}",
                self.schema_version
            ));
        }
        if self.kind != "exp2" && self.kind != "volumetric" {
            return Err(format!("unsupported author fog kind {:?}", self.kind));
        }
        let density = self.density as f32;
        let color = self.color_linear_rgb.map(|channel| channel as f32);
        if self.kind == "volumetric" {
            FogSettings::volumetric_with_profile(
                density,
                color,
                self.steps.unwrap_or(8),
                self.height.unwrap_or(64.0) as f32,
                self.anisotropy.unwrap_or(0.0) as f32,
            )
        } else {
            if self.steps.is_some() || self.height.is_some() || self.anisotropy.is_some() {
                return Err("exp2 fog cannot declare volumetric profile fields".into());
            }
            FogSettings::authored_exp2(density, color)
        }
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
#[path = "solid_environment_tests.rs"]
mod tests;

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
#[path = "solid_environment_probe_grid_tests.rs"]
mod probe_grid_tests;
