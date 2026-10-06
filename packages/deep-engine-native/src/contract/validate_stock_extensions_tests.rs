//! C9/native stock 扩展/advanced 子集守卫的合同测试:
//! 数值域 fail-closed、native 未消费 lobe 非零拒绝、unlit 拒绝、
//! 旧包(两字段缺席)不受影响、wire 反序列化(camelCase/deny_unknown_fields)。

use super::{
    LayerAnisotropyParams, LayerClearcoatParams, LayerMaterialParams, LayerTransmissionParams,
    PbrMaterial, RenderPacket, StockAdvancedParameters, StockIridescenceParameters,
    StockSheenParameters, StockVolumeParameters, validate_packet,
};

fn base_material() -> PbrMaterial {
    PbrMaterial {
        id: "m".into(),
        shading_model: None,
        base_color: [0.1, 0.2, 0.3],
        metallic: 0.4,
        roughness: 0.6,
        ior: None,
        base_color_texture: None,
        metallic_roughness_texture: None,
        normal_texture: None,
        occlusion_texture: None,
        emissive_factor: None,
        emissive_texture: None,
        base_color_alpha: None,
        alpha_mode: None,
        alpha_cutoff: None,
        double_sided: None,
        premultiplied_alpha: None,
        fog: None,
        layered: None,
        extended_parameters: None,
        advanced_parameters: None,
    }
}

fn packet_of(material: PbrMaterial) -> RenderPacket {
    RenderPacket {
        schema: super::CONTRACT_SCHEMA.into(),
        version: super::CONTRACT_VERSION,
        geometries: Vec::new(),
        materials: vec![material],
        instances: Vec::new(),
        textures: Vec::new(),
    }
}

fn extended(ior: Option<f32>, factor: f32, roughness: f32) -> LayerMaterialParams {
    LayerMaterialParams {
        ior,
        clearcoat: Some(LayerClearcoatParams { factor: Some(factor), roughness: Some(roughness) }),
        anisotropy: Some(LayerAnisotropyParams { strength: Some(0.0), rotation: Some(0.0) }),
        transmission: Some(LayerTransmissionParams { factor: Some(0.0) }),
    }
}

#[test]
fn stock_clearcoat_within_subset_passes() {
    let mut material = base_material();
    material.extended_parameters = Some(extended(Some(1.5), 0.9, 0.35));
    material.advanced_parameters = Some(StockAdvancedParameters {
        sheen: Some(StockSheenParameters { color: Some([0.35, 0.3, 0.25]), roughness: Some(0.6) }),
        iridescence: None,
        volume: None,
    });
    validate_packet(&packet_of(material)).expect("clearcoat+sheen subset must pass");
}

#[test]
fn nonzero_anisotropy_and_transmission_are_rejected() {
    let mut material = base_material();
    let mut params = extended(None, 0.0, 0.0);
    params.anisotropy = Some(LayerAnisotropyParams { strength: Some(0.4), rotation: Some(0.0) });
    material.extended_parameters = Some(params);
    let error = validate_packet(&packet_of(material)).unwrap_err();
    assert!(error.contains("anisotropy.strength"), "unexpected error: {error}");

    let mut material = base_material();
    let mut params = extended(None, 0.0, 0.0);
    params.transmission = Some(LayerTransmissionParams { factor: Some(0.6) });
    material.extended_parameters = Some(params);
    let error = validate_packet(&packet_of(material)).unwrap_err();
    assert!(error.contains("transmission.factor"), "unexpected error: {error}");
}

#[test]
fn nonzero_iridescence_and_volume_are_rejected() {
    let mut material = base_material();
    material.advanced_parameters = Some(StockAdvancedParameters {
        sheen: None,
        iridescence: Some(StockIridescenceParameters { factor: Some(0.5), ior: Some(1.3), thickness: Some(400.0) }),
        volume: None,
    });
    let error = validate_packet(&packet_of(material)).unwrap_err();
    assert!(error.contains("iridescence.factor"), "unexpected error: {error}");

    let mut material = base_material();
    material.advanced_parameters = Some(StockAdvancedParameters {
        sheen: None,
        iridescence: None,
        volume: Some(StockVolumeParameters {
            thickness: Some(2.0),
            attenuation_color: None,
            attenuation_distance: None,
        }),
    });
    let error = validate_packet(&packet_of(material)).unwrap_err();
    assert!(error.contains("volume.thickness"), "unexpected error: {error}");
}

