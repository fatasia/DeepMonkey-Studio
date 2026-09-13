use serde::{Deserialize, Serialize};

use super::deserialize_required_nullable;

pub const DEEP_PBR_MESH_V1_ID: &str = "deep.pbr.mesh.v1";
pub const DEEP_PBR_MESH_V1_SHA256: &str =
    "cbfaa36e9f2f689684e4a9086a61f165873d2a3398b6a4633aa5b2bcb117f46c";
pub const DEEP_PBR_MESH_V2_ID: &str = "deep.pbr.mesh.v2";
pub const DEEP_PBR_MESH_V2_SHA256: &str =
    "adcdc15ed7ff02966d4033b746da1af90c97a0fb657615fec3bcef375c015cf1";

// 两个版本共享序列化结构，实际允许的字段值由各自冻结指纹验证。
pub type DeepPbrMeshShaderAbiV1 = DeepPbrMeshShaderAbi;
pub type DeepPbrMeshShaderAbiV2 = DeepPbrMeshShaderAbi;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeepPbrMeshShaderAbi {
    pub schema: String,
    pub schema_version: u32,
    pub id: String,
    pub data_layouts: Vec<ShaderAbiDataLayout>,
    pub vertex_streams: Vec<ShaderAbiVertexStream>,
    pub bind_group_layouts: Vec<ShaderAbiBindGroupLayout>,
    pub attachment_profiles: Vec<ShaderAbiAttachmentProfile>,
    pub alpha_modes: Vec<ShaderAbiAlphaMode>,
    pub raster_modes: Vec<ShaderAbiRasterMode>,
    pub material_modes: Vec<ShaderAbiMaterialMode>,
    pub pass_variants: Vec<ShaderAbiPassVariant>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderAbiDataLayout {
    pub id: String,
    pub storage: String,
    pub byte_size: u32,
    pub byte_alignment: u32,
    pub members: Vec<ShaderAbiDataMember>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderAbiDataMember {
    pub name: String,
    pub format: String,
    pub byte_offset: u32,
    pub byte_size: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderAbiVertexStream {
    pub id: String,
    pub slot: u32,
    pub array_stride: u32,
    pub step_mode: String,
    pub attributes: Vec<ShaderAbiVertexAttribute>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderAbiVertexAttribute {
    pub semantic: String,
    pub shader_location: u32,
    pub format: String,
    pub byte_offset: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderAbiBindGroupLayout {
    pub id: String,
    pub group: u32,
    pub bindings: Vec<ShaderAbiBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ShaderAbiBinding {
    pub name: String,
    pub binding: u32,
    pub visibility: Vec<String>,
    pub resource: ShaderAbiBindingResource,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ShaderAbiBindingResource {
    #[serde(rename_all = "camelCase")]
    UniformBuffer {
        data_layout: String,
        min_binding_size: u32,
    },
    #[serde(rename_all = "camelCase")]
    Texture {
        sample_type: String,
        view_dimension: String,
        multisampled: bool,
    },
    #[serde(rename_all = "camelCase")]
    Sampler { sampler_type: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderAbiAttachmentProfile {
    pub id: String,
    pub pass: String,
    pub sample_count: u32,
    pub resolve: String,
    pub color_attachments: Vec<ShaderAbiColorAttachment>,
    pub depth_attachment: ShaderAbiDepthAttachment,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderAbiColorAttachment {
    pub format: String,
    pub write_mask: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub blend: Option<ShaderAbiBlendState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ShaderAbiBlendState {
    pub color: ShaderAbiBlendComponent,
    pub alpha: ShaderAbiBlendComponent,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderAbiBlendComponent {
    pub src_factor: String,
    pub dst_factor: String,
    pub operation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderAbiDepthAttachment {
    pub format: String,
    pub depth_write_enabled: bool,
    pub depth_compare: String,
    pub depth_bias: i32,
    pub depth_bias_slope_scale: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderAbiAlphaMode {
    pub mode: String,
    pub forward_attachment_profile: String,
    pub depth_write_enabled: bool,
    pub shadow: String,
    pub sort: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderAbiRasterMode {
    pub id: String,
    pub front_face: String,
    pub cull_mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderAbiMaterialMode {
    pub id: String,
    pub bind_group_layouts: Vec<String>,
    pub vertex_streams: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderAbiPassVariant {
    pub id: String,
    pub pass: String,
    pub entry_points: ShaderAbiEntryPoints,
    pub attachment_profiles: Vec<String>,
    pub bind_group_layouts: Vec<String>,
    pub vertex_streams: Vec<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub material_mode: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub shadow_mode: Option<String>,
    pub alpha_modes: Vec<String>,
    pub raster_modes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ShaderAbiEntryPoints {
    pub vertex: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub fragment: Option<String>,
}
