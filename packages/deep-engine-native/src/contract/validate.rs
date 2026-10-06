use std::collections::{HashMap, HashSet};

use super::{
    AlphaMode, CONTRACT_SCHEMA, CONTRACT_VERSION, LayerMaterialParams, LayeredMaterial,
    RenderPacket, StockAdvancedParameters,
    lod::validate_lod,
    uv_sets::MaterialFeatures,
    validate_geometry::{norm, validate_geometries, validate_material_geometry},
    validate_layered_params::validate_layered_params,
    validate_texture,
};

#[derive(Debug, PartialEq, Eq)]
pub struct ContractSummary {
    pub geometries: usize,
    pub materials: usize,
    pub instances: usize,
    pub textures: usize,
    pub triangles: usize,
}

pub fn validate_packet(packet: &RenderPacket) -> Result<ContractSummary, String> {
    if packet.schema != CONTRACT_SCHEMA || packet.version != CONTRACT_VERSION {
        return Err(format!(
            "unsupported contract {} v{}; expected {} v{}",
            packet.schema, packet.version, CONTRACT_SCHEMA, CONTRACT_VERSION
        ));
    }
    if packet.geometries.len() > 4096
        || packet.materials.len() > 16_384
        || packet.instances.len() > 16_384
        || packet.textures.len() > 4096
    {
        return Err("RenderPacket exceeds resource count limits".into());
    }

    let (geometries, triangles) = validate_geometries(&packet.geometries)?;

    let mut material_ids = HashSet::new();
    let mut material_features = HashMap::new();
    for material in &packet.materials {
        unique_id(&mut material_ids, &material.id, "material")?;
        if material
            .ior
            .is_some_and(|value| !value.is_finite() || value < 1.0)
        {
            return Err(format!(
                "material {} has invalid IOR (expected finite >= 1)",
                material.id
            ));
        }
        if material.base_color.iter().any(|&value| !unit(value))
            || !unit(material.metallic)
            || !unit(material.roughness)
        {
            return Err(format!(
                "material {} has a component outside 0..1",
                material.id
            ));
        }
        if material.emissive_factor.is_some_and(|values| {
            values
                .iter()
                .any(|&value| !value.is_finite() || !(0.0..=256.0).contains(&value))
        }) || material.base_color_alpha.is_some_and(|value| !unit(value))
            || material
                .alpha_cutoff
                .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            return Err(format!("material {} has invalid PBR factors", material.id));
        }
        // DE26/C03:premultiplied 只描述 BLEND 的混合公式;其他 alphaMode 声明它属于无效组合。
        if material.premultiplied_alpha.is_some() && material.alpha_mode != Some(AlphaMode::Blend) {
            return Err(format!(
                "material {} declares premultipliedAlpha outside BLEND",
                material.id
            ));
        }
        if let Some(layered) = &material.layered {
            validate_layered_material(material.id.as_str(), layered)?;
            validate_layered_params(material.id.as_str(), material.ior, layered)?;
        }
        validate_stock_extensions(material)?;
        material_features.insert(
            material.id.as_str(),
            MaterialFeatures::from_material(material),
        );
    }
    validate_texture::validate_textures(packet)?;

    let mut instance_ids = HashSet::new();
    for instance in &packet.instances {
        unique_id(&mut instance_ids, &instance.id, "instance")?;
        if !geometries.contains_key(instance.geometry.as_str())
            || !material_ids.contains(&instance.material)
        {
            return Err(format!(
                "instance {} contains a dangling resource reference",
                instance.id
            ));
        }
        let material = material_features[instance.material.as_str()];
        validate_material_geometry(
            geometries[instance.geometry.as_str()],
            material,
            &instance.material,
        )?;
        validate_lod(instance, &geometries, material)?;
        if instance.transform.iter().any(|value| !value.is_finite())
            || instance.transform[3] != 0.0
            || instance.transform[7] != 0.0
            || instance.transform[11] != 0.0
            || instance.transform[15] != 1.0
        {
            return Err(format!(
                "instance {} has a non-affine transform",
                instance.id
            ));
        }
        let x = &instance.transform[0..3];
        let y = &instance.transform[4..7];
        let z = &instance.transform[8..11];
        let determinant = x[0] * (y[1] * z[2] - y[2] * z[1]) - y[0] * (x[1] * z[2] - x[2] * z[1])
            + z[0] * (x[1] * y[2] - x[2] * y[1]);
        let scale = norm(x) * norm(y) * norm(z);
        if !determinant.is_finite() || scale == 0.0 || determinant.abs() < scale * 1e-8 {
            return Err(format!("instance {} has a singular transform", instance.id));
        }
    }

    Ok(ContractSummary {
        geometries: packet.geometries.len(),
        materials: packet.materials.len(),
        instances: packet.instances.len(),
        textures: packet.textures.len(),
        triangles,
    })
}

