use serde_json::{Value, json};

use super::{
    DeepPbrMeshShaderAbi, DeepShaderPackageV2, ShaderAbiAlphaMode, ShaderAbiAttachmentProfile,
    ShaderAbiBindGroupLayout, ShaderAbiDataLayout, ShaderAbiPassVariant, ShaderAbiRasterMode,
    ShaderAbiVertexStream, ShaderPackageError, ShaderPackageModule, ShaderPackagePass, fail,
    hash::hash_canonical,
};

pub(super) struct ResolvedPipeline<'a> {
    pub pass_variant: &'a ShaderAbiPassVariant,
    pub attachment_profile: &'a ShaderAbiAttachmentProfile,
    pub alpha_mode: &'a ShaderAbiAlphaMode,
    pub raster_mode: &'a ShaderAbiRasterMode,
    pub bind_group_layouts: Vec<&'a ShaderAbiBindGroupLayout>,
    pub vertex_streams: Vec<&'a ShaderAbiVertexStream>,
    pub data_layouts: &'a [ShaderAbiDataLayout],
}

fn find<'a, T>(values: &'a [T], id: &str, get_id: impl Fn(&T) -> &str) -> Option<&'a T> {
    values.iter().find(|value| get_id(value) == id)
}

pub(super) fn resolve<'a>(
    abi: &'a DeepPbrMeshShaderAbi,
    pass: &ShaderPackagePass,
) -> Result<ResolvedPipeline<'a>, ShaderPackageError> {
    let selection = &pass.pipeline;
    let variant = find(&abi.pass_variants, &selection.pass_variant_id, |value| {
        &value.id
    });
    let attachment = find(
        &abi.attachment_profiles,
        &selection.attachment_profile_id,
        |value| &value.id,
    );
    let alpha = abi
        .alpha_modes
        .iter()
        .find(|value| value.mode == selection.alpha_mode);
    let raster = find(&abi.raster_modes, &selection.raster_mode, |value| &value.id);
    let (Some(variant), Some(attachment), Some(alpha), Some(raster)) =
        (variant, attachment, alpha, raster)
    else {
        return fail("pipeline selection references unknown ABI state");
    };
    if variant.pass != pass.kind
        || attachment.pass != variant.pass
        || !variant
            .attachment_profiles
            .contains(&selection.attachment_profile_id)
        || !variant.alpha_modes.contains(&selection.alpha_mode)
        || !variant.raster_modes.contains(&selection.raster_mode)
        || (variant.pass == "forward"
            && alpha.forward_attachment_profile != selection.attachment_profile_id)
        || (variant.pass == "shadow" && selection.attachment_profile_id != "shadow")
        || variant.entry_points.vertex != pass.entry_points.vertex
        || variant.entry_points.fragment != pass.entry_points.fragment
    {
        return fail(
            "pipeline selection, pass kind, attachment, or entry points disagree with ABI",
        );
    }
    let bind_group_layouts = variant
        .bind_group_layouts
        .iter()
        .map(|id| find(&abi.bind_group_layouts, id, |value| &value.id))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| {
            ShaderPackageError("ABI variant references unknown bind group layout".into())
        })?;
    let vertex_streams = variant
        .vertex_streams
        .iter()
        .map(|id| find(&abi.vertex_streams, id, |value| &value.id))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| ShaderPackageError("ABI variant references unknown vertex stream".into()))?;
    Ok(ResolvedPipeline {
        pass_variant: variant,
        attachment_profile: attachment,
        alpha_mode: alpha,
        raster_mode: raster,
        bind_group_layouts,
        vertex_streams,
        data_layouts: &abi.data_layouts,
    })
}

pub(super) fn expected_cache_key(
    package: &DeepShaderPackageV2,
    pass: &ShaderPackagePass,
    module: &ShaderPackageModule,
    execution: &ResolvedPipeline<'_>,
) -> Result<String, ShaderPackageError> {
    let dependencies = module
        .dependency_ids
        .iter()
        .map(|id| package.dependencies.iter().find(|value| value.id == *id))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| ShaderPackageError("module references unknown dependency".into()))?;
    let state: Value = json!({
        "schemaVersion": package.schema_version,
        "targetProfile": package.target_profile,
        "compilerVersion": package.compiler_version,
        "techniqueId": pass.technique_id,
        "passId": pass.pass_id,
        "kind": pass.kind,
        "module": {
            "id": module.id,
            "sourceHash": module.source_hash,
            "dependencies": dependencies,
        },
        "entryPoints": pass.entry_points,
        "pipeline": {
            "selection": pass.pipeline,
            "shaderAbi": {
                "id": package.shader_abi.id,
                "contentHash": package.shader_abi.content_hash,
            },
            "execution": {
                "passVariant": execution.pass_variant,
                "attachmentProfile": execution.attachment_profile,
                "alphaMode": execution.alpha_mode,
                "rasterMode": execution.raster_mode,
                "bindGroupLayouts": execution.bind_group_layouts,
                "vertexStreams": execution.vertex_streams,
                "dataLayouts": execution.data_layouts,
            },
        },
    });
    Ok(hash_canonical(&state))
}
