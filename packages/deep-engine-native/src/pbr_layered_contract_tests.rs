//! I-C23 Native 契约端到端:layered 字段的 serde/校验/prepare 行为。
//! 与 TS 双端对拍 fixture(packages/deep-engine/fixtures/
//! i-c23-native-layered-block-v1.json)共用同一规范输入。

use crate::contract::{LayerBlendMode, validate_packet};
use crate::pbr_texture::{prepare_material_uniform_rows, prepare_pbr_resources};

fn layered_packet_json() -> String {
    // 规范层栈:层 0 overlay + 双纹理(UV1/缩放),层 1 replace 纯色 —— 与
    // i-c23-native-layered-block-v1.json 的 material 字段同构。
    r#"{
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [],
        "materials": [{
            "id": "layered",
            "baseColor": [0.2, 0.3, 0.4],
            "metallic": 0.1,
            "roughness": 0.8,
            "layered": {
                "layers": [
                    {
                        "coverage": 0.75,
                        "mode": "overlay",
                        "surface": {
                            "baseColor": [0.8, 0.2, 0.1],
                            "metallic": 0.25,
                            "roughness": 0.5,
                            "baseColorTexture": { "texture": "color", "texCoord": 1, "offset": [0.25, 0], "scale": [1, 1], "rotation": 0 },
                            "metallicRoughnessTexture": { "texture": "mr", "texCoord": 0, "scale": [2, 2], "rotation": 0 }
                        }
                    },
                    {
                        "coverage": 0.5,
                        "mode": "replace",
                        "surface": { "baseColor": [0.1, 0.9, 0.4] }
                    }
                ]
            }
        }],
        "instances": [],
        "textures": [
            { "id": "color", "revision": 0, "semantic": "baseColor", "width": 1, "height": 1, "data": [240, 128, 70, 128] },
            { "id": "mr", "revision": 0, "semantic": "metallicRoughness", "width": 1, "height": 1, "data": [0, 128, 128, 255] }
        ]
    }"#
    .to_owned()
}

fn parse(json: &str) -> crate::contract::RenderPacket {
    serde_json::from_str(json).expect("layered packet parses")
}

/// 契约接受合法层栈;validate + prepare 全链通过,304B 块与 TS 权威
/// fixture 的块逐位一致(同一规范输入)。
#[test]
fn contract_accepts_layered_material_and_packs_web_identical_block() {
    let packet = parse(&layered_packet_json());
    validate_packet(&packet).expect("layered packet validates");
    let prepared = prepare_pbr_resources(&packet).expect("layered packet prepares");
    let block = prepared.materials[0]
        .layered
        .as_ref()
        .expect("layered rows resident")
        .block;
    assert_eq!(block.len(), 76);
    // 与 TS 权威 fixture 对拍(同一输入:packLayeredSurfaceBlock)。
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../deep-engine/fixtures/i-c23-native-layered-block-v1.json"
    ))
    .unwrap();
    let expected: Vec<f32> = fixture["block"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_f64().unwrap() as f32)
        .collect();
    for (index, (got, want)) in block.iter().zip(expected).enumerate() {
        assert_eq!(got.to_bits(), want.to_bits(), "block word {index}");
    }
    // 层纹理槽序 [base0, mr0, base1, mr1]:color=0、mr=1,层 1 无纹理。
    let layered = prepared.materials[0].layered.as_ref().unwrap();
    assert_eq!(
        layered.texture_indices,
        [Some(0), Some(1), None, None],
        "native D2 borrowing keeps base/mr slots and prunes the untextured layer"
    );
}

/// coverage=0 的层按合同剪除,只留活动层入槽。
#[test]
fn contract_prunes_zero_coverage_layers() {
    let mut packet = parse(&layered_packet_json());
    packet.materials[0].layered.as_mut().unwrap().layers[1].coverage = Some(0.0);
    let prepared = prepare_material_uniform_rows(&packet).unwrap();
    let layered = prepared[0].layered.as_ref().unwrap();
    // 块头 word0(activeCount)= 1;纹理槽只剩层 0 的两槽。
    assert_eq!(f32::to_bits(layered.block[0]), 1);
    assert_eq!(layered.texture_indices, [Some(0), Some(1), None, None]);
}

/// fail-closed:覆盖率越界、未知混合语义、未知层字段、>2 层、表面通道越界
/// 全部拒绝(serde unknown 拒绝由 deny_unknown_fields 家族保证)。
#[test]
fn contract_rejects_invalid_layered_materials() {
    let invalid = [
        // coverage 越界。
        r#"{"layers":[{"coverage":1.5}]}"#,
        // 未知混合语义。
        r#"{"layers":[{"coverage":0.5,"mode":"screen"}]}"#,
        // 未知层字段(deny_unknown_fields)。
        r#"{"layers":[{"coverage":0.5,"unknown":1}]}"#,
        // 超过 2 层。
        r#"{"layers":[{"coverage":0.5},{"coverage":0.5},{"coverage":0.5}]}"#,
        // 表面金属度越界。
        r#"{"layers":[{"coverage":0.5,"surface":{"metallic":2}}]}"#,
        // 未知 base 参数字段。
        r#"{"base":{"unknown":1},"layers":[]}"#,
    ];
    for raw in invalid {
        let mut packet = parse(&layered_packet_json());
        match serde_json::from_str::<crate::contract::LayeredMaterial>(raw) {
            // serde 层(deny_unknown_fields 家族、mode 白名单)直接拒绝。
            Err(_) => {}
            Ok(layered) => {
                packet.materials[0].layered = Some(layered);
                assert!(
                    validate_packet(&packet).is_err(),
                    "expected rejection for {raw}"
                );
            }
        }
    }
}

/// 层纹理槽的 UV set 需求与语义校验:texCoord 1 要求几何驻留 uv1;
/// 语义不匹配或缺失引用 fail-closed。
#[test]
fn contract_layer_texture_references_fail_closed() {
    // 语义不匹配:baseColor 层槽指向 metallicRoughness 纹理。
    let mut packet = parse(&layered_packet_json());
    packet.materials[0].layered.as_mut().unwrap().layers[0]
        .surface
        .as_mut()
        .unwrap()
        .base_color_texture
        .as_mut()
        .unwrap()
        .texture = "mr".into();
    assert!(validate_packet(&packet).is_err());
    // 缺失引用:validate 的语义表按 id 查找,缺失同样 fail-closed;
    // prepare 路径二次兜底报错。
    let mut packet = parse(&layered_packet_json());
    packet.materials[0].layered.as_mut().unwrap().layers[0]
        .surface
        .as_mut()
        .unwrap()
        .base_color_texture
        .as_mut()
        .unwrap()
        .texture = "missing".into();
    assert!(validate_packet(&packet).is_err());
    assert!(prepare_material_uniform_rows(&packet).is_err());
}

/// 混合语义打包码与 TS/Web 互钉(replace=0 / overlay=1)。
#[test]
fn blend_mode_codes_match_web_contract() {
    assert_eq!(LayerBlendMode::Replace.code(), 0.0);
    assert_eq!(LayerBlendMode::Overlay.code(), 1.0);
}
