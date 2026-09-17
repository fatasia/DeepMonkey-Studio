use super::{AlphaMode, RenderPacket, validate_packet};
use crate::scene::{prepare_scene, transparent_batch_order};
use serde_json::json;

fn packet_json(materials: serde_json::Value) -> serde_json::Value {
    json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [{
            "id": "g", "revision": 0,
            "vertices": [
                0.0, 0.0, 0.0, 0.0, 1.0, 0.0,
                1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 1.0, 0.0, 1.0, 0.0,
            ],
            "indices": [0, 1, 2],
        }],
        "materials": materials,
        "instances": [{
            "id": "i", "geometry": "g", "material": "m",
            "transform": [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
        }],
    })
}

fn instance_json(id: &str, material: &str, x: f32) -> serde_json::Value {
    // 列主序:平移占据索引 12..15,validate 拒绝非仿射。
    json!({
        "id": id, "geometry": "g", "material": material,
        "transform": [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, 0.0, 0.0, 1.0],
    })
}

/// DE26/C03 透明语义:premultiplied 序列化为 null(=字段缺省)时是旧包的 straight 语义。
fn glass(premultiplied: Option<bool>, alpha_mode: &str) -> serde_json::Value {
    let mut material = json!({
        "id": "m", "baseColor": [1.0, 1.0, 1.0], "metallic": 0.0, "roughness": 1.0,
        "baseColorAlpha": 0.4, "alphaMode": alpha_mode, "doubleSided": true,
    });
    if let Some(value) = premultiplied {
        material["premultipliedAlpha"] = json!(value);
    }
    material
}

fn parse(packet: serde_json::Value) -> Result<RenderPacket, String> {
    serde_json::from_value(packet).map_err(|error| format!("invalid RenderPacket JSON: {error}"))
}

#[test]
fn legacy_packet_without_premultiplied_alpha_parses_and_validates_unchanged() {
    let packet =
        parse(packet_json(json!([glass(None, "BLEND")]))).expect("legacy packet must parse");
    validate_packet(&packet).expect("legacy packet must validate");
    let scene = prepare_scene(&packet).expect("legacy scene must prepare");
    assert!(!scene.batches[0].premultiplied);
    assert_eq!(scene.batches[0].alpha_mode, AlphaMode::Blend);
    assert!(scene.batches[0].double_sided);
    assert_eq!(scene.instances[0][31], 1.0 + 4.0);
}

#[test]
fn premultiplied_blend_roundtrips_with_batch_and_flag_bits() {
    let packet = parse(packet_json(json!([glass(Some(true), "BLEND")])))
        .expect("premultiplied packet must parse");
    validate_packet(&packet).expect("premultiplied BLEND is a supported combination");
    let scene = prepare_scene(&packet).expect("scene must prepare");
    assert!(scene.batches[0].premultiplied);
    // 实例 flags:1 double + 4 blend + 128 premultiplied,与 Browser surface_flags 位图逐位对拍。
    assert_eq!(scene.instances[0][31], 1.0 + 4.0 + 128.0);
}

#[test]
fn premultiplied_alpha_outside_blend_fails_closed() {
    for alpha_mode in ["OPAQUE", "MASK"] {
        for premultiplied in [false, true] {
            let packet = parse(packet_json(json!([glass(Some(premultiplied), alpha_mode)])))
                .expect("serde accepts the boolean before validation");
            let error =
                validate_packet(&packet).expect_err("premultiplied outside BLEND must fail");
            assert!(
                error.contains("premultipliedAlpha outside BLEND"),
                "{error}"
            );
        }
    }
}

#[test]
fn premultiplied_false_is_explicit_straight_and_matches_omitted() {
    let packet = parse(packet_json(json!([glass(Some(false), "BLEND")])))
        .expect("explicit straight must parse");
    validate_packet(&packet).expect("explicit straight is valid");
    let scene = prepare_scene(&packet).expect("scene must prepare");
    assert!(!scene.batches[0].premultiplied);
    assert_eq!(scene.instances[0][31], 1.0 + 4.0);
}

#[test]
fn straight_and_premultiplied_glass_keep_separate_batches() {
    let materials = json!([
        { "id": "straight", "baseColor": [1.0, 1.0, 1.0], "metallic": 0.0, "roughness": 1.0,
          "baseColorAlpha": 0.4, "alphaMode": "BLEND" },
        { "id": "premultiplied", "baseColor": [1.0, 1.0, 1.0], "metallic": 0.0, "roughness": 1.0,
          "baseColorAlpha": 0.4, "alphaMode": "BLEND", "premultipliedAlpha": true },
    ]);
    let mut packet = packet_json(materials);
    packet["instances"] = json!([
        instance_json("a", "straight", 0.0),
        instance_json("b", "straight", 1.0),
        instance_json("c", "premultiplied", 2.0),
    ]);
    let packet = parse(packet).expect("mixed packet must parse");
    let scene = prepare_scene(&packet).expect("scene must prepare");
    // Native 既有设计:每个 BLEND 实例保持独立批以支撑全局排序;premultiplied 不得与 straight 合并。
    assert_eq!(scene.batches.len(), 3);
    let premultiplied: Vec<&crate::scene::DrawBatch> = scene
        .batches
        .iter()
        .filter(|batch| batch.premultiplied)
        .collect();
    assert_eq!(premultiplied.len(), 1);
    let batch = premultiplied[0];
    let ids: Vec<&String> = scene.instance_ids
        [batch.instance_start as usize..(batch.instance_start + batch.instance_count) as usize]
        .iter()
        .collect();
    assert_eq!(ids, vec![&"c".to_string()]);
}

#[test]
fn transparent_batch_order_is_deterministic_within_a_frame_and_back_to_front() {
    let materials = json!([
        { "id": "near", "baseColor": [1.0, 1.0, 1.0], "metallic": 0.0, "roughness": 1.0,
          "baseColorAlpha": 0.5, "alphaMode": "BLEND" },
        { "id": "far", "baseColor": [1.0, 1.0, 1.0], "metallic": 0.0, "roughness": 1.0,
          "baseColorAlpha": 0.5, "alphaMode": "BLEND" },
    ]);
    let mut packet = packet_json(materials);
    // rotated_z 是相机空间 z(相机看 -z):z 越小越远,view_depth=4-z 越大;排序降序 = 远的先画。
    let near = instance_json("near", "near", 0.0);
    let mut far = instance_json("far", "far", 0.0);
    far["transform"][14] = json!(-5.0);
    packet["instances"] = json!([near, far]);
    let packet = parse(packet).expect("ordered packet must parse");
    let scene = prepare_scene(&packet).expect("scene must prepare");
    // 排序跳变边界(排序声明):同一帧同一 yaw 下排序结果确定,帧内无次序抖动。
    assert_eq!(
        transparent_batch_order(&scene.batches, 0.0),
        transparent_batch_order(&scene.batches, 0.0)
    );
    let order = transparent_batch_order(&scene.batches, 0.0);
    assert_eq!(order.len(), 2);
    let first = &scene.batches[order[0]];
    let second = &scene.batches[order[1]];
    // back-to-front:远(z=-5)先画,近(z=0)后画。
    assert!(
        first.sort_center.expect("BLEND carries sort center")[2]
            < second.sort_center.expect("BLEND carries sort center")[2]
    );
}
