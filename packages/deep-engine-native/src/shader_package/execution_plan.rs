use serde::Serialize;

use super::{
    DeepShaderPackageV2, ShaderAbiAttachmentProfile, ShaderAbiBindGroupLayout, ShaderAbiRasterMode,
    ShaderAbiVertexStream, ShaderPackageError, parse_and_validate_shader_package, pipeline,
};

/// Complete device-independent state needed to create every selected render pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShaderPackageExecutionPlan {
    pub package_id: String,
    pub package_cache_key: String,
    pub resource_ownership: ShaderPackageResourceOwnership,
    pub passes: Vec<ShaderPackagePassPlan>,
}

/// The package executor creates immutable pipeline objects only. The renderer must
/// create bind groups from each executable pass's layouts, attach its own resources,
/// and submit draws. Bind groups created from another layout handle are not portable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShaderPackageResourceOwnership {
    pub pipeline_and_bind_group_layouts: String,
    pub bind_groups: String,
    pub vertex_and_index_buffers: String,
    pub attachments: String,
    pub draw_submission: String,
}

impl Default for ShaderPackageResourceOwnership {
    fn default() -> Self {
        Self {
            pipeline_and_bind_group_layouts: "package-executor".into(),
            bind_groups: "renderer".into(),
            vertex_and_index_buffers: "renderer".into(),
            attachments: "renderer".into(),
            draw_submission: "renderer".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShaderPackagePassPlan {
    pub id: String,
    pub cache_key: String,
    pub kind: String,
    pub module_id: String,
    pub vertex_entry_point: String,
    pub fragment_entry_point: Option<String>,
    pub bind_group_layouts: Vec<ShaderAbiBindGroupLayout>,
    pub vertex_streams: Vec<ShaderAbiVertexStream>,
    pub attachment_profile: ShaderAbiAttachmentProfile,
    pub raster_mode: ShaderAbiRasterMode,
    pub resolve_required: bool,
}

/// Validates untrusted bytes before exposing the executable descriptor plan.
pub fn plan_shader_package_bytes(
    bytes: &[u8],
) -> Result<ShaderPackageExecutionPlan, ShaderPackageError> {
    let package = parse_and_validate_shader_package(bytes)?;
    plan_validated_shader_package(&package)
}

pub(super) fn plan_validated_shader_package(
    package: &DeepShaderPackageV2,
) -> Result<ShaderPackageExecutionPlan, ShaderPackageError> {
    let passes = package
        .passes
        .iter()
        .map(|pass| {
            let resolved = pipeline::resolve(&package.shader_abi.contract, pass)?;
            Ok(ShaderPackagePassPlan {
                id: pass.id.clone(),
                cache_key: pass.cache_key.clone(),
                kind: pass.kind.clone(),
                module_id: pass.module_id.clone(),
                vertex_entry_point: pass.entry_points.vertex.clone(),
                fragment_entry_point: pass.entry_points.fragment.clone(),
                bind_group_layouts: resolved
                    .bind_group_layouts
                    .iter()
                    .map(|value| (*value).clone())
                    .collect(),
                vertex_streams: resolved
                    .vertex_streams
                    .iter()
                    .map(|value| (*value).clone())
                    .collect(),
                attachment_profile: resolved.attachment_profile.clone(),
                raster_mode: resolved.raster_mode.clone(),
                resolve_required: resolved.attachment_profile.resolve == "required",
            })
        })
        .collect::<Result<Vec<_>, ShaderPackageError>>()?;
    Ok(ShaderPackageExecutionPlan {
        package_id: package.package_id.clone(),
        package_cache_key: package.package_cache_key.clone(),
        resource_ownership: ShaderPackageResourceOwnership::default(),
        passes,
    })
}
