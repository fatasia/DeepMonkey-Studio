use super::content_payloads::{decode_chart, decode_chart_sim, decode_deep2d};
use serde_json::Value;
#[path = "solid_environment.rs"]
mod solid_environment;

use super::{
    IblEnvironmentReferenceV1, IblReferenceKind, LoadedRuntimePackage, RuntimeObjectBinding,
    RuntimePackageEnvelope, RuntimePackageError, RuntimeResourceKind, fail, render_packet,
};
use crate::{
    ibl::{builtin_default_environment, validate_ibl_environment},
    shader_package::parse_and_validate_shader_package,
};

const IBL_REFERENCE_SCHEMA: &str = "deep-engine.ibl-reference";
const IBL_REFERENCE_VERSION: u32 = 1;

/// 节点级拾取映射的包层不变量,与 Web 侧 validation.ts 镜像:
/// nodeId 非空且全局唯一,instanceIds 非空且条目内唯一。违约整包拒绝(fail-closed)。
fn validate_object_bindings(bindings: &[RuntimeObjectBinding]) -> Result<(), RuntimePackageError> {
    let mut nodes = std::collections::HashSet::new();
    for binding in bindings {
        if binding.node_id.is_empty() || !nodes.insert(binding.node_id.clone()) {
            return fail("objectBindings node ids must be non-empty and unique");
        }
        let mut instances = std::collections::HashSet::new();
        if binding.instance_ids.is_empty() {
            return fail("objectBindings must list at least one instance");
        }
        for id in &binding.instance_ids {
            if id.is_empty() || !instances.insert(id) {
                return fail(
                    "objectBindings instance ids must be non-empty and unique within a node",
                );
            }
        }
    }
    Ok(())
}

pub(super) fn decode(
    package: RuntimePackageEnvelope,
) -> Result<LoadedRuntimePackage, RuntimePackageError> {
    decode_prepared(package, None)
}

pub(super) fn validate_render_environment(
    package: &RuntimePackageEnvelope,
) -> Result<(), RuntimePackageError> {
    solid_environment::validate_static_lightmap(
        payload(package, &package.entrypoints.environment)?,
        payload(package, &package.entrypoints.render_packet)?,
    )
    .map_err(RuntimePackageError)?;
    Ok(())
}

