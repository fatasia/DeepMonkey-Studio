use std::{borrow::Cow, collections::HashMap};

use crate::contract::{
    LayerMaterialParams, PbrMaterial, RenderPacket, StockAdvancedParameters, TextureResource,
    TextureSampler, TextureSemantic, TextureSlot, validate_packet,
};
use crate::mesh_abi::{
    MATERIAL_ADVANCED_BAND_FLOAT_OFFSET, MATERIAL_EXTENDED_BAND_FLOAT_OFFSET,
    MATERIAL_UNIFORM_ROW_FLOATS, MaterialUniformRow,
};
use crate::pbr_layered::{
    LAYERED_SURFACE_BLOCK_FLOATS, LayerTextureBinding, LayeredBlockRow, layered_block_rows,
    pack_layered_surface_block,
};

pub use crate::mesh_abi::MATERIAL_UNIFORM_FLOATS;
pub use crate::pbr_reference::{decode_tangent_normal, occlusion_factor, srgb_channel_to_linear};
#[cfg(test)]
#[path = "pbr_texture_specular_tests.rs"]
mod specular_tests;

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
pub struct PreparedTextureLevel<'a> {
    pub width: u32,
    pub height: u32,
    pub data: Cow<'a, [u8]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedTexture<'a> {
    pub id: String,
    pub revision: u64,
    pub semantic: TextureSemantic,
    pub encoding: TextureEncoding,
    pub sampler: PreparedSampler,
    pub levels: Vec<PreparedTextureLevel<'a>>,
    pub generate_mipmaps: bool,
}

