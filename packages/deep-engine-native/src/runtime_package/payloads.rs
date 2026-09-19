use super::content_payloads::{decode_chart, decode_chart_sim, decode_deep2d};
use serde_json::Value;
#[path = "solid_environment.rs"]
mod solid_environment;

use super::{
    IblEnvironmentReferenceV1, IblReferenceKind, LoadedRuntimePackage, RuntimePackageEnvelope,
    RuntimePackageError, RuntimeResourceKind, fail, render_packet,
};
use crate::{
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
    let chart = package
        .entrypoints
        .chart
        .as_deref()
        .map(|id| decode_chart(&package, id))
        .transpose()?;
    let chart_sim = package
        .entrypoints
        .chart_sim
        .as_deref()
        .map(|id| decode_chart_sim(&package, id, chart.as_ref()))
        .transpose()?;
    let dynamic_runtime = package
        .entrypoints
        .dynamic_runtime
        .as_deref()
        .map(|id| decode_dynamic_runtime(&package, id))
        .transpose()?;
    let environment = decode_environment(&package, &package.entrypoints.environment)?;
    let solid_environment = decode_background(&package, &package.entrypoints.environment)?;
    let background = solid_environment.as_ref().map(|decoded| decoded.background);
    let fog = solid_environment.and_then(|decoded| decoded.fog);
    let lighting = if background.is_some() {
        solid_environment::lighting(payload(&package, &package.entrypoints.environment)?)
    } else {
        None
    };
    let shader_packages = package
        .entrypoints
        .shader_packages
        .iter()
        .map(|id| decode_shader_package(&package, id))
        .collect::<Result<Vec<_>, _>>()?;
    if package.schema_version >= super::DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION {
        super::material_bindings::validate(
            &package.material_bindings,
            &render_packet,
            &shader_packages,
            package.schema_version >= super::DEEP_RUNTIME_PACKAGE_CAMERA_VERSION,
        )?;
    }

    let camera = package
        .entrypoints
        .camera
        .as_deref()
        .map(|id| decode_camera(&package, id))
        .transpose()?;
    let dashboard = super::dashboard::decode(&package, &render_summary)?;
    Ok(LoadedRuntimePackage {
        dashboard,
        camera,
        package_id: package.package_id,
        package_version: package.package_version,
        package_hash: package.package_hash.value,
        resource_index: package.resources,
        render_packet,
        render_summary,
        deep2d,
        chart,
        chart_sim,
        environment,
        background,
        lighting,
        fog,
        shader_packages,
        material_bindings: package.material_bindings,
        dynamic_runtime,
    })
}

fn decode_dynamic_runtime(
    package: &RuntimePackageEnvelope,
    id: &str,
) -> Result<super::DynamicSceneRuntime, RuntimePackageError> {
    let entry = descriptor(package, id, RuntimeResourceKind::DynamicRuntime)?;
    let runtime = super::parse_and_validate_dynamic_scene_runtime(payload(package, id)?)?;
    if runtime.id != id || runtime.revision != entry.revision {
        return fail("dynamic runtime identity differs from resource index");
    }
    Ok(runtime)
}

fn decode_camera(
    package: &RuntimePackageEnvelope,
    id: &str,
) -> Result<crate::runtime_camera::RuntimeSceneCamera, RuntimePackageError> {
    let entry = descriptor(package, id, RuntimeResourceKind::SceneCamera)?;
    let camera: crate::runtime_camera::RuntimeSceneCamera =
        serde_json::from_value(payload(package, id)?.clone())
            .map_err(|error| RuntimePackageError(format!("resource {id}: {error}")))?;
    camera.validate().map_err(RuntimePackageError)?;
    if camera.id != id || camera.revision != entry.revision {
        return fail("camera identity differs from resource index");
    }
    Ok(camera)
}

fn decode_environment(
    package: &RuntimePackageEnvelope,
    id: &str,
) -> Result<crate::ibl::PreparedIblEnvironment, RuntimePackageError> {
    let descriptor = descriptor(package, id, RuntimeResourceKind::IblEnvironment)?;
    if decode_background(package, id)?.is_some() {
        if let Some(ibl) = payload(package, id)?.get("ibl") {
            return super::prefiltered_ibl::decode(ibl, descriptor).map_err(RuntimePackageError);
        }
        let mut environment = crate::ibl::disabled_probe_environment();
        environment.id = id.into();
        return Ok(environment);
    }
    if payload(package, id)?.get("schema").and_then(Value::as_str)
        == Some("deep-engine.ibl-prefiltered")
    {
        return super::prefiltered_ibl::decode(payload(package, id)?, descriptor)
            .map_err(RuntimePackageError);
    }
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

fn decode_background(
    package: &RuntimePackageEnvelope,
    id: &str,
) -> Result<Option<solid_environment::DecodedSolidEnvironment>, RuntimePackageError> {
    let value = payload(package, id)?;
    if value.get("schema").and_then(Value::as_str) != Some("deep-engine.solid-environment") {
        return Ok(None);
    }
    let entry = descriptor(package, id, RuntimeResourceKind::IblEnvironment)?;
    solid_environment::decode(value, id, entry.revision).map(Some)
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

pub(super) fn descriptor<'a>(
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

pub(super) fn payload<'a>(
    package: &'a RuntimePackageEnvelope,
    id: &str,
) -> Result<&'a Value, RuntimePackageError> {
    package
        .payloads
        .get(id)
        .ok_or_else(|| RuntimePackageError(format!("resource {id} payload is missing")))
}
