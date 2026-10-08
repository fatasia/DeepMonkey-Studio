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

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PbrMaterial {
    pub id: String,
    #[serde(default, deserialize_with = "present")]
    pub shading_model: Option<ShadingModel>,
    pub base_color: [f32; 3],
    pub metallic: f32,
    pub roughness: f32,
    #[serde(default, deserialize_with = "present")]
    pub ior: Option<f32>,
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
    pub specular_factor: Option<f32>,
    #[serde(default, deserialize_with = "present")]
    pub specular_color_factor: Option<[f32; 3]>,
    #[serde(default, deserialize_with = "present")]
    pub specular_texture: Option<TextureSlot>,
    #[serde(default, deserialize_with = "present")]
    pub specular_color_texture: Option<TextureSlot>,
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
    /// 缺省/true 接受场景雾；false 与 Browser 实例 ABI 的 bit 32 对齐。
    #[serde(default, deserialize_with = "present")]
    pub fog: Option<bool>,
    /// I-C23 分层材质层栈(base + ≤2 层,每层自带扩展参数/覆盖率/混合语义/按层表面)。
    /// Native 消费层 IOR、颜色/MR/UV、coverage 与 replace/overlay 凸混合。
    /// 活动层清漆替换主方向光;IBL/GI/局部灯/自发光保持 stock。
    /// 基材清漆与各向异性/透射由发布合同拒绝。
    #[serde(default, deserialize_with = "present")]
    pub layered: Option<LayeredMaterial>,
    /// C9 stock 扩展参数(键值域与 TS `ExtendedMaterialParameters`/层 params 同构;
    /// 复用 LayerMaterialParams 闭合结构)。native consumes IOR/clearcoat and
    /// screen-space opaque transmission; nonzero anisotropy remains unsupported.
    /// Absent fields preserve the stock response.
    #[serde(default, deserialize_with = "present")]
    pub extended_parameters: Option<LayerMaterialParams>,
    /// advancedMaterials 保守子集(native):只消费 sheen(直射 Charlie lobe +
    /// 直/间接能量补偿);iridescence.factor 与 volume.thickness 非零由 validate
    /// fail-closed 拒绝。unlit 材质拒绝(与 Web 同界)。
    #[serde(default, deserialize_with = "present")]
    pub advanced_parameters: Option<StockAdvancedParameters>,
}

/// advancedMaterials 的闭合域形态(与 TS `AdvancedMaterialParameters` 键值域同构,
/// camelCase,deny_unknown_fields)。native 只消费 sheen 子集,其余字段保留域以
/// 便 fail-closed 语义对 TS 逐词一致(拒绝而非未知字段报错)。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StockAdvancedParameters {
    #[serde(default, deserialize_with = "present")]
    pub sheen: Option<StockSheenParameters>,
    #[serde(default, deserialize_with = "present")]
    pub iridescence: Option<StockIridescenceParameters>,
    #[serde(default, deserialize_with = "present")]
    pub volume: Option<StockVolumeParameters>,
}

impl PbrMaterial {
    pub fn transmission_factor(&self) -> f32 {
        self.extended_parameters.as_ref()
            .and_then(|parameters| parameters.transmission.as_ref())
            .and_then(|transmission| transmission.factor).unwrap_or(0.0)
    }