impl PreparedTexture<'_> {
    pub fn mip_level_count(&self) -> u32 {
        if self.generate_mipmaps {
            self.levels[0].width.max(self.levels[0].height).ilog2() + 1
        } else {
            self.levels.len() as u32
        }
    }
    pub fn gpu_bytes(&self) -> u64 {
        let base = &self.levels[0];
        (0..self.mip_level_count())
            .map(|level| {
                u64::from((base.width >> level).max(1))
                    * u64::from((base.height >> level).max(1))
                    * 4
            })
            .sum()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedMaterial {
    pub id: String,
    pub normal_mapped: bool,
    pub texture_indices: [Option<usize>; 7],
    pub uniform: MaterialUniformRow,
    /// I-C23 分层材质:304B 块 + 按槽纹理索引 [base0, mr0, base1, mr1]。
    /// 无层材质为 None;层的数组层码在 native D2 借用下恒 0(打包已固定)。
    pub layered: Option<PreparedLayeredMaterial>,
}

impl PreparedMaterial {
    pub fn uses_extended_response(&self) -> bool {
        [41, 43, 45, 48, 49, 50]
            .iter()
            .any(|&i| self.uniform[i] != 0.0)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedLayeredMaterial {
    pub block: [f32; LAYERED_SURFACE_BLOCK_FLOATS],
    pub texture_indices: [Option<usize>; 4],
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedPbrResources<'a> {
    pub textures: Vec<PreparedTexture<'a>>,
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

impl PreparedPbrResources<'_> {
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

pub fn prepare_pbr_resources(packet: &RenderPacket) -> Result<PreparedPbrResources<'_>, String> {
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
            let layered = prepare_layered_material(material, indices)?;
            Ok(PreparedMaterial {
                id: material.id.clone(),
                normal_mapped: normal.is_some(),
                texture_indices: [
                    lookup(base.map(|slot| slot.texture.as_str()), indices)?,
                    lookup(mr.map(|slot| slot.texture.as_str()), indices)?,
                    lookup(normal.map(|slot| slot.texture.as_str()), indices)?,
                    lookup(ao.map(|slot| slot.texture.as_str()), indices)?,
                    lookup(emissive.map(|slot| slot.texture.as_str()), indices)?,
                    lookup(
                        material
                            .specular_texture
                            .as_ref()
                            .map(|slot| slot.texture.as_str()),
                        indices,
                    )?,
                    lookup(
                        material
                            .specular_color_texture
                            .as_ref()
                            .map(|slot| slot.texture.as_str()),
                        indices,
                    )?,
                ],
                uniform,
                layered,
            })
        })
        .collect()
}

/// I-C23:分层材质行准备。无层材质返回 None;层行只含 coverage>0 的活动层,
/// 纹理引用沿基材同一索引解析(缺引用 fail-closed 报错)。
/// UV 变换与基材 `write_transform_parts` 同式(cos*sx, -sin*sy, tx, sin*sx, cos*sy, ty)。
pub fn prepare_layered_material(
    material: &PbrMaterial,
    indices: &HashMap<&str, usize>,
) -> Result<Option<PreparedLayeredMaterial>, String> {
    let Some(layered) = &material.layered else {
        return Ok(None);
    };
    let transform_of = |slot: &TextureSlot| -> Result<LayerTextureBinding, String> {
        let [tx, ty] = slot.offset.unwrap_or([0.0, 0.0]);
        let [sx, sy] = slot.scale.unwrap_or([1.0, 1.0]);
        let (sin, cos) = slot.rotation.unwrap_or(0.0).sin_cos();
        let tex_coord = slot.tex_coord.unwrap_or(0);
        if tex_coord > 1 {
            return Err(format!(
                "material {} layer texture UV set escaped contract validation",
                material.id
            ));
        }
        let normalize = |value: f32| if value == 0.0 { 0.0 } else { value };
        Ok(LayerTextureBinding {
            uv_transform: [
                normalize(cos * sx),
                normalize(-sin * sy),
                normalize(tx),
                normalize(sin * sx),
                normalize(cos * sy),
                normalize(ty),
            ],
            tex_coord,
            array_layer: 0,
        })
    };
    let rows: Vec<LayeredBlockRow> = layered_block_rows(material, transform_of)?;
    // 纹理引用解析:沿活动层 surface 槽顺序 [base0, mr0, base1, mr1],缺引用报错。
    let mut resolved = [None; 4];
    let mut cursor = 0usize;
    for layer in &layered.layers {
        if layer.coverage.unwrap_or(0.0) == 0.0 {
            continue;
        }
        if let Some(surface) = &layer.surface {
            for slot in [
                surface.base_color_texture.as_ref(),
                surface.metallic_roughness_texture.as_ref(),
            ] {
                if let Some(slot) = slot {
                    resolved[cursor] = lookup(Some(slot.texture.as_str()), indices)?;
                }
                cursor += 1;
            }
        } else {
            cursor += 2;
        }
    }
    debug_assert!(cursor <= 4, "layer stack depth is validated at most 2");
    Ok(Some(PreparedLayeredMaterial {
        block: pack_layered_surface_block(&rows),
        texture_indices: resolved,
    }))
}

/// Prepare only the numeric material uniform; no texture decoding/upload occurs.
/// C3 uses this for uniform-only incremental updates.
///
/// C9/native 扩展带:核心块 0..40(legacy 逐位不变)之上,40..46 写 Web
/// `packExtendedParameterBlock` 同序的 6 float(ior, clearcoatFactor,
/// clearcoatRoughness, anisotropyStrength, anisotropyRotation, transmissionFactor,
/// 缺省域与 TS serializeMaterialParameters 一致);48..52 写 advanced 带 sheen
/// 四元组(color.rgb + roughness,TS packAdvancedParameterBlock 前 4 float 同序,
/// 缺省 [0,0,0,1])。46..48 与 52..60 恒零(合同拒绝 anisotropy/transmission/
/// iridescence/volume 非零,槽位无载荷)。无扩展/advanced 字段时全带零——
/// WGSL 据此走原 stock 分支,旧包渲染逐位不变。
pub fn prepare_material_uniform(material: &PbrMaterial) -> Result<MaterialUniformRow, String> {
    let mut uniform = [0.0; MATERIAL_UNIFORM_ROW_FLOATS];
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
    if let Some(extended) = &material.extended_parameters {
        uniform[MATERIAL_EXTENDED_BAND_FLOAT_OFFSET..MATERIAL_UNIFORM_FLOATS]
            .copy_from_slice(&extended_band_words(extended));
    }
    if let Some(advanced) = &material.advanced_parameters {
        uniform[MATERIAL_ADVANCED_BAND_FLOAT_OFFSET..MATERIAL_ADVANCED_BAND_FLOAT_OFFSET + 4]
            .copy_from_slice(&sheen_band_words(advanced));
    }
    write_transform(
        &mut uniform,
        60,
        material.specular_texture.as_ref(),
        material.specular_texture.is_some(),
    )?;
    write_transform(
        &mut uniform,
        68,
        material.specular_color_texture.as_ref(),
        material.specular_color_texture.is_some(),
    )?;
    let color = material.specular_color_factor.unwrap_or([1.0; 3]);
    uniform[76..80].copy_from_slice(&[
        color[0],
        color[1],
        color[2],
        material.specular_factor.unwrap_or(1.0),
    ]);
    Ok(uniform)
}

/// 扩展带 6 词(TS serializeMaterialParameters 缺省域:ior=1.5,coat 0/0,
/// anisotropy 0/0,transmission 0)。native 合同已拒绝 anisotropy/transmission
/// 非零,槽位照写以保持与 Web 打包带逐词同构。
fn extended_band_words(params: &LayerMaterialParams) -> [f32; 6] {
    [
        params.ior.unwrap_or(1.5),
        params
            .clearcoat
            .as_ref()
            .and_then(|value| value.factor)
            .unwrap_or(0.0),
        params
            .clearcoat
            .as_ref()
            .and_then(|value| value.roughness)
            .unwrap_or(0.0),
        params
            .anisotropy
            .as_ref()
            .and_then(|value| value.strength)
            .unwrap_or(0.0),
        params
            .anisotropy
            .as_ref()
            .and_then(|value| value.rotation)
            .unwrap_or(0.0),
        params
            .transmission
            .as_ref()
            .and_then(|value| value.factor)
            .unwrap_or(0.0),
    ]
}

/// advanced 带 sheen 四词(TS packAdvancedParameterBlock 前 4 float:rgb+roughness,
/// 缺省 [0,0,0,1]);iridescence/volume 槽由合同保持零,此处不写。
fn sheen_band_words(params: &StockAdvancedParameters) -> [f32; 4] {
    let sheen = params.sheen.as_ref();
    [
        sheen
            .and_then(|value| value.color)
            .map(|color| color[0])
            .unwrap_or(0.0),
        sheen
            .and_then(|value| value.color)
            .map(|color| color[1])
            .unwrap_or(0.0),
        sheen
            .and_then(|value| value.color)
            .map(|color| color[2])
            .unwrap_or(0.0),
        sheen.and_then(|value| value.roughness).unwrap_or(1.0),
    ]
}

fn prepare_texture(texture: &TextureResource) -> Result<PreparedTexture<'_>, String> {
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
        TextureSemantic::BaseColor | TextureSemantic::Emissive | TextureSemantic::SpecularColor => {
            TextureEncoding::Srgb
        }
        TextureSemantic::MetallicRoughness
        | TextureSemantic::Normal
        | TextureSemantic::Occlusion
        | TextureSemantic::Specular => TextureEncoding::Linear,
    };
    Ok(PreparedTexture {
        id: texture.id.clone(),
        revision: texture.revision,
        semantic: texture.semantic,
        encoding,
        sampler: prepare_sampler(texture.sampler.as_ref())?,
        levels,
        generate_mipmaps: texture.generate_mipmaps,
    })
}

