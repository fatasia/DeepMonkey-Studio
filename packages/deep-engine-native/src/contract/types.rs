use serde::{Deserialize, Deserializer, Serialize};

pub(super) fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn present_or_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RenderPacket {
    pub schema: String,
    pub version: u32,
    pub geometries: Vec<GeometryResource>,
    pub materials: Vec<PbrMaterial>,
    pub instances: Vec<RenderInstance>,
    #[serde(default, deserialize_with = "present_or_default")]
    pub textures: Vec<TextureResource>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GeometryResource {
    pub id: String,
    pub revision: u64,
    pub vertices: Vec<f32>,
    #[serde(default, deserialize_with = "present")]
    pub uv0: Option<Vec<f32>>,
    #[serde(default, deserialize_with = "present")]
    pub uv1: Option<Vec<f32>>,
    #[serde(default, deserialize_with = "present")]
    pub tangents: Option<Vec<f32>>,
    #[serde(default, deserialize_with = "present")]
    pub colors: Option<Vec<f32>>,
    pub indices: Vec<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PbrMaterial {
    pub id: String,
    #[serde(default, deserialize_with = "present")]
    pub shading_model: Option<ShadingModel>,
    pub base_color: [f32; 3],
    pub metallic: f32,
    pub roughness: f32,
    #[serde(default, deserialize_with = "present")]
    pub base_color_texture: Option<TextureSlot>,
    #[serde(default, deserialize_with = "present")]
    pub metallic_roughness_texture: Option<TextureSlot>,
    #[serde(default, deserialize_with = "present")]
    pub normal_texture: Option<NormalTextureSlot>,
    #[serde(default, deserialize_with = "present")]
    pub occlusion_texture: Option<OcclusionTextureSlot>,
    #[serde(default, deserialize_with = "present")]
    pub emissive_factor: Option<[f32; 3]>,
    #[serde(default, deserialize_with = "present")]
    pub emissive_texture: Option<TextureSlot>,
    #[serde(default, deserialize_with = "present")]
    pub base_color_alpha: Option<f32>,
    #[serde(default, deserialize_with = "present")]
    pub alpha_mode: Option<AlphaMode>,
    #[serde(default, deserialize_with = "present")]
    pub alpha_cutoff: Option<f32>,
    #[serde(default, deserialize_with = "present")]
    pub double_sided: Option<bool>,
    /// DE26/C03 透明语义:作者 RGB 已按 alpha 预乘。仅 alpha_mode=Blend 合法(validate 把关)。
    #[serde(default, deserialize_with = "present")]
    pub premultiplied_alpha: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TextureSlot {
    pub texture: String,
    #[serde(default, deserialize_with = "present")]
    pub tex_coord: Option<u8>,
    #[serde(default, deserialize_with = "present")]
    pub offset: Option<[f32; 2]>,
    #[serde(default, deserialize_with = "present")]
    pub scale: Option<[f32; 2]>,
    #[serde(default, deserialize_with = "present")]
    pub rotation: Option<f32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NormalTextureSlot {
    pub texture: String,
    #[serde(default, deserialize_with = "present")]
    pub tex_coord: Option<u8>,
    #[serde(default, deserialize_with = "present")]
    pub offset: Option<[f32; 2]>,
    #[serde(default, deserialize_with = "present")]
    pub scale: Option<[f32; 2]>,
    #[serde(default, deserialize_with = "present")]
    pub rotation: Option<f32>,
    #[serde(default, deserialize_with = "present")]
    pub normal_scale: Option<f32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OcclusionTextureSlot {
    pub texture: String,
    #[serde(default, deserialize_with = "present")]
    pub tex_coord: Option<u8>,
    #[serde(default, deserialize_with = "present")]
    pub offset: Option<[f32; 2]>,
    #[serde(default, deserialize_with = "present")]
    pub scale: Option<[f32; 2]>,
    #[serde(default, deserialize_with = "present")]
    pub rotation: Option<f32>,
    #[serde(default, deserialize_with = "present")]
    pub strength: Option<f32>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum ShadingModel {
    #[serde(rename = "unlit")]
    Unlit,
}

#[derive(Clone, Copy, Debug, Deserialize, Hash, PartialEq, Eq)]
pub enum AlphaMode {
    #[serde(rename = "OPAQUE")]
    Opaque,
    #[serde(rename = "MASK")]
    Mask,
    #[serde(rename = "BLEND")]
    Blend,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RenderInstance {
    pub id: String,
    pub geometry: String,
    pub material: String,
    pub transform: [f32; 16],
    #[serde(default, deserialize_with = "present")]
    pub cast_shadow: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    pub receive_shadow: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    pub lod: Option<RenderLodProfile>,
}

#[derive(Clone, Debug)]
pub struct RenderLodProfile {
    pub levels: Vec<RenderLodLevel>,
    pub hysteresis_ratio: Option<f64>,
    pub author: Option<super::author_lod::AuthorSelection>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RenderLodLevel {
    pub geometry: String,
    pub min_projected_diameter_pixels: f64,
    pub geometric_error: f64,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub resident: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TextureResource {
    pub id: String,
    pub revision: u64,
    pub semantic: TextureSemantic,
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    #[serde(default, deserialize_with = "present")]
    pub bytes_per_row: Option<u32>,
    #[serde(default, deserialize_with = "present_or_default")]
    pub mipmaps: Vec<PixelLevel>,
    #[serde(default, deserialize_with = "present")]
    pub sampler: Option<TextureSampler>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextureSemantic {
    BaseColor,
    MetallicRoughness,
    Normal,
    Occlusion,
    Emissive,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PixelLevel {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    #[serde(default, deserialize_with = "present")]
    pub bytes_per_row: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TextureSampler {
    #[serde(default, deserialize_with = "present")]
    pub address_mode_u: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub address_mode_v: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub mag_filter: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub min_filter: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub mipmap_filter: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub max_anisotropy: Option<u8>,
}