pub(super) fn unique_id(ids: &mut HashSet<String>, id: &str, label: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 256 || !ids.insert(id.to_string()) {
        return Err(format!("invalid or duplicate {label} id"));
    }
    Ok(())
}

/// I-C23 层栈 fail-closed 校验:层数 ≤2、coverage ∈ 0..1、表面覆盖通道 ∈ 0..1。
/// 层纹理槽的 UV/变换/语义校验与既有一致(validate_texture::validate_material_slots
/// 扩展覆盖层槽);此处只做数值域,纹理引用解析仍由 prepare 路径兜底报错。
fn validate_layered_material(material: &str, layered: &LayeredMaterial) -> Result<(), String> {
    if layered.layers.len() > 2 {
        return Err(format!(
            "material {material} layer stack accepts at most 2 layers"
        ));
    }
    for (index, layer) in layered.layers.iter().enumerate() {
        if layer.coverage.is_some_and(|value| !unit(value)) {
            return Err(format!(
                "material {material} layer {index} coverage must be in 0..1"
            ));
        }
        let Some(surface) = &layer.surface else {
            continue;
        };
        if surface
            .base_color
            .is_some_and(|values: [f32; 3]| values.iter().any(|&value| !unit(value)))
            || surface.metallic.is_some_and(|value| !unit(value))
            || surface.roughness.is_some_and(|value| !unit(value))
        {
            return Err(format!(
                "material {material} layer {index} has a surface component outside 0..1"
            ));
        }
    }
    Ok(())
}

fn unit(value: f32) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

/// C9/native:stock 扩展与 advanced 参数的 fail-closed 校验(数值域 + native
/// 求值子集守卫)。语义逐词对齐 TS:
/// - 扩展域与层 params 同校验(validate_layered_params::validate_parameters 同表);
/// - native 子集只消费 ior+clearcoat:anisotropy.strength/transmission.factor
///   非零拒绝(native 光照核无该两 lobe,不得静默忽略);
/// - extended IOR 必须与实例 IOR 字段一致(TS renderPacketMaterials 同文);
/// - advanced 只放行 sheen:iridescence.factor/volume.thickness 非零拒绝;
/// - unlit 材质拒绝任何扩展 lobe(TS 同文)。
/// 缺省字段(整个 extendedParameters/advancedParameters 缺席)= 扩展带全零 =
/// stock 路径逐位不变(旧包 wire 兼容)。
fn validate_stock_extensions(
    material: &super::PbrMaterial,
) -> Result<(), String> {
    let id = material.id.as_str();
    let unlit = material.shading_model == Some(super::ShadingModel::Unlit);
    if let Some(extended) = &material.extended_parameters {
        if unlit {
            return Err(format!(
                "material {id}: Unlit materials cannot consume PBR extension lobes."
            ));
        }
        validate_stock_extended_ranges(id, extended)?;
        // 与层 base 的 IOR 一致合同同式:f32 精确比较(双方都经 fround 语义)。
        if extended.ior.unwrap_or(1.5) != material.ior.unwrap_or(1.5) {
            return Err(format!(
                "material {id}: Extended material IOR must match the v5 instance IOR field."
            ));
        }
        let aniso_strength = extended.anisotropy.as_ref().and_then(|value| value.strength);
        if aniso_strength.is_some_and(|value| value != 0.0) {
            return Err(format!(
                "material {id}: Native materials do not support nonzero anisotropy.strength."
            ));
        }
        let transmission = extended.transmission.as_ref().and_then(|value| value.factor);
        if transmission.is_some_and(|value| value != 0.0) {
            return Err(format!(
                "material {id}: Native materials do not support nonzero transmission.factor."
            ));
        }
    }
    if let Some(advanced) = &material.advanced_parameters {
        if unlit {
            return Err(format!(
                "material {id}: Unlit materials cannot consume PBR extension lobes."
            ));
        }
        validate_stock_advanced_ranges(id, advanced)?;
        let iridescence = advanced
            .iridescence
            .as_ref()
            .and_then(|value| value.factor);
        if iridescence.is_some_and(|value| value != 0.0) {
            return Err(format!(
                "material {id}: Native advanced subset does not support nonzero iridescence.factor."
            ));
        }
        let volume = advanced.volume.as_ref().and_then(|value| value.thickness);
        if volume.is_some_and(|value| value != 0.0) {
            return Err(format!(
                "material {id}: Native advanced subset does not support nonzero volume.thickness."
            ));
        }
    }
    Ok(())
}