fn compact_level(
    width: u32,
    height: u32,
    pitch: Option<u32>,
    source: &[u8],
) -> PreparedTextureLevel<'_> {
    let row = width as usize * 4;
    let pitch = pitch.unwrap_or(width * 4) as usize;
    if pitch == row {
        return PreparedTextureLevel {
            width,
            height,
            data: Cow::Borrowed(&source[..row * height as usize]),
        };
    }
    let mut data = vec![0; row * height as usize];
    for y in 0..height as usize {
        data[y * row..(y + 1) * row].copy_from_slice(&source[y * pitch..y * pitch + row]);
    }
    PreparedTextureLevel {
        width,
        height,
        data: Cow::Owned(data),
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

    #[test]
    fn compact_pixels_borrow_and_only_padded_rows_allocate() {
        let pixels = [1, 2, 3, 4, 5, 6, 7, 8];
        let compact = compact_level(1, 2, None, &pixels);
        assert!(matches!(compact.data, Cow::Borrowed(_)));
        assert_eq!(compact.data.as_ptr(), pixels.as_ptr());
        let padded = [1, 2, 3, 4, 0, 0, 0, 0, 5, 6, 7, 8, 0, 0, 0, 0];
        let compact = compact_level(1, 2, Some(8), &padded);
        assert!(matches!(compact.data, Cow::Owned(_)));
        assert_eq!(compact.data.as_ref(), &pixels);
    }

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
        let missing = format!(
            "{}-missing",
            target.base_color_texture.as_ref().unwrap().texture
        );
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
        assert_eq!(
            before[slot_offset].texture_indices,
            after[slot_offset].texture_indices
        );
        assert_eq!(
            before[slot_offset].normal_mapped,
            after[slot_offset].normal_mapped
        );
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
            ior: None,
            base_color_texture: None,
            metallic_roughness_texture: None,
            normal_texture: None,
            occlusion_texture: None,
            emissive_factor: None,
            emissive_texture: None,
            specular_factor: None,
            specular_color_factor: None,
            specular_texture: None,
            specular_color_texture: None,
            base_color_alpha: None,
            alpha_mode: None,
            alpha_cutoff: None,
            double_sided: None,
            premultiplied_alpha: None,
            fog: None,
            layered: None,
            extended_parameters: None,
            advanced_parameters: None,
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
        assert_eq!(rows[0].texture_indices, [None; 7]);
        // selector 0(禁用)+ strength 缺省 1.0,与 prepare_material_uniform 合同一致。
        assert_eq!(rows[0].uniform[3], 0.0);
        assert_eq!(rows[0].uniform[23], 1.0);
    }

    /// 旧 40 float 包 wire 兼容:无扩展/advanced 字段的材质行 = 核心 40 float
    /// 原值 + 扩展带/advanced 带全零(GPU 缓冲 240B 中 160B 核心块逐字节不变)。
    #[test]
    fn legacy_packet_keeps_core_block_and_zero_bands() {
        use crate::mesh_abi::{
            MATERIAL_ADVANCED_BAND_FLOAT_OFFSET, MATERIAL_EXTENDED_BAND_FLOAT_OFFSET,
            MATERIAL_UNIFORM_FLOATS,
        };
        let (packet, _) = load_and_validate(default_textured_fixture_path()).unwrap();
        let rows = prepare_material_uniform_rows(&packet).unwrap();
        for row in &rows {
            assert!(
                row.uniform[MATERIAL_EXTENDED_BAND_FLOAT_OFFSET..60]
                    .iter()
                    .all(|value| *value == 0.0),
                "material {} extension band must stay zero without extendedParameters",
                row.id
            );
            assert!(
                row.uniform[MATERIAL_ADVANCED_BAND_FLOAT_OFFSET..60]
                    .iter()
                    .all(|value| *value == 0.0),
                "material {} advanced band must stay zero without advancedParameters",
                row.id
            );
        }
        // 核心块哨兵:40 float 界内仍是 textureless 合同的 selector/strength 语义。
        assert_eq!(MATERIAL_UNIFORM_FLOATS, 46);
        assert_eq!(MATERIAL_EXTENDED_BAND_FLOAT_OFFSET, 40);
    }

    /// 扩展/advanced 带:pack 词序与缺省域(TS packExtendedParameterBlock /
    /// packAdvancedParameterBlock 前 4 float 同序同缺省)。
    #[test]
    fn extension_and_advanced_bands_pack_in_ts_word_order() {
        use crate::contract::{
            LayerAnisotropyParams, LayerClearcoatParams, LayerTransmissionParams,
            StockAdvancedParameters, StockSheenParameters,
        };
        let material = PbrMaterial {
            id: "m".into(),
            shading_model: None,
            base_color: [0.1, 0.2, 0.3],
            metallic: 0.4,
            roughness: 0.6,
            ior: Some(1.52),
            base_color_texture: None,
            metallic_roughness_texture: None,
            normal_texture: None,
            occlusion_texture: None,
            emissive_factor: None,
            emissive_texture: None,
            specular_factor: None,
            specular_color_factor: None,
            specular_texture: None,
            specular_color_texture: None,
            base_color_alpha: None,
            alpha_mode: None,
            alpha_cutoff: None,
            double_sided: None,
            premultiplied_alpha: None,
            fog: None,
            layered: None,
            extended_parameters: Some(LayerMaterialParams {
                ior: Some(1.52),
                clearcoat: Some(LayerClearcoatParams {
                    factor: Some(0.9),
                    roughness: Some(0.3),
                }),
                anisotropy: Some(LayerAnisotropyParams {
                    strength: Some(0.0),
                    rotation: Some(0.0),
                }),
                transmission: Some(LayerTransmissionParams { factor: Some(0.0) }),
            }),
            advanced_parameters: Some(StockAdvancedParameters {
                sheen: Some(StockSheenParameters {
                    color: Some([0.25, 0.5, 0.75]),
                    roughness: Some(0.4),
                }),
                iridescence: None,
                volume: None,
            }),
        };
        let uniform = prepare_material_uniform(&material).unwrap();
        assert_eq!(uniform[40..46], [1.52, 0.9, 0.3, 0.0, 0.0, 0.0]);
        assert_eq!(uniform[48..52], [0.25, 0.5, 0.75, 0.4]);
        // iridescence/volume 槽保持零(native 子集合同)。
        assert!(uniform[52..60].iter().all(|value| *value == 0.0));
        // 缺省域:只有 partial 字段时按 TS 缺省填充。
        let mut partial = material.clone();
        partial.extended_parameters = Some(LayerMaterialParams {
            ior: None,
            clearcoat: None,
            anisotropy: None,
            transmission: None,
        });
        partial.advanced_parameters = Some(StockAdvancedParameters {
            sheen: None,
            iridescence: None,
            volume: None,
        });
        let uniform = prepare_material_uniform(&partial).unwrap();
        assert_eq!(uniform[40..46], [1.5, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(uniform[48..52], [0.0, 0.0, 0.0, 1.0]);
    }
}
