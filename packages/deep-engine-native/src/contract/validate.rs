use std::collections::{HashMap, HashSet};

use super::{
    AlphaMode, CONTRACT_SCHEMA, CONTRACT_VERSION, RenderPacket,
    lod::validate_lod,
    uv_sets::MaterialFeatures,
    validate_geometry::{norm, validate_geometries, validate_material_geometry},
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

fn unit(value: f32) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

pub(super) fn safe_revision(revision: u64, label: &str) -> Result<(), String> {
    if revision > 9_007_199_254_740_991 {
        return Err(format!(
            "{label} revision exceeds the JavaScript safe integer range"
        ));
    }
    Ok(())
}