pub(super) fn decode_prepared(
    package: RuntimePackageEnvelope,
    prepared_render: Option<(
        crate::contract::RenderPacket,
        crate::contract::ContractSummary,
    )>,
) -> Result<LoadedRuntimePackage, RuntimePackageError> {
    let render_id = package.entrypoints.render_packet.as_str();
    descriptor(&package, render_id, RuntimeResourceKind::RenderPacket)?;
    validate_object_bindings(&package.object_bindings)?;
    if prepared_render.is_none() {
        validate_render_environment(&package)?;
    }
    let (render_packet, render_summary) = match prepared_render {
        Some(prepared) => prepared,
        None => render_packet::decode(render_id, payload(&package, render_id)?)?,
    };
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
    let probe_grid_records =
        solid_environment::decode_probe_grid(payload(&package, &package.entrypoints.environment)?)
            .map_err(RuntimePackageError)?;
    let solid_environment = decode_background(&package, &package.entrypoints.environment)?;
    let background = solid_environment.as_ref().map(|decoded| decoded.background);
    let studio_background_gradient = solid_environment
        .as_ref()
        .is_some_and(|decoded| decoded.studio_gradient);
    let fog = solid_environment.as_ref().and_then(|decoded| decoded.fog);
    // v9 作者色彩分级：仅纯色环境 v9 档声明时存在，旧包恒 None（精确中性）。
    let author_grading = solid_environment
        .as_ref()
        .and_then(|decoded| decoded.grading);
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
        studio_background_gradient,
        lighting,
        fog,
        author_grading,
        display_profile: solid_environment
            .as_ref()
            .map(|decoded| decoded.display_profile)
            .unwrap_or_default(),
        shader_packages,
        material_bindings: package.material_bindings,
        dynamic_runtime,
        probe_grid_records,
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
        // Studio v10 retains its declared IBL; grading v9 can explicitly disable it.
        if payload(package, id)?.get("kind").and_then(Value::as_str)
            == Some("solid-background-builtin-ibl")
        {
            if payload(package, id)?
                .get("schemaVersion")
                .and_then(Value::as_u64)
                == Some(10)
            {
                return Ok(crate::ibl::author_studio_environment());
            }
            return Ok(builtin_default_environment());
        }
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

#[cfg(test)]
mod environment_consumption_tests {
    use super::*;

    fn environment(version: u32, kind: &str) -> RuntimePackageEnvelope {
        let mut package: RuntimePackageEnvelope =
            serde_json::from_str(include_str!("../../tests/fixtures/runtime-package-v1.json"))
                .unwrap();
        let previous = package.entrypoints.environment.clone();
        let id = "scene.environment".to_owned();
        package.payloads.remove(&previous);
        package
            .resources
            .iter_mut()
            .find(|entry| entry.id == previous)
            .unwrap()
            .id = id.clone();
        package.entrypoints.environment = id.clone();
        let mut source = serde_json::json!({"schema":"deep-engine.solid-environment",
            "schemaVersion":version,"id":id,"revision":1,"kind":kind,
            "backgroundSrgb":[0.04,0.08,0.12],"outputTransform":if version == 10 {
                "native-aces-studio-gradient-v10"
            } else { "native-aces-grading-v9" }});
        if version == 9 {
            source["colorGrading"] = serde_json::json!({"hue":0,"saturation":0,
                "brightness":0,"contrast":0,"temperature":0,"tint":0});
        }
        package.payloads.insert(id, source);
        package
    }

    #[test]
    fn studio_v10_loads_the_declared_reflection_environment() {
        let package = environment(10, "solid-background-builtin-ibl");
        let loaded = decode_environment(&package, &package.entrypoints.environment).unwrap();
        assert_eq!(loaded.provenance, crate::ibl::IblProvenance::BuiltInDefault);
        assert!(
            loaded
                .specular
                .mips
                .iter()
                .flat_map(|mip| &mip.texels)
                .any(|pixel| pixel[0] > 0.001)
        );
        assert_eq!(loaded.id, "deep.builtin.author-studio-ibl.v1");
    }

    #[test]
    fn grading_without_ibl_keeps_reflections_disabled() {
        let package = environment(9, "solid-background-no-ibl");
        let loaded = decode_environment(&package, &package.entrypoints.environment).unwrap();
        assert_eq!(loaded.provenance, crate::ibl::IblProvenance::DisabledProbe);
        assert!(
            loaded
                .specular
                .mips
                .iter()
                .flat_map(|mip| &mip.texels)
                .all(|pixel| pixel[..3] == [0.0, 0.0, 0.0])
        );
    }
}

#[cfg(test)]
mod object_binding_tests {
    use super::RuntimePackageEnvelope;
    use super::{RuntimeObjectBinding, validate_object_bindings};

    fn binding(node_id: &str, instance_ids: &[&str]) -> RuntimeObjectBinding {
        RuntimeObjectBinding {
            node_id: node_id.to_string(),
            instance_ids: instance_ids.iter().map(|id| id.to_string()).collect(),
        }
    }

    #[test]
    fn accepts_unique_non_empty_mappings() {
        assert!(
            validate_object_bindings(&[
                binding("node-a", &["i-1", "i-2"]),
                binding("node-b", &["i-3"])
            ])
            .is_ok()
        );
    }

    #[test]
    fn fails_closed_on_contract_violations() {
        assert!(validate_object_bindings(&[binding("", &["i-1"])]).is_err());
        assert!(validate_object_bindings(&[binding("a", &[])]).is_err());
        assert!(validate_object_bindings(&[binding("a", &["i-1", "i-1"])]).is_err());
        assert!(
            validate_object_bindings(&[binding("a", &["i-1"]), binding("a", &["i-2"])]).is_err()
        );
    }

    #[test]
    fn deserializes_camel_case_keys_and_defaults_legacy_packages() {
        let parsed: RuntimeObjectBinding = serde_json::from_value(
            serde_json::json!({ "nodeId": "node-a", "instanceIds": ["i-1", "i-2"] }),
        )
        .expect("camelCase binding");
        assert_eq!(parsed.node_id, "node-a");
        assert_eq!(
            parsed.instance_ids,
            vec!["i-1".to_string(), "i-2".to_string()]
        );
        // serde_json::from_value 拒绝未知字段;node_id 之外的拼写立即失败。
        assert!(
            serde_json::from_value::<RuntimeObjectBinding>(
                serde_json::json!({ "NodeId": "a", "instanceIds": ["i"] })
            )
            .is_err()
        );
        let legacy = serde_json::json!({
            "schema": "deep-engine.runtime-package", "schemaVersion": 1,
            "packageId": "p", "packageVersion": "1.0.0",
            "entrypoints": { "renderPacket": "r", "deep2d": null, "environment": "e", "shaderPackages": [] },
            "resources": [], "payloads": {},
            "packageHash": { "algorithm": "sha256", "value": "0" }
        });
        let envelope: RuntimePackageEnvelope =
            serde_json::from_value(legacy).expect("legacy envelope");
        assert!(envelope.object_bindings.is_empty());
    }
}
