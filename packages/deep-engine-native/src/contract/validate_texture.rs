use std::collections::{HashMap, HashSet};

use super::{
    RenderPacket,
    types::{
        NormalTextureSlot, OcclusionTextureSlot, TextureResource, TextureSemantic, TextureSlot,
    },
    validate::{safe_revision, unique_id},
};

const MAX_TEXTURE_BYTES: usize = 128 * 1024 * 1024;

pub(super) fn validate_textures(packet: &RenderPacket) -> Result<(), String> {
    let mut texture_ids = HashSet::new();
    let mut texture_bytes = 0usize;
    for texture in &packet.textures {
        unique_id(&mut texture_ids, &texture.id, "texture")?;
        safe_revision(texture.revision, "texture")?;
        if texture.width == 0
            || texture.height == 0
            || texture.width > 16_384
            || texture.height > 16_384
        {
            return Err(format!("texture {} has invalid dimensions", texture.id));
        }
        validate_pixels(
            texture.width,
            texture.height,
            texture.bytes_per_row,
            &texture.data,
        )
        .map_err(|error| format!("texture {} level 0 {error}", texture.id))?;
        texture_bytes = add_bytes(texture_bytes, texture.data.len())?;
        let mut width = texture.width;
        let mut height = texture.height;
        for (index, mip) in texture.mipmaps.iter().enumerate() {
            width = (width / 2).max(1);
            height = (height / 2).max(1);
            if mip.width != width || mip.height != height {
                return Err(format!(
                    "texture {} mip {} has invalid dimensions",
                    texture.id,
                    index + 1
                ));
            }
            validate_pixels(mip.width, mip.height, mip.bytes_per_row, &mip.data)
                .map_err(|error| format!("texture {} mip {} {error}", texture.id, index + 1))?;
            texture_bytes = add_bytes(texture_bytes, mip.data.len())?;
        }
        if !texture.mipmaps.is_empty() && (width != 1 || height != 1) {
            return Err(format!(
                "texture {} has an incomplete mip chain",
                texture.id
            ));
        }
        validate_sampler(texture)?;
    }
    if texture_bytes > MAX_TEXTURE_BYTES {
        return Err("texture data exceeds the 128 MiB packet budget".into());
    }
    validate_material_slots(packet)
}

fn validate_material_slots(packet: &RenderPacket) -> Result<(), String> {
    let semantics: HashMap<_, _> = packet
        .textures
        .iter()
        .map(|texture| (&texture.id, &texture.semantic))
        .collect();
    for material in &packet.materials {
        if let Some(slot) = &material.base_color_texture {
            validate_slot(slot, &material.id)?;
            require_semantic(
                &semantics,
                &slot.texture,
                &material.id,
                TextureSemantic::BaseColor,
            )?;
        }
        if let Some(slot) = &material.metallic_roughness_texture {
            validate_slot(slot, &material.id)?;
            require_semantic(
                &semantics,
                &slot.texture,
                &material.id,
                TextureSemantic::MetallicRoughness,
            )?;
        }
        if let Some(slot) = &material.normal_texture {
            validate_normal_slot(slot, &material.id)?;
            require_semantic(
                &semantics,
                &slot.texture,
                &material.id,
                TextureSemantic::Normal,
            )?;
        }
        if let Some(slot) = &material.occlusion_texture {
            validate_occlusion_slot(slot, &material.id)?;
            require_semantic(
                &semantics,
                &slot.texture,
                &material.id,
                TextureSemantic::Occlusion,
            )?;
        }
        if let Some(slot) = &material.emissive_texture {
            validate_slot(slot, &material.id)?;
            require_semantic(
                &semantics,
                &slot.texture,
                &material.id,
                TextureSemantic::Emissive,
            )?;
        }
    }
    Ok(())
}

fn validate_pixels(
    width: u32,
    height: u32,
    pitch: Option<u32>,
    data: &[u8],
) -> Result<(), &'static str> {
    let row_bytes = width.checked_mul(4).ok_or("row size overflows")?;
    let pitch = pitch.unwrap_or(row_bytes);
    let minimum = pitch as usize * (height as usize - 1) + row_bytes as usize;
    if pitch < row_bytes || data.len() < minimum || data.len() > pitch as usize * height as usize {
        return Err("has an invalid RGBA8 row layout");
    }
    Ok(())
}