    pub fn draw_alpha_mode(&self) -> AlphaMode {
        if self.transmission_factor() > 0.0 { AlphaMode::Blend }
        else { self.alpha_mode.unwrap_or(AlphaMode::Opaque) }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StockSheenParameters {
    /// 线性 0..1;全 0 = 无 sheen(three 默认)。
    #[serde(default, deserialize_with = "present")]
    pub color: Option<[f32; 3]>,
    /// 0..1;求值时夹取到 [0.0001, 1]。
    #[serde(default, deserialize_with = "present")]
    pub roughness: Option<f32>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StockIridescenceParameters {
    /// 0..1;native 子集必须为 0(validate 拒绝非零)。
    #[serde(default, deserialize_with = "present")]
    pub factor: Option<f32>,
    /// 薄膜折射率 1..3。
    #[serde(default, deserialize_with = "present")]
    pub ior: Option<f32>,
    /// 薄膜厚度(nm)0..10000。
    #[serde(default, deserialize_with = "present")]
    pub thickness: Option<f32>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StockVolumeParameters {
    /// 体积厚度 ≥0;native 子集必须为 0(validate 拒绝非零)。
    #[serde(default, deserialize_with = "present")]
    pub thickness: Option<f32>,
    /// Beer-Lambert 衰减色 (0,1]。
    #[serde(default, deserialize_with = "present")]
    pub attenuation_color: Option<[f32; 3]>,
    /// 衰减距离;缺省/Infinity = 不衰减(打包为 0 哨兵,与 TS 一致)。
    #[serde(default, deserialize_with = "present")]
    pub attenuation_distance: Option<f32>,
}

/// 扩展材质参数的层形态(与 TS `ExtendedMaterialParameters` 键值域同构,camelCase)。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LayerMaterialParams {
    #[serde(default, deserialize_with = "present")]
    pub ior: Option<f32>,
    #[serde(default, deserialize_with = "present")]
    pub clearcoat: Option<LayerClearcoatParams>,
    #[serde(default, deserialize_with = "present")]
    pub anisotropy: Option<LayerAnisotropyParams>,
    #[serde(default, deserialize_with = "present")]
    pub transmission: Option<LayerTransmissionParams>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LayerClearcoatParams {
    #[serde(default, deserialize_with = "present")]
    pub factor: Option<f32>,
    #[serde(default, deserialize_with = "present")]
    pub roughness: Option<f32>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LayerAnisotropyParams {
    #[serde(default, deserialize_with = "present")]
    pub strength: Option<f32>,
    #[serde(default, deserialize_with = "present")]
    pub rotation: Option<f32>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LayerTransmissionParams {
    #[serde(default, deserialize_with = "present")]
    pub factor: Option<f32>,
}

/// 层混合语义(与 TS MATERIAL_LAYER_BLEND_MODE_CODES 互钉:replace=0 / overlay=1)。
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum LayerBlendMode {
    #[serde(rename = "replace")]
    Replace,
    #[serde(rename = "overlay")]
    Overlay,
}

impl LayerBlendMode {
    /// GPU 打包码(wgsl/materialLayerBlend.wgsl 的 DEEP_LAYER_BLEND_MODE_*)。
    pub fn code(self) -> f32 {
        match self {
            LayerBlendMode::Replace => 0.0,
            LayerBlendMode::Overlay => 1.0,
        }
    }
}

/// 按层表面覆盖(独立颜色/金属度/粗糙度与该层自己的两张纹理槽)。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LayerSurface {
    #[serde(default, deserialize_with = "present")]
    pub base_color: Option<[f32; 3]>,
    #[serde(default, deserialize_with = "present")]
    pub metallic: Option<f32>,
    #[serde(default, deserialize_with = "present")]
    pub roughness: Option<f32>,
    #[serde(default, deserialize_with = "present")]
    pub base_color_texture: Option<TextureSlot>,
    #[serde(default, deserialize_with = "present")]
    pub metallic_roughness_texture: Option<TextureSlot>,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub enum LayerResponseModel {
    #[serde(rename = "legacy")]
    Legacy,
    #[serde(rename = "microfacet-metal-reflection")]
    MicrofacetMetalReflection,
}

/// 单层定义:参数 + 覆盖率 + 混合语义 + 按层表面(全部可选,缺省即 TS 家族缺省)。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MaterialLayer {
    #[serde(default, deserialize_with = "present")]
    pub response_model: Option<LayerResponseModel>,
    #[serde(default, deserialize_with = "present")]
    pub params: Option<LayerMaterialParams>,
    #[serde(default, deserialize_with = "present")]
    pub coverage: Option<f32>,
    #[serde(default, deserialize_with = "present")]
    pub mode: Option<LayerBlendMode>,
    #[serde(default, deserialize_with = "present")]
    pub surface: Option<LayerSurface>,
}

/// 层栈合同:base + ≤2 层。base 参数仅进 304B 契约(CPU 参考与序列化);
/// GPU 基材响应沿用材质既有路径(native 无 extendedParameters 求值,与 Web
/// stock 分支同界),层行才是 304B 块的实际载荷。
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LayeredMaterial {
    #[serde(default, deserialize_with = "present")]
    pub base: Option<LayerMaterialParams>,
    pub layers: Vec<MaterialLayer>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
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
    pub outline: Option<bool>,
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

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TextureResource {
    pub id: String,
    pub revision: u64,
    pub semantic: TextureSemantic,
    pub width: u32,
    pub height: u32,
    #[serde(deserialize_with = "super::texture_bytes::deserialize")]
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
    Specular,
    SpecularColor,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PixelLevel {
    pub width: u32,
    pub height: u32,
    #[serde(deserialize_with = "super::texture_bytes::deserialize")]
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
