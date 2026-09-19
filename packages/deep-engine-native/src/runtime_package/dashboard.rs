use super::content_payloads::{decode_chart, decode_chart_sim, decode_deep2d};
use super::entrypoints::require_kind;
use super::payloads::{descriptor, payload};
use super::{
    DashboardRuntimeV1, LoadedDashboard, RuntimePackageEnvelope, RuntimePackageError,
    RuntimeResourceIndexEntry, RuntimeResourceKind, fail,
};
use crate::{contract::ContractSummary, deep2d::Deep2dRuntimeContent};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
pub(super) fn validate_entrypoint_shape(
    package: &RuntimePackageEnvelope,
    value: &Value,
) -> Result<(), RuntimePackageError> {
    let entry = &package.entrypoints;
    let raw = &value["entrypoints"];
    if raw.get("camera").is_some()
        || entry.dashboard.is_none()
        || !raw.get("chart").is_some_and(Value::is_null)
        || !raw.get("chartSim").is_some_and(Value::is_null)
        || entry.deep2d.is_some()
        || !entry.shader_packages.is_empty()
        || !package.material_bindings.is_empty()
        || package
            .resources
            .iter()
            .any(|r| r.kind == RuntimeResourceKind::SceneCamera)
    {
        return fail(
            "v5 requires only a dashboard entrypoint, empty shaders/bindings, and no camera",
        );
    }
    Ok(())
}
fn document(package: &RuntimePackageEnvelope) -> Result<DashboardRuntimeV1, RuntimePackageError> {
    let id = package
        .entrypoints
        .dashboard
        .as_deref()
        .ok_or_else(|| RuntimePackageError("missing dashboard entrypoint".into()))?;
    let entry = descriptor(package, id, RuntimeResourceKind::DashboardRuntime)?;
    let mut value = payload(package, id)?.clone();
    super::dashboard_validation::normalize_integers(&mut value);
    let root: DashboardRuntimeV1 = serde_json::from_value(value)
        .map_err(|e| RuntimePackageError(format!("dashboard {id}: {e}")))?;
    if root.schema != "deep-engine.dashboard-runtime"
        || root.schema_version != 1
        || root.id != entry.id
        || root.revision != entry.revision
    {
        return fail("dashboard schema or resource identity mismatch");
    }
    super::dashboard_validation::validate(&root)?;
    super::dashboard_table_validation::resources(&root)?;
    Ok(root)
}
pub(super) fn validate_closure(
    package: &RuntimePackageEnvelope,
    index: &HashMap<&str, &RuntimeResourceIndexEntry>,
) -> Result<(), RuntimePackageError> {
    let root = document(package)?;
    let entry = &package.entrypoints;
    let mut owned = HashSet::new();
    let mut own = |id: &str, kind| -> Result<(), RuntimePackageError> {
        require_kind(index, id, kind)?;
        if !owned.insert(id.to_owned()) {
            return fail("dashboard resource has multiple owners");
        }
        Ok(())
    };
    own(&entry.render_packet, RuntimeResourceKind::RenderPacket)?;
    own(&entry.environment, RuntimeResourceKind::IblEnvironment)?;
    own(&root.id, RuntimeResourceKind::DashboardRuntime)?;
    for node in root.pages.iter().flat_map(|p| &p.nodes) {
        for (id, kind) in [
            (&node.deep2d, RuntimeResourceKind::Deep2dRuntime),
            (&node.chart, RuntimeResourceKind::ChartRuntime),
            (&node.chart_sim, RuntimeResourceKind::ChartSimRuntime),
        ] {
            if let Some(id) = id {
                own(id, kind)?;
            }
        }
    }
    for id in super::dashboard_table_validation::resources(&root)? {
        own(&id, RuntimeResourceKind::Deep2dRuntime)?;
    }
    if owned.len() != index.len() {
        return fail("dashboard package contains unreferenced resources");
    }
    Ok(())
}
pub(super) fn decode(
    package: &RuntimePackageEnvelope,
    summary: &ContractSummary,
) -> Result<Option<LoadedDashboard>, RuntimePackageError> {
    if package.entrypoints.dashboard.is_none() {
        return Ok(None);
    }
    if summary.geometries != 0
        || summary.materials != 0
        || summary.instances != 0
        || summary.textures != 0
        || payload(package, &package.entrypoints.environment)?["schema"]
            != "deep-engine.ibl-reference"
    {
        return fail("dashboard requires an empty render packet and builtin environment");
    }
    let document = document(package)?;
    let mut deep2d = BTreeMap::new();
    let mut charts = BTreeMap::new();
    let mut simulations = BTreeMap::new();
    let mut chart_ids = HashSet::new();
    let mut atlas_bytes = 0usize;
    for node in document.pages.iter().flat_map(|p| &p.nodes) {
        if let Some(id) = &node.deep2d {
            let content = decode_deep2d(package, id)?;
            if let Deep2dRuntimeContent::Package(p) = &content {
                for atlas in &p.atlases {
                    atlas_bytes = atlas_bytes.saturating_add(
                        atlas.width as usize
                            * atlas.height as usize
                            * atlas.format.bytes_per_pixel(),
                    );
                }
            }
            if atlas_bytes > 64 * 1024 * 1024 {
                return fail("dashboard static atlas budget exceeds 64 MiB");
            }
            deep2d.insert(id.clone(), content);
        }
        if let Some(id) = &node.chart {
            let chart = decode_chart(package, id)?;
            if !chart_ids.insert(chart.id.clone()) {
                return fail("dashboard ChartIR ids must be unique");
            }
            if let Some(sim_id) = &node.chart_sim {
                let fixture = decode_chart_sim(package, sim_id, Some(&chart))?;
                // Package validation checks sim data semantics in the established chart viewport.
                // Node layout feasibility is checked by DashboardRuntime's whole-page staging.
                let runtime = crate::chart::ChartRuntime::new(chart.clone(), 640.0, 360.0)
                    .map_err(RuntimePackageError)?;
                crate::chart::simulation::ChartSimulationSource::new(fixture.clone(), &runtime)
                    .map_err(RuntimePackageError)?;
                simulations.insert(sim_id.clone(), fixture);
            }
            charts.insert(id.clone(), chart);
        }
    }
    for id in super::dashboard_table_validation::resources(&document)? {
        let content = decode_deep2d(package, &id)?;
        if let Deep2dRuntimeContent::Package(package) = &content {
            for atlas in &package.atlases {
                atlas_bytes = atlas_bytes.saturating_add(
                    atlas.width as usize * atlas.height as usize * atlas.format.bytes_per_pixel(),
                );
            }
        }
        if atlas_bytes > 64 * 1024 * 1024 {
            return fail("dashboard static atlas budget exceeds 64 MiB");
        }
        deep2d.insert(id, content);
    }
    let loaded = LoadedDashboard {
        document,
        deep2d,
        charts,
        simulations,
    };
    if loaded.document.filter.is_some() || !loaded.document.tables.is_empty() {
        // Untrusted variants must pass the same dataset/frame checks before package admission.
        crate::dashboard_runtime::DashboardRuntime::new(loaded.clone())
            .map_err(RuntimePackageError)?;
    }
    Ok(Some(loaded))
}
