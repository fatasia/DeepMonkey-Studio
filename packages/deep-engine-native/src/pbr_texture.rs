use std::collections::HashMap;

use crate::contract::{PbrMaterial, RenderPacket, TextureResource, TextureSampler, TextureSemantic, TextureSlot, validate_packet};

pub use crate::mesh_abi::MATERIAL_UNIFORM_FLOATS;
pub use crate::pbr_reference::{decode_tangent_normal, occlusion_factor, srgb_channel_to_linear};

type TextureTransformParts = (Option<u8>, Option<[f32; 2]>, Option<[f32; 2]>, Option<f32>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextureEncoding {
    Linear,
    Srgb,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreparedAddressMode {
    ClampToEdge,
    Repeat,
    MirrorRepeat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreparedFilter {
    Nearest,
    Linear,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreparedSampler {
    pub address_u: PreparedAddressMode,
    pub address_v: PreparedAddressMode,
    pub mag: PreparedFilter,
    pub min: PreparedFilter,
    pub mipmap: PreparedFilter,
    pub anisotropy: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedTextureLevel {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedTexture {
    pub id: String,
    pub revision: u64,
    pub semantic: TextureSemantic,
    pub encoding: TextureEncoding,
    pub sampler: PreparedSampler,
    pub levels: Vec<PreparedTextureLevel>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedMaterial {
    pub id: String,
    pub normal_mapped: bool,
    pub texture_indices: [Option<usize>; 5],
    pub uniform: [f32; MATERIAL_UNIFORM_FLOATS],
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedPbrResources {
    pub textures: Vec<PreparedTexture>,
    pub materials: Vec<PreparedMaterial>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreparedPbrSummary {
    pub textures: usize,
    pub mip_levels: usize,
    pub srgb_textures: usize,
    pub linear_textures: usize,
    pub material_bindings: usize,
}

impl PreparedPbrResources {
    pub fn summary(&self) -> PreparedPbrSummary {
        let srgb_textures = self
            .textures
            .iter()
            .filter(|texture| texture.encoding == TextureEncoding::Srgb)
            .count();
        PreparedPbrSummary {
            textures: self.textures.len(),
            mip_levels: self
                .textures
                .iter()
                .map(|texture| texture.levels.len())
                .sum(),
            srgb_textures,
            linear_textures: self.textures.len() - srgb_textures,
            material_bindings: self.materials.len(),
        }
    }
}

pub fn prepare_pbr_resources(packet: &RenderPacket) -> Result<PreparedPbrResources, String> {
    validate_packet(packet)?;
    let textures = packet
        .textures
        .iter()
        .map(prepare_texture)
        .collect::<Result<Vec<_>, _>>()?;
    let materials = prepare_material_rows_with(packet, &texture_index_map(packet))?;
    Ok(PreparedPbrResources {
        textures,
        materials,
    })
}

/// C3 uniform-only 快路径:仅构造材质 uniform 行并解析纹理索引,不解码/
/// 不上传纹理,也不做全包校验。纹理引用解析失败时返回 Err,由 stage 层
/// 回落全量路径(全量路径有完整校验与错误呈现)。返回行与
/// `prepare_pbr_resources(packet).materials` 逐字段全等。
pub fn prepare_material_uniform_rows(
    packet: &RenderPacket,
) -> Result<Vec<PreparedMaterial>, String> {
    prepare_material_rows_with(packet, &texture_index_map(packet))
}

fn texture_index_map(packet: &RenderPacket) -> HashMap<&str, usize> {
    packet
        .textures
        .iter()
        .enumerate()
        .map(|(index, texture)| (texture.id.as_str(), index))
        .collect()
}

fn prepare_material_rows_with(
    packet: &RenderPacket,
    indices: &HashMap<&str, usize>,
) -> Result<Vec<PreparedMaterial>, String> {
    packet
        .materials
        .iter()
        .map(|material| {
            let uniform = prepare_material_uniform(material)?;
            let base = material.base_color_texture.as_ref();
            let mr = material.metallic_roughness_texture.as_ref();
            let normal = material.normal_texture.as_ref();
            let ao = material.occlusion_texture.as_ref();
            let emissive = material.emissive_texture.as_ref();
            Ok(PreparedMaterial {
                id: material.id.clone(),
                normal_mapped: normal.is_some(),
                texture_indices: [
                    lookup(base.map(|slot| slot.texture.as_str()), indices)?,
                    lookup(mr.map(|slot| slot.texture.as_str()), indices)?,
                    lookup(normal.map(|slot| slot.texture.as_str()), indices)?,
                    lookup(ao.map(|slot| slot.texture.as_str()), indices)?,
                    lookup(emissive.map(|slot| slot.texture.as_str()), indices)?,
                ],
                uniform,
            })
        })
        .collect()
}

/// Prepare only the numeric material uniform; no texture decoding/upload occurs.
/// C3 uses this for uniform-only incremental updates.
pub fn prepare_material_uniform(material: &PbrMaterial) -> Result<[f32; MATERIAL_UNIFORM_FLOATS], String> {
    let mut uniform = [0.0; MATERIAL_UNIFORM_FLOATS];
    let base = material.base_color_texture.as_ref();
    let mr = material.metallic_roughness_texture.as_ref();
    let normal = material.normal_texture.as_ref();
    let ao = material.occlusion_texture.as_ref();
    let emissive = material.emissive_texture.as_ref();
    write_transform(&mut uniform, 0, base, base.is_some())?;
    write_transform(&mut uniform, 8, mr, mr.is_some())?;
    write_transform_parts(
        &mut uniform,
        16,
        ao.map(|slot| (slot.tex_coord, slot.offset, slot.scale, slot.rotation)),
        ao.is_some(),
    )?;
    uniform[23] = ao.and_then(|slot| slot.strength).unwrap_or(1.0);
    write_transform_parts(
        &mut uniform,
        24,
        normal.map(|slot| (slot.tex_coord, slot.offset, slot.scale, slot.rotation)),
        normal.is_some(),
    )?;
    uniform[31] = normal.and_then(|slot| slot.normal_scale).unwrap_or(1.0);
    write_transform(&mut uniform, 32, emissive, emissive.is_some())?;
    Ok(uniform)
}

fn prepare_texture(texture: &TextureResource) -> Result<PreparedTexture, String> {
    let mut levels = Vec::with_capacity(texture.mipmaps.len() + 1);
    levels.push(compact_level(
        texture.width,
        texture.height,
        texture.bytes_per_row,
        &texture.data,
    ));
    levels.extend(
        texture
            .mipmaps
            .iter()
            .map(|mip| compact_level(mip.width, mip.height, mip.bytes_per_row, &mip.data)),
    );
    let encoding = match texture.semantic {
        TextureSemantic::BaseColor | TextureSemantic::Emissive => TextureEncoding::Srgb,
        TextureSemantic::MetallicRoughness
        | TextureSemantic::Normal
        | TextureSemantic::Occlusion => TextureEncoding::Linear,
    };
    Ok(PreparedTexture {
        id: texture.id.clone(),
        revision: texture.revision,
        semantic: texture.semantic,
        encoding,
        sampler: prepare_sampler(texture.sampler.as_ref())?,
        levels,
    })
}

fn compact_level(
    width: u32,
    height: u32,
    pitch: Option<u32>,
    source: &[u8],
) -> PreparedTextureLevel {
    let row = width as usize * 4;
    let pitch = pitch.unwrap_or(width * 4) as usize;
    let mut data = vec![0; row * height as usize];
    for y in 0..height as usize {
        data[y * row..(y + 1) * row].copy_from_slice(&source[y * pitch..y * pitch + row]);
    }
    PreparedTextureLevel {
        width,
        height,
        data,
    }
}

fn prepare_sampler(input: Option<&TextureSampler>) -> Result<PreparedSampler, String> {
    let input = input.cloned().unwrap_or_default();
    Ok(PreparedSampler {
        address_u: address(input.address_mode_u.as_deref().unwrap_or("repeat"))?,
        address_v: address(input.address_mode_v.as_deref().unwrap_or("repeat"))?,
        mag: filter(input.mag_filter.as_deref().unwrap_or("linear"))?,
        min: filter(input.min_filter.as_deref().unwrap_or("linear"))?,
        mipmap: filter(input.mipmap_filter.as_deref().unwrap_or("linear"))?,
        anisotropy: input.max_anisotropy.unwrap_or(1) as u16,
    })
}

fn address(value: &str) -> Result<PreparedAddressMode, String> {
    match value {
        "clamp-to-edge" => Ok(PreparedAddressMode::ClampToEdge),
        "repeat" => Ok(PreparedAddressMode::Repeat),
        "mirror-repeat" => Ok(PreparedAddressMode::MirrorRepeat),
        _ => Err("invalid texture address mode after contract validation".into()),
    }
}

fn filter(value: &str) -> Result<PreparedFilter, String> {
    match value {
        "nearest" => Ok(PreparedFilter::Nearest),
        "linear" => Ok(PreparedFilter::Linear),
        _ => Err("invalid texture filter after contract validation".into()),
    }
}

fn lookup(id: Option<&str>, indices: &HashMap<&str, usize>) -> Result<Option<usize>, String> {
    id.map(|id| {
        indices
            .get(id)
            .copied()
            .ok_or_else(|| format!("texture {id} disappeared after validation"))
    })
    .transpose()
}

fn write_transform(
    output: &mut [f32],
    offset: usize,
    slot: Option<&TextureSlot>,
    enabled: bool,
) -> Result<(), String> {
    write_transform_parts(
        output,
        offset,
        slot.map(|slot| (slot.tex_coord, slot.offset, slot.scale, slot.rotation)),
        enabled,
    )
}

fn write_transform_parts(
    output: &mut [f32],
    offset: usize,
    values: Option<TextureTransformParts>,
    enabled: bool,
) -> Result<(), String> {
    let (tex_coord, translation, scale, rotation) = values.unwrap_or((None, None, None, None));
    let [tx, ty] = translation.unwrap_or([0.0, 0.0]);
    let [sx, sy] = scale.unwrap_or([1.0, 1.0]);
    let (sin, cos) = rotation.unwrap_or(0.0).sin_cos();
    let selector = match (enabled, tex_coord.unwrap_or(0)) {
        (false, _) => 0.0,
        (true, 0) => 1.0,
        (true, 1) => 2.0,
        (true, _) => return Err("texture coordinate selection escaped contract validation".into()),
    };
    let matrix = [
        cos * sx,
        -sin * sy,
        tx,
        selector,
        sin * sx,
        cos * sy,
        ty,
        0.0,
    ];
    if matrix.iter().any(|value| !value.is_finite()) {
        return Err("texture transform exceeds finite float32 range".into());
    }
    output[offset..offset + 8].copy_from_slice(&matrix);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{default_textured_fixture_path, load_and_validate};

    /// C3 快路径行与全量 prepare 的材质段逐字段全等(含纹理索引解析)。
    #[test]
    fn uniform_rows_match_full_prepare_materials() {
        let (packet, _) = load_and_validate(default_textured_fixture_path()).unwrap();
        let rows = prepare_material_uniform_rows(&packet).unwrap();
        let full = prepare_pbr_resources(&packet).unwrap();
        assert_eq!(rows, full.materials);
        assert!(!rows.is_empty());
    }

    /// 纹理引用解析失败必须报错,让 stage 层回落全量路径,而不是产出
    /// 带错误槽位的行。
    #[test]
    fn unresolvable_texture_reference_is_an_error() {
        let (mut packet, _) = load_and_validate(default_textured_fixture_path()).unwrap();
        let target = packet
            .materials
            .iter_mut()
            .find(|material| material.base_color_texture.is_some())
            .expect("textured fixture has a base-color-mapped material");
        let missing = format!("{}-missing", target.base_color_texture.as_ref().unwrap().texture);
        target.base_color_texture.as_mut().unwrap().texture = missing;
        assert!(prepare_material_uniform_rows(&packet).is_err());
    }

    /// 数值摄动(纹理变换)不改变纹理槽位与 normal-mapped 特征,因此
    /// classify 的 Structural 前置条件保持成立(UniformOnly 的充分前提)。
    /// 反向事实同时钉死:metallic 走实例缓冲词 24..28,不在材质 uniform
    /// 内——metallic-only 变化的行全等,classify 判 Identical,由 stage
    /// 守卫回落全量路径(实例缓冲重建),不会原位覆写。
    #[test]
    fn numeric_perturbation_keeps_texture_topology() {
        let (mut packet, _) = load_and_validate(default_textured_fixture_path()).unwrap();
        let before = prepare_material_uniform_rows(&packet).unwrap();
        let slot_offset = packet
            .materials
            .iter()
            .position(|material| material.base_color_texture.is_some())
            .expect("textured fixture has a base-color-mapped material");
        let offset = packet.materials[slot_offset]
            .base_color_texture
            .as_mut()
            .unwrap()
            .offset
            .unwrap_or([0.0, 0.0]);
        packet.materials[slot_offset]
            .base_color_texture
            .as_mut()
            .unwrap()
            .offset = Some([offset[0] + 0.25, offset[1]]);
        let after = prepare_material_uniform_rows(&packet).unwrap();
        assert_eq!(before[slot_offset].texture_indices, after[slot_offset].texture_indices);
        assert_eq!(before[slot_offset].normal_mapped, after[slot_offset].normal_mapped);
        assert_eq!(before[slot_offset].id, after[slot_offset].id);
        assert_ne!(before[slot_offset].uniform, after[slot_offset].uniform);
    }

    #[test]
    fn metallic_only_change_does_not_alter_uniform_rows() {
        let (mut packet, _) = load_and_validate(default_textured_fixture_path()).unwrap();
        let before = prepare_material_uniform_rows(&packet).unwrap();
        packet.materials[0].metallic = 1.0 - packet.materials[0].metallic;
        let after = prepare_material_uniform_rows(&packet).unwrap();
        assert_eq!(before, after);
    }

    /// 无纹理引用包:索引全 None,uniform 为全缺省行(选择器 0、strength
    /// 缺省 1.0)。材质不得引用不存在的纹理(解析合同)。
    #[test]
    fn textureless_packet_produces_selector_zero_rows() {
        let material = PbrMaterial {
            id: "m".into(),
            shading_model: None,
            base_color: [0.1, 0.2, 0.3],
            metallic: 0.4,
            roughness: 0.6,
            base_color_texture: None,
            metallic_roughness_texture: None,
            normal_texture: None,
            occlusion_texture: None,
            emissive_factor: None,
            emissive_texture: None,
            base_color_alpha: None,
            alpha_mode: None,
            alpha_cutoff: None,
            double_sided: None,
            premultiplied_alpha: None,
        };
        let packet = RenderPacket {
            schema: crate::contract::CONTRACT_SCHEMA.into(),
            version: crate::contract::CONTRACT_VERSION,
            geometries: Vec::new(),
            materials: vec![material],
            instances: Vec::new(),
            textures: Vec::new(),
        };
        let rows = prepare_material_uniform_rows(&packet).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].texture_indices, [None; 5]);
        // selector 0(禁用)+ strength 缺省 1.0,与 prepare_material_uniform 合同一致。
        assert_eq!(rows[0].uniform[3], 0.0);
        assert_eq!(rows[0].uniform[23], 1.0);
    }
}