#[test]
fn advanced_numeric_ranges_stay_fail_closed() {
    let mut material = base_material();
    material.advanced_parameters = Some(StockAdvancedParameters {
        sheen: Some(StockSheenParameters { color: Some([0.1, 1.2, 0.1]), roughness: None }),
        iridescence: None,
        volume: None,
    });
    assert!(validate_packet(&packet_of(material))
        .unwrap_err()
        .contains("sheen.color"));

    let mut material = base_material();
    material.advanced_parameters = Some(StockAdvancedParameters {
        sheen: None,
        iridescence: Some(StockIridescenceParameters { factor: None, ior: Some(0.5), thickness: None }),
        volume: None,
    });
    assert!(validate_packet(&packet_of(material))
        .unwrap_err()
        .contains("iridescence.ior"));
}

#[test]
fn extended_ior_must_match_instance_field() {
    let mut material = base_material();
    material.ior = Some(1.5);
    material.extended_parameters = Some(extended(Some(1.52), 0.0, 0.0));
    let error = validate_packet(&packet_of(material)).unwrap_err();
    assert!(error.contains("must match the v5 instance IOR field"), "unexpected error: {error}");
}

#[test]
fn unlit_rejects_extension_lobes() {
    use super::ShadingModel;
    let mut material = base_material();
    material.shading_model = Some(ShadingModel::Unlit);
    material.extended_parameters = Some(extended(None, 0.5, 0.2));
    assert!(validate_packet(&packet_of(material))
        .unwrap_err()
        .contains("Unlit materials cannot consume PBR extension lobes"));

    let mut material = base_material();
    material.shading_model = Some(ShadingModel::Unlit);
    material.advanced_parameters = Some(StockAdvancedParameters {
        sheen: Some(StockSheenParameters { color: Some([0.1, 0.1, 0.1]), roughness: None }),
        iridescence: None,
        volume: None,
    });
    assert!(validate_packet(&packet_of(material))
        .unwrap_err()
        .contains("Unlit materials cannot consume PBR extension lobes"));
}

/// 旧包 wire 兼容:不带扩展/advanced 字段的 JSON 反序列化与校验不受影响;
/// 新字段是 camelCase 闭合域,未知子键仍拒绝。
#[test]
fn legacy_wire_without_extension_fields_still_validates() {
    let packet: RenderPacket = serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [],
        "materials": [{
            "id": "legacy", "baseColor": [0.1, 0.2, 0.3], "metallic": 0.0, "roughness": 0.5
        }],
        "instances": [],
        "textures": []
    }))
    .expect("legacy wire must deserialize");
    validate_packet(&packet).expect("legacy wire must validate");

    let error = serde_json::from_value::<RenderPacket>(serde_json::json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [],
        "materials": [{
            "id": "closed", "baseColor": [0.1, 0.2, 0.3], "metallic": 0.0, "roughness": 0.5,
            "extendedParameters": { "clearcoat": { "factor": 0.5, "roughness": 0.2, "bogus": 1 } }
        }],
        "instances": [],
        "textures": []
    }))
    .unwrap_err();
    assert!(error.to_string().contains("unknown field"), "unexpected error: {error}");
}

/// native 子集 wire 端到端:clearcoat+sheen 反序列化 → 校验 → uniform 打包带。
#[test]
fn wire_subset_roundtrip_packs_expected_bands() {
    use crate::mesh_abi::{MATERIAL_ADVANCED_BAND_FLOAT_OFFSET, MATERIAL_EXTENDED_BAND_FLOAT_OFFSET};
    use crate::pbr_texture::prepare_material_uniform;
    let packet: RenderPacket = serde_json::from_value(serde_json::json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [],
        "materials": [{
            "id": "coat", "baseColor": [0.1, 0.2, 0.3], "metallic": 0.0, "roughness": 0.5,
            "extendedParameters": { "clearcoat": { "factor": 0.9, "roughness": 0.35 } },
            "advancedParameters": { "sheen": { "color": [0.35, 0.3, 0.25], "roughness": 0.6 } }
        }],
        "instances": [],
        "textures": []
    }))
    .expect("subset wire must deserialize");
    validate_packet(&packet).expect("subset wire must validate");
    let uniform = prepare_material_uniform(&packet.materials[0]).unwrap();
    assert_eq!(uniform[MATERIAL_EXTENDED_BAND_FLOAT_OFFSET..MATERIAL_EXTENDED_BAND_FLOAT_OFFSET + 6], {
        [1.5f32, 0.9, 0.35, 0.0, 0.0, 0.0]
    });
    assert_eq!(
        uniform[MATERIAL_ADVANCED_BAND_FLOAT_OFFSET..MATERIAL_ADVANCED_BAND_FLOAT_OFFSET + 4],
        [0.35f32, 0.3, 0.25, 0.6]
    );
    assert!(uniform[MATERIAL_ADVANCED_BAND_FLOAT_OFFSET + 4..].iter().all(|value| *value == 0.0));
}
