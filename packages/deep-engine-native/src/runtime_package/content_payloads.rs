use super::payloads::{descriptor, payload};
use super::{RuntimePackageEnvelope, RuntimePackageError, RuntimeResourceKind, fail};
use crate::{
    chart::{
        ChartIR, parse_chart_ir,
        simulation::{ChartSimFixture, parse_chart_sim_fixture},
    },
    deep2d::{Deep2dRuntimeContent, decode_runtime_content},
};
use serde::Deserialize;
use serde_json::Value;
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

pub(super) fn decode_deep2d(
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
        Deep2dRuntimeContent::DisplayList(_) | Deep2dRuntimeContent::Composite(_) => fail(format!(
            "resource {id} must use the versioned Deep2d runtime package"
        )),
    }
}

pub(super) fn decode_chart(
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

pub(super) fn decode_chart_sim(
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
