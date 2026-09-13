use deep_engine_native::{
    cascaded_shadow::CASCADED_SHADOW_UNIFORM_BYTES,
    shader_package::{
        DEEP_PBR_MESH_V1_ID, DEEP_PBR_MESH_V1_SHA256, DEEP_PBR_MESH_V2_ID, DEEP_PBR_MESH_V2_SHA256,
        DeepShaderPackageV2, ShaderAbiBindingResource, parse_and_validate_shader_package,
        plan_shader_package_bytes,
    },
};
use serde_json::{Value, json};

const V1: &[u8] = include_bytes!("fixtures/deep_shader_package_gpu_v2.json");

fn v2() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/deep_shader_package_csm_v2.json"
    ))
    .expect("CSM fixture")
}

fn package(bytes: &[u8]) -> DeepShaderPackageV2 {
    parse_and_validate_shader_package(bytes).expect("valid cross-language fixture")
}

fn rejected(mutate: impl FnOnce(&mut Value)) -> String {
    let mut value: Value = serde_json::from_slice(&v2()).expect("fixture JSON");
    mutate(&mut value);
    parse_and_validate_shader_package(&serde_json::to_vec(&value).expect("serialize"))
        .expect_err("mutated ABI must be rejected")
        .to_string()
}

#[test]
fn accepts_both_frozen_abis_without_changing_shared_memory_and_raster_contracts() {
    let old = package(V1).shader_abi;
    let new = package(&v2()).shader_abi;
    assert_eq!(old.id, DEEP_PBR_MESH_V1_ID);
    assert_eq!(old.content_hash.value, DEEP_PBR_MESH_V1_SHA256);
    assert_eq!(new.id, DEEP_PBR_MESH_V2_ID);
    assert_eq!(new.content_hash.value, DEEP_PBR_MESH_V2_SHA256);
    assert_eq!(new.contract.schema_version, 1);
    let previous = old.contract;
    let current = new.contract;
    assert_eq!(current.vertex_streams, previous.vertex_streams);
    assert_eq!(current.attachment_profiles, previous.attachment_profiles);
    assert_eq!(current.alpha_modes, previous.alpha_modes);
    assert_eq!(current.raster_modes, previous.raster_modes);
    assert_eq!(current.material_modes, previous.material_modes);
    assert_eq!(current.pass_variants, previous.pass_variants);
    assert_eq!(current.data_layouts.len(), previous.data_layouts.len() + 1);
    for layout in &previous.data_layouts {
        assert_eq!(
            current
                .data_layouts
                .iter()
                .find(|item| item.id == layout.id),
            Some(layout)
        );
    }
    for layout in &previous.bind_group_layouts {
        if layout.id != "forward-frame" {
            assert_eq!(
                current
                    .bind_group_layouts
                    .iter()
                    .find(|item| item.id == layout.id),
                Some(layout)
            );
        }
    }
}

#[test]
fn csm_uniform_matches_native_packing_and_forward_texture_array() {
    let abi = package(&v2()).shader_abi.contract;
    let csm = abi
        .data_layouts
        .iter()
        .find(|item| item.id == "cascaded-shadow")
        .expect("CSM");
    assert_eq!(u64::from(csm.byte_size), CASCADED_SHADOW_UNIFORM_BYTES);
    assert_eq!(csm.byte_alignment, 16);
    assert_eq!(csm.storage, "uniform");
    assert_eq!(csm.members.len(), 9);
    for (index, member) in csm.members.iter().take(4).enumerate() {
        assert_eq!(member.name, format!("matrix{index}"));
        assert_eq!(member.format, "mat4x4<f32>");
        assert_eq!(member.byte_offset, index as u32 * 64);
        assert_eq!(member.byte_size, 64);
    }
    for (index, name) in [
        "split_depths",
        "blend_starts",
        "texel_world",
        "params",
        "camera_forward",
    ]
    .into_iter()
    .enumerate()
    {
        let member = &csm.members[index + 4];
        assert_eq!(member.name, name);
        assert_eq!(member.format, "vec4<f32>");
        assert_eq!(member.byte_offset, 256 + index as u32 * 16);
        assert_eq!(member.byte_size, 16);
    }
    let frame = abi
        .bind_group_layouts
        .iter()
        .find(|item| item.id == "forward-frame")
        .expect("frame");
    assert_eq!(frame.bindings.len(), 8);
    assert!(matches!(
        &frame.bindings[1].resource,
        ShaderAbiBindingResource::Texture { sample_type, view_dimension, multisampled: false }
        if sample_type == "depth" && view_dimension == "2d-array"
    ));
    assert!(matches!(
        &frame.bindings[7].resource,
        ShaderAbiBindingResource::UniformBuffer { data_layout, min_binding_size: 336 }
        if data_layout == "cascaded-shadow"
    ));
}