/// 扩展参数数值域(与 validate_layered_params::validate_parameters 同表同文)。
fn validate_stock_extended_ranges(id: &str, params: &LayerMaterialParams) -> Result<(), String> {
    if params
        .ior
        .is_some_and(|value| !value.is_finite() || value < 1.0)
    {
        return Err(format!(
            "material {id}: extendedParameters.ior: Material IOR must be a finite float32 value at least 1."
        ));
    }
    let coat = params.clearcoat.as_ref();
    let aniso = params.anisotropy.as_ref();
    for (field, value, message) in [
        (
            "clearcoat.factor",
            coat.and_then(|value| value.factor),
            "Clearcoat factor must be in 0..1.",
        ),
        (
            "clearcoat.roughness",
            coat.and_then(|value| value.roughness),
            "Clearcoat roughness must be in 0..1.",
        ),
        (
            "anisotropy.strength",
            aniso.and_then(|value| value.strength),
            "Anisotropy strength must be in 0..1.",
        ),
        (
            "transmission.factor",
            params.transmission.as_ref().and_then(|value| value.factor),
            "Transmission factor must be in 0..1.",
        ),
    ] {
        if value.is_some_and(|value| !unit(value)) {
            return Err(format!(
                "material {id}: extendedParameters.{field}: {message}"
            ));
        }
    }
    if aniso
        .and_then(|value| value.rotation)
        .is_some_and(|value| !value.is_finite())
    {
        return Err(format!(
            "material {id}: extendedParameters.anisotropy.rotation: Anisotropy rotation must be a finite number of radians."
        ));
    }
    Ok(())
}

/// advanced 参数数值域(逐词对齐 TS normalizeAdvancedMaterialParameters)。
fn validate_stock_advanced_ranges(
    id: &str,
    advanced: &StockAdvancedParameters,
) -> Result<(), String> {
    if let Some(sheen) = &advanced.sheen {
        if sheen
            .color
            .is_some_and(|values: [f32; 3]| values.iter().any(|&value| !unit(value)))
        {
            return Err(format!(
                "material {id}: advancedParameters.sheen.color: Sheen color must be three finite floats in 0..1."
            ));
        }
        if sheen
            .roughness
            .is_some_and(|value| !unit(value))
        {
            return Err(format!(
                "material {id}: advancedParameters.sheen.roughness: Sheen roughness must be in 0..1."
            ));
        }
    }
    if let Some(iridescence) = &advanced.iridescence {
        let factor = iridescence.factor;
        if factor.is_some_and(|value| !unit(value)) {
            return Err(format!(
                "material {id}: advancedParameters.iridescence.factor: Iridescence factor must be in 0..1."
            ));
        }
        if iridescence
            .ior
            .is_some_and(|value| !value.is_finite() || !(1.0..=3.0).contains(&value))
        {
            return Err(format!(
                "material {id}: advancedParameters.iridescence.ior: Iridescence IOR must be a finite float in 1..3."
            ));
        }
        if iridescence
            .thickness
            .is_some_and(|value| !value.is_finite() || !(0.0..=10000.0).contains(&value))
        {
            return Err(format!(
                "material {id}: advancedParameters.iridescence.thickness: Iridescence thickness (nm) must be a finite float in 0..10000."
            ));
        }
    }
    if let Some(volume) = &advanced.volume {
        if volume
            .thickness
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            return Err(format!(
                "material {id}: advancedParameters.volume.thickness: Volume thickness must be a nonnegative finite float32."
            ));
        }
        if volume.attenuation_color.is_some_and(|values: [f32; 3]| {
            values
                .iter()
                .any(|&value| !value.is_finite() || !(1.0e-6..=1.0).contains(&value))
        }) {
            return Err(format!(
                "material {id}: advancedParameters.volume.attenuationColor: Volume attenuationColor must be three finite floats in 1e-6..1."
            ));
        }
        if volume
            .attenuation_distance
            .is_some_and(|value| !value.is_finite() || value <= 0.0)
        {
            return Err(format!(
                "material {id}: advancedParameters.volume.attenuationDistance: Volume attenuationDistance must be Infinity or a positive finite float32."
            ));
        }
    }
    Ok(())
}

pub(super) fn safe_revision(revision: u64, label: &str) -> Result<(), String> {
    if revision > 9_007_199_254_740_991 {
        return Err(format!(
            "{label} revision exceeds the JavaScript safe integer range"
        ));
    }
    Ok(())
}
