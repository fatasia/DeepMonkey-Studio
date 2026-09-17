use super::validate::resource_id;
use super::{
    RuntimePackageEnvelope, RuntimePackageError, RuntimeResourceIndexEntry, RuntimeResourceKind,
    fail,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
const MAX_SHADER_PACKAGES: usize = 128;
pub(super) fn version(
    package: &RuntimePackageEnvelope,
    value: &Value,
) -> Result<(), RuntimePackageError> {
    let experimental = package.schema_version == super::DEEP_RUNTIME_PACKAGE_EXPERIMENTAL_X_VERSION;
    let has_x = value["entrypoints"].get("experimentalX").is_some();
    if experimental && package.entrypoints.experimental_x.is_none() {
        return fail("runtime package v6 requires experimentalX entrypoint");
    }
    // v6是静态v2形状加单个X入口，不继承v3-v5的camera/chart/dashboard组合。
    if experimental
        && (["camera", "chart", "chartSim", "dashboard"]
            .iter()
            .any(|key| value["entrypoints"].get(key).is_some())
            || package.resources.iter().any(|resource| {
                matches!(
                    resource.kind,
                    RuntimeResourceKind::SceneCamera
                        | RuntimeResourceKind::ChartRuntime
                        | RuntimeResourceKind::ChartSimRuntime
                        | RuntimeResourceKind::DashboardRuntime
                )
            }))
    {
        return fail(
            "runtime package v6 forbids camera, chart, chartSim, and dashboard entrypoints and resources",
        );
    }
    if !experimental
        && (has_x
            || package
                .resources
                .iter()
                .any(|r| r.kind == RuntimeResourceKind::ExperimentalX))
    {
        return fail("experimental X is forbidden before runtime package v6");
    }
    let dashboard = package.schema_version == super::DEEP_RUNTIME_PACKAGE_DASHBOARD_VERSION;
    let has_dashboard = value["entrypoints"].get("dashboard").is_some();
    if dashboard {
        return super::dashboard::validate_entrypoint_shape(package, value);
    }
    if has_dashboard
        || package
            .resources
            .iter()
            .any(|r| r.kind == RuntimeResourceKind::DashboardRuntime)
    {
        return fail("dashboard is forbidden before runtime package v5");
    }
    let entrypoints_value = value.get("entrypoints");
    let has_camera = entrypoints_value.and_then(|v| v.get("camera")).is_some();
    let camera_era = package.schema_version == super::DEEP_RUNTIME_PACKAGE_CAMERA_VERSION;
    let chart_era = package.schema_version == super::DEEP_RUNTIME_PACKAGE_CHART_VERSION;
    if (has_camera && !camera_era && !chart_era)
        || camera_era && (!has_camera || package.entrypoints.camera.is_none())
    {
        return fail(
            "camera entrypoint is required in v3, optional from v4, and forbidden in v1/v2",
        );
    }
    // chart 时代合同:键必须成对声明,chart 必须非空;更早版本禁止出现键。
    let has_chart_key = entrypoints_value.and_then(|v| v.get("chart")).is_some();
    let has_chart_sim_key = entrypoints_value.and_then(|v| v.get("chartSim")).is_some();
    if chart_era {
        if !has_chart_key || !has_chart_sim_key {
            return fail(
                "runtime package v4 must declare chart and chartSim entrypoints (chartSim may be null)",
            );
        }
        if package.entrypoints.chart.is_none() {
            return fail("runtime package v4 requires a chart entrypoint");
        }
    } else if has_chart_key || has_chart_sim_key {
        return fail("chart entrypoints are forbidden before runtime package v4");
    }
    if package.entrypoints.chart_sim.is_some() && package.entrypoints.chart.is_none() {
        return fail("chartSim entrypoint requires a chart entrypoint");
    }
    if package.entrypoints.chart.is_some() && package.entrypoints.deep2d.is_some() {
        return fail("chart and deep2d entrypoints are mutually exclusive");
    }
    Ok(())
}
pub(super) fn validate_entrypoints(
    package: &RuntimePackageEnvelope,
    index: &HashMap<&str, &RuntimeResourceIndexEntry>,
) -> Result<(), RuntimePackageError> {
    if package.schema_version == super::DEEP_RUNTIME_PACKAGE_DASHBOARD_VERSION {
        return super::dashboard::validate_closure(package, index);
    }
    let entry = &package.entrypoints;
    require_kind(
        index,
        &entry.render_packet,
        RuntimeResourceKind::RenderPacket,
    )?;
    require_kind(
        index,
        &entry.environment,
        RuntimeResourceKind::IblEnvironment,
    )?;
    if let Some(id) = &entry.deep2d {
        require_kind(index, id, RuntimeResourceKind::Deep2dRuntime)?;
    }
    if let Some(id) = &entry.camera {
        require_kind(index, id, RuntimeResourceKind::SceneCamera)?;
    }
    if let Some(id) = &entry.chart {
        require_kind(index, id, RuntimeResourceKind::ChartRuntime)?;
    }
    if let Some(id) = &entry.chart_sim {
        require_kind(index, id, RuntimeResourceKind::ChartSimRuntime)?;
    }
    if entry.shader_packages.len() > MAX_SHADER_PACKAGES
        || entry
            .shader_packages
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
    {
        return fail("shader package entrypoints must be sorted, unique, and bounded");
    }
    for id in &entry.shader_packages {
        require_kind(index, id, RuntimeResourceKind::ShaderPackage)?;
    }
    let mut referenced = HashSet::from([entry.render_packet.as_str(), entry.environment.as_str()]);
    if let Some(id) = &entry.experimental_x {
        require_kind(index, id, RuntimeResourceKind::ExperimentalX)?;
        referenced.insert(id);
    }
    if let Some(id) = &entry.deep2d {
        referenced.insert(id);
    }
    if let Some(id) = &entry.camera {
        referenced.insert(id);
    }
    if let Some(id) = &entry.chart {
        referenced.insert(id);
    }
    if let Some(id) = &entry.chart_sim {
        referenced.insert(id);
    }
    referenced.extend(entry.shader_packages.iter().map(String::as_str));
    if referenced.len() != index.len() || index.keys().any(|id| !referenced.contains(id)) {
        return fail("every runtime resource must be referenced by exactly one entrypoint role");
    }
    Ok(())
}

pub(super) fn require_kind(
    index: &HashMap<&str, &RuntimeResourceIndexEntry>,
    id: &str,
    kind: RuntimeResourceKind,
) -> Result<(), RuntimePackageError> {
    if !resource_id(id) || index.get(id).is_none_or(|resource| resource.kind != kind) {
        fail(format!(
            "entrypoint {id:?} is missing or has the wrong resource kind"
        ))
    } else {
        Ok(())
    }
}
