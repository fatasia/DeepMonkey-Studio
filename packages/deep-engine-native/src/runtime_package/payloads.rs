use serde_json::Value;

use super::{
    IblEnvironmentReferenceV1, IblReferenceKind, LoadedRuntimePackage, RuntimePackageEnvelope,
    RuntimePackageError, RuntimeResourceKind, fail, render_packet,
};
use crate::{
    deep2d::{Deep2dRuntimeContent, decode_runtime_content},
    ibl::{builtin_default_environment, validate_ibl_environment},
    shader_package::parse_and_validate_shader_package,
};

const IBL_REFERENCE_SCHEMA: &str = "deep-engine.ibl-reference";
const IBL_REFERENCE_VERSION: u32 = 1;

pub(super) fn decode(
    package: RuntimePackageEnvelope,
) -> Result<LoadedRuntimePackage, RuntimePackageError> {
    let render_id = package.entrypoints.render_packet.as_str();
    descriptor(&package, render_id, RuntimeResourceKind::RenderPacket)?;
    let (render_packet, render_summary) =
        render_packet::decode(render_id, payload(&package, render_id)?)?;
    let deep2d = package
        .entrypoints
        .deep2d
        .as_deref()
        .map(|id| decode_deep2d(&package, id))
        .transpose()?;
    let environment = decode_environment(&package, &package.entrypoints.environment)?;
    let shader_packages = package
        .entrypoints
        .shader_packages
        .iter()
        .map(|id| decode_shader_package(&package, id))
        .collect::<Result<Vec<_>, _>>()?;
    if package.schema_version == super::DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION {
        super::material_bindings::validate(
            &package.material_bindings,
            &render_packet,
            &shader_packages,
        )?;
    }

    Ok(LoadedRuntimePackage {
        package_id: package.package_id,
        package_version: package.package_version,
        package_hash: package.package_hash.value,
        resource_index: package.resources,
        render_packet,
        render_summary,
        deep2d,
        environment,
        shader_packages,
        material_bindings: package.material_bindings,
    })
}

fn decode_deep2d(
    package: &RuntimePackageEnvelope,
    id: &str,
) -> Result<Deep2dRuntimeContent, RuntimePackageError> {
    let descriptor = descriptor(package, id, RuntimeResourceKind::Deep2dRuntime)?;
    let bytes = serde_json::to_vec(payload(package, id)?).map_err(|error| {
        RuntimePackageError(format!("resource {id} serialization failed: {error}"))
    })?;
    let content = decode_runtime_content(&bytes)
        .map_err(|error| RuntimePackageError(format!("resource {id}: {error}")))?;
    match &content {
        Deep2dRuntimeContent::Package(value)
            if value.id == descriptor.id && value.revision == descriptor.revision =>
        {
            Ok(content)
        }
        Deep2dRuntimeContent::Package(_) => fail(format!(
            "resource {id} Deep2d identity differs from its index entry"
        )),
        Deep2dRuntimeContent::DisplayList(_) => fail(format!(
            "resource {id} must use the versioned Deep2d runtime package"
        )),
    }
}

fn decode_environment(
    package: &RuntimePackageEnvelope,
    id: &str,
) -> Result<crate::ibl::PreparedIblEnvironment, RuntimePackageError> {
    let descriptor = descriptor(package, id, RuntimeResourceKind::IblEnvironment)?;
    let reference: IblEnvironmentReferenceV1 =
        serde_json::from_value(payload(package, id)?.clone()).map_err(|error| {
            RuntimePackageError(format!("resource {id} is not an IBL reference: {error}"))
        })?;
    if reference.schema != IBL_REFERENCE_SCHEMA
        || reference.schema_version != IBL_REFERENCE_VERSION
        || reference.id != descriptor.id
        || reference.revision != descriptor.revision
        || reference.kind != IblReferenceKind::BuiltinDefault
    {
        return fail(format!(
            "resource {id} has an unsupported IBL identity or source"
        ));
    }
    let environment = builtin_default_environment();
    if environment.id != reference.id || u64::from(environment.revision) != reference.revision {
        return fail(format!(
            "resource {id} does not identify the native built-in IBL"
        ));
    }
    validate_ibl_environment(&environment)
        .map_err(|error| RuntimePackageError(format!("resource {id}: {error}")))?;
    Ok(environment)
}

fn decode_shader_package(
    package: &RuntimePackageEnvelope,
    id: &str,
) -> Result<crate::shader_package::DeepShaderPackageV2, RuntimePackageError> {
    descriptor(package, id, RuntimeResourceKind::ShaderPackage)?;
    let bytes = serde_json::to_vec(payload(package, id)?).map_err(|error| {
        RuntimePackageError(format!("resource {id} serialization failed: {error}"))
    })?;
    let shader = parse_and_validate_shader_package(&bytes)
        .map_err(|error| RuntimePackageError(format!("resource {id}: {error}")))?;
    if shader.package_id != id {
        return fail(format!(
            "resource {id} shader package identity differs from its index entry"
        ));
    }
    Ok(shader)
}

fn descriptor<'a>(
    package: &'a RuntimePackageEnvelope,
    id: &str,
    kind: RuntimeResourceKind,
) -> Result<&'a super::RuntimeResourceIndexEntry, RuntimePackageError> {
    package
        .resources
        .iter()
        .find(|resource| resource.id == id && resource.kind == kind)
        .ok_or_else(|| RuntimePackageError(format!("resource {id} is absent from its typed index")))
}

fn payload<'a>(
    package: &'a RuntimePackageEnvelope,
    id: &str,
) -> Result<&'a Value, RuntimePackageError> {
    package
        .payloads
        .get(id)
        .ok_or_else(|| RuntimePackageError(format!("resource {id} payload is missing")))
}