fn validate_sampler(texture: &TextureResource) -> Result<(), String> {
    let Some(sampler) = &texture.sampler else {
        return Ok(());
    };
    for address in [&sampler.address_mode_u, &sampler.address_mode_v]
        .into_iter()
        .flatten()
    {
        if !matches!(
            address.as_str(),
            "repeat" | "mirror-repeat" | "clamp-to-edge"
        ) {
            return Err(format!(
                "texture {} has an invalid address mode",
                texture.id
            ));
        }
    }
    let filters: Vec<_> = [
        &sampler.mag_filter,
        &sampler.min_filter,
        &sampler.mipmap_filter,
    ]
    .into_iter()
    .flatten()
    .map(String::as_str)
    .collect();
    if filters
        .iter()
        .any(|filter| !matches!(*filter, "nearest" | "linear"))
    {
        return Err(format!("texture {} has an invalid filter", texture.id));
    }
    let anisotropy = sampler.max_anisotropy.unwrap_or(1);
    if !(1..=16).contains(&anisotropy)
        || (anisotropy > 1 && filters.iter().any(|filter| *filter != "linear"))
    {
        return Err(format!("texture {} has invalid anisotropy", texture.id));
    }
    Ok(())
}

fn validate_slot(slot: &TextureSlot, material: &str) -> Result<(), String> {
    validate_slot_values(
        slot.tex_coord,
        slot.offset,
        slot.scale,
        slot.rotation,
        material,
    )
}

fn validate_normal_slot(slot: &NormalTextureSlot, material: &str) -> Result<(), String> {
    validate_slot_values(
        slot.tex_coord,
        slot.offset,
        slot.scale,
        slot.rotation,
        material,
    )?;
    if slot.normal_scale.is_some_and(|value| !value.is_finite()) {
        return Err(format!("material {material} has an invalid normal scale"));
    }
    let [sx, sy] = slot.scale.unwrap_or([1.0, 1.0]);
    let rotation = slot.rotation.unwrap_or(0.0);
    let (sin, cos) = rotation.sin_cos();
    let (m00, m01, m10, m11) = (cos * sx, -sin * sy, sin * sx, cos * sy);
    let determinant = m00 * m11 - m01 * m10;
    let conditioning = m00.hypot(m01) * m10.hypot(m11);
    if conditioning == 0.0 || determinant.abs() / conditioning < 1e-8 {
        return Err(format!(
            "material {material} has a singular normal texture transform"
        ));
    }
    Ok(())
}

fn validate_occlusion_slot(slot: &OcclusionTextureSlot, material: &str) -> Result<(), String> {
    validate_slot_values(
        slot.tex_coord,
        slot.offset,
        slot.scale,
        slot.rotation,
        material,
    )?;
    if slot
        .strength
        .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
    {
        return Err(format!(
            "material {material} has an invalid occlusion strength"
        ));
    }
    Ok(())
}

fn validate_slot_values(
    tex_coord: Option<u8>,
    offset: Option<[f32; 2]>,
    scale: Option<[f32; 2]>,
    rotation: Option<f32>,
    material: &str,
) -> Result<(), String> {
    if tex_coord.is_some_and(|value| value > 1)
        || offset.is_some_and(|values| values.iter().any(|value| !value.is_finite()))
        || scale.is_some_and(|values| values.iter().any(|value| !value.is_finite()))
        || rotation.is_some_and(|value| !value.is_finite())
    {
        return Err(format!(
            "material {material} has an invalid texture transform"
        ));
    }
    Ok(())
}

fn require_semantic<'a>(
    semantics: &HashMap<&'a String, &'a TextureSemantic>,
    texture: &String,
    material: &str,
    expected: TextureSemantic,
) -> Result<(), String> {
    if semantics.get(texture) != Some(&&expected) {
        return Err(format!(
            "material {material} has a missing or mismatched texture {texture}"
        ));
    }
    Ok(())
}

fn add_bytes(current: usize, additional: usize) -> Result<usize, String> {
    current
        .checked_add(additional)
        .ok_or_else(|| "texture byte count overflow".into())
}