#[test]
fn rejects_cross_version_identity_and_fingerprint_substitution() {
    for (path, value) in [
        ("/shaderAbi/id", json!(DEEP_PBR_MESH_V1_ID)),
        ("/shaderAbi/id", json!("deep.pbr.mesh.v3")),
        ("/shaderAbi/contract/id", json!(DEEP_PBR_MESH_V1_ID)),
        ("/shaderAbi/contract/schemaVersion", json!(2)),
        (
            "/shaderAbi/contentHash/value",
            json!(DEEP_PBR_MESH_V1_SHA256),
        ),
        ("/shaderAbi/contentHash/algorithm", json!("sha512")),
    ] {
        let error = rejected(|package| *package.pointer_mut(path).expect("field") = value);
        assert!(error.contains("identity or fingerprint"), "{path}: {error}");
    }
}

#[test]
fn rejects_csm_layout_and_descriptor_tampering_before_pipeline_planning() {
    for (path, value) in [
        (
            "/bindGroupLayouts/0/bindings/1/resource/viewDimension",
            json!("2d"),
        ),
        (
            "/bindGroupLayouts/0/bindings/7/resource/minBindingSize",
            json!(320),
        ),
        ("/bindGroupLayouts/0/bindings/7/binding", json!(8)),
        (
            "/bindGroupLayouts/0/bindings/7/visibility",
            json!(["vertex"]),
        ),
    ] {
        let error = rejected(|package| {
            *package["shaderAbi"]["contract"]
                .pointer_mut(path)
                .expect("field") = value;
        });
        assert!(
            error.contains("contract differs from deep.pbr.mesh.v2"),
            "{path}: {error}"
        );
    }
    let error = rejected(|package| {
        let layouts = package["shaderAbi"]["contract"]["dataLayouts"]
            .as_array_mut()
            .expect("layouts");
        let csm = layouts
            .iter_mut()
            .find(|item| item["id"] == "cascaded-shadow")
            .expect("CSM");
        csm["members"][8]["byteOffset"] = json!(304);
    });
    assert!(error.contains("contract differs from deep.pbr.mesh.v2"));
    assert!(rejected(|package| {
        package["shaderAbi"]["contract"]["bindGroupLayouts"][0]["bindings"][7]["resource"]["hasDynamicOffset"] = json!(true);
    }).contains("unknown field"));
}

#[test]
fn every_forward_plan_uses_csm_and_every_shadow_keeps_its_original_attachment() {
    let plan = plan_shader_package_bytes(&v2()).expect("CSM pipeline plan");
    assert!(plan.passes.iter().any(|pass| pass.kind == "forward"));
    assert!(plan.passes.iter().any(|pass| pass.kind == "shadow"));
    for pass in plan.passes {
        let frame = &pass.bind_group_layouts[0];
        assert_eq!(frame.group, 0);
        if pass.kind == "forward" {
            assert_eq!(frame.id, "forward-frame");
            assert_eq!(frame.bindings.len(), 8);
            assert_eq!(pass.attachment_profile.sample_count, 4);
            assert!(pass.resolve_required);
        } else {
            assert_eq!(frame.id, "shadow-frame");
            assert_eq!(frame.bindings.len(), 1);
            assert_eq!(pass.attachment_profile.sample_count, 1);
            assert!(!pass.resolve_required);
            assert_eq!(
                pass.attachment_profile.depth_attachment.format,
                "depth32float"
            );
        }
    }
}
