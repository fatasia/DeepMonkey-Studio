use std::path::PathBuf;

use deep_engine_native::shader_package::{ShaderAbiBindingResource, plan_shader_package_bytes};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/{name}")))
        .expect("fixture")
}

#[test]
fn resolves_complete_forward_and_shadow_descriptor_plans() {
    let plan = plan_shader_package_bytes(&fixture("deep_shader_package_gpu_v2.json"))
        .expect("valid executable plan");
    assert_eq!(plan.package_id, "deep.native.gpu-probe");
    assert_eq!(plan.passes.len(), 2);

    let forward = plan
        .passes
        .iter()
        .find(|pass| pass.kind == "forward")
        .expect("forward");
    assert_eq!(forward.vertex_entry_point, "vertexMain");
    assert_eq!(
        forward.fragment_entry_point.as_deref(),
        Some("fragmentMain")
    );
    assert_eq!(forward.bind_group_layouts.len(), 1);
    assert_eq!(forward.bind_group_layouts[0].id, "forward-frame");
    assert_eq!(forward.bind_group_layouts[0].bindings.len(), 7);
    assert!(matches!(
        forward.bind_group_layouts[0].bindings[0].resource,
        ShaderAbiBindingResource::UniformBuffer {
            min_binding_size: 208,
            ..
        }
    ));
    assert_eq!(
        forward
            .vertex_streams
            .iter()
            .map(|value| value.slot)
            .collect::<Vec<_>>(),
        [0, 1]
    );
    assert_eq!(forward.vertex_streams[0].attributes[2].shader_location, 10);
    assert_eq!(forward.attachment_profile.sample_count, 4);
    assert_eq!(forward.attachment_profile.resolve, "required");
    assert_eq!(
        forward.attachment_profile.color_attachments[0].format,
        "rgba16float"
    );
    assert_eq!(
        forward.attachment_profile.depth_attachment.format,
        "depth24plus"
    );
    assert!(forward.resolve_required);
    assert_eq!(forward.raster_mode.cull_mode, "none");

    let shadow = plan
        .passes
        .iter()
        .find(|pass| pass.kind == "shadow")
        .expect("shadow");
    assert_eq!(shadow.vertex_entry_point, "shadowMain");
    assert_eq!(shadow.fragment_entry_point, None);
    assert_eq!(shadow.bind_group_layouts[0].id, "shadow-frame");
    assert_eq!(shadow.bind_group_layouts[0].bindings.len(), 1);
    assert!(shadow.attachment_profile.color_attachments.is_empty());
    assert_eq!(shadow.attachment_profile.sample_count, 1);
    assert_eq!(shadow.attachment_profile.resolve, "none");
    assert_eq!(
        shadow.attachment_profile.depth_attachment.format,
        "depth32float"
    );
    assert_eq!(shadow.attachment_profile.depth_attachment.depth_bias, 1);
    assert!(!shadow.resolve_required);
}

#[test]
fn plan_entry_point_keeps_strict_reader_in_front_of_descriptor_creation() {
    let error = plan_shader_package_bytes(br#"{"schemaVersion":2}"#)
        .expect_err("invalid package must not reach descriptor creation");
    assert!(error.to_string().contains("schema"));
}

#[test]
fn plan_serialization_is_machine_readable_and_reports_resolve_ownership() {
    let plan = plan_shader_package_bytes(&fixture("deep_shader_package_gpu_v2.json"))
        .expect("valid executable plan");
    let value = serde_json::to_value(plan).expect("serialize plan");
    assert_eq!(value["passes"][0]["resolveRequired"], true);
    assert_eq!(value["passes"][1]["resolveRequired"], false);
    assert_eq!(
        value["resourceOwnership"]["pipelineAndBindGroupLayouts"],
        "package-executor"
    );
    assert_eq!(value["resourceOwnership"]["bindGroups"], "renderer");
    assert_eq!(
        value["resourceOwnership"]["vertexAndIndexBuffers"],
        "renderer"
    );
    assert_eq!(value["resourceOwnership"]["attachments"], "renderer");
    assert_eq!(value["resourceOwnership"]["drawSubmission"], "renderer");
    assert_eq!(
        value["passes"][1]["attachmentProfile"]["depthAttachment"]["format"],
        "depth32float"
    );
}
