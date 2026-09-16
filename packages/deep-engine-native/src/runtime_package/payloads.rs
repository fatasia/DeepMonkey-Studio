use serde::Deserialize;
use serde_json::Value;

use super::{
    IblEnvironmentReferenceV1, IblReferenceKind, LoadedRuntimePackage, RuntimePackageEnvelope,
    RuntimePackageError, RuntimeResourceKind, fail, render_packet,
};
use crate::{
    chart::simulation::{ChartSimFixture, parse_chart_sim_fixture},
    chart::{ChartIR, parse_chart_ir},
    deep2d::{Deep2dRuntimeContent, decode_runtime_content},
    ibl::{builtin_default_environment, validate_ibl_environment},
    shader_package::parse_and_validate_shader_package,
};

const IBL_REFERENCE_SCHEMA: &str = "deep-engine.ibl-reference";
const IBL_REFERENCE_VERSION: u32 = 1;
const CHART_RUNTIME_SCHEMA: &str = "deep-engine.chart-runtime";
const CHART_RUNTIME_VERSION: u32 = 1;
const CHART_SIM_RUNTIME_SCHEMA: &str = "deep-engine.chart-sim-runtime";
const CHART_SIM_RUNTIME_VERSION: u32 = 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ChartRuntimePayloadV1 {
    schema: String,
    schema_version: u32,
    id: String,
    revision: u64,
    chart: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ChartSimRuntimePayloadV1 {
    schema: String,
    schema_version: u32,
    id: String,
    revision: u64,
    fixture: Value,
}

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
    let environment = decode_environment(&package, &package.entrypoints.environment)?;
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
    Ok(LoadedRuntimePackage {
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
        shader_packages,
        material_bindings: package.material_bindings,
    })
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

fn decode_chart(
    package: &RuntimePackageEnvelope,
    id: &str,
) -> Result<ChartIR, RuntimePackageError> {
    let descriptor = descriptor(package, id, RuntimeResourceKind::ChartRuntime)?;
    let envelope: ChartRuntimePayloadV1 = serde_json::from_value(payload(package, id)?.clone())
        .map_err(|error| RuntimePackageError(format!("resource {id}: {error}")))?;
    if envelope.schema != CHART_RUNTIME_SCHEMA || envelope.schema_version != CHART_RUNTIME_VERSION {
        return fail(format!(
            "resource {id} has an unsupported chart payload schema"
        ));
    }
    if envelope.id != descriptor.id || envelope.revision != descriptor.revision {
        return fail(format!(
            "resource {id} chart identity differs from its index entry"
        ));
    }
    let bytes = serde_json::to_vec(&envelope.chart).map_err(|error| {
        RuntimePackageError(format!("resource {id} serialization failed: {error}"))
    })?;
    parse_chart_ir(&bytes).map_err(|validation| {
        let detail = validation
            .diagnostics
            .first()
            .map(|diagnostic| {
                format!(
                    "{:?} at {}: {}",
                    diagnostic.code, diagnostic.path, diagnostic.message
                )
            })
            .unwrap_or_else(|| "validation failed".into());
        RuntimePackageError(format!("resource {id}: {detail}"))
    })
}

fn decode_chart_sim(
    package: &RuntimePackageEnvelope,
    id: &str,
    chart: Option<&ChartIR>,
) -> Result<ChartSimFixture, RuntimePackageError> {
    let descriptor = descriptor(package, id, RuntimeResourceKind::ChartSimRuntime)?;
    let envelope: ChartSimRuntimePayloadV1 = serde_json::from_value(payload(package, id)?.clone())
        .map_err(|error| RuntimePackageError(format!("resource {id}: {error}")))?;
    if envelope.schema != CHART_SIM_RUNTIME_SCHEMA
        || envelope.schema_version != CHART_SIM_RUNTIME_VERSION
    {
        return fail(format!(
            "resource {id} has an unsupported chart sim payload schema"
        ));
    }
    if envelope.id != descriptor.id || envelope.revision != descriptor.revision {
        return fail(format!(
            "resource {id} chart sim identity differs from its index entry"
        ));
    }
    let bytes = serde_json::to_vec(&envelope.fixture).map_err(|error| {
        RuntimePackageError(format!("resource {id} serialization failed: {error}"))
    })?;
    let fixture = parse_chart_sim_fixture(&bytes)
        .map_err(|error| RuntimePackageError(format!("resource {id}: {error}")))?;
    let chart_id = chart.map(|chart| chart.id.as_str()).unwrap_or_default();
    if chart_id.is_empty() || fixture.chart_id != chart_id {
        return fail(format!(
            "resource {id} sim fixture targets chart {:?} instead of the package chart",
            fixture.chart_id
        ));
    }
    Ok(fixture)
}

fn decode_environment(
    package: &RuntimePackageEnvelope,
    id: &str,
) -> Result<crate::ibl::PreparedIblEnvironment, RuntimePackageError> {
    let descriptor = descriptor(package, id, RuntimeResourceKind::IblEnvironment)?;
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
