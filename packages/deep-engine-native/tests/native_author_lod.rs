use deep_engine_native::{
    contract::{RenderPacket, validate_packet},
    lod_contract::prepare_gpu_lod,
    runtime_package::parse_and_validate_runtime_package,
    scene::prepare_scene,
};
use serde_json::{Value, json};

#[path = "../src/shadow_update_classify/mod.rs"]
mod shadow_update_classify;

#[test]
fn lod_revision_selection_and_legacy_changes_invalidate_shadows_only_when_changed() {
    for bytes in [
        include_bytes!("fixtures/runtime-package-author-lod-v1.json").as_slice(),
        include_bytes!("fixtures/runtime-package-lod-v1.json").as_slice(),
    ] {
        let old = parse_and_validate_runtime_package(bytes)
            .unwrap()
            .render_packet;
        let mut new = parse_and_validate_runtime_package(bytes)
            .unwrap()
            .render_packet;
        assert!(!shadow_update_classify::classify_shadow_relevance(&old, &new).must_invalidate);
        let lod = new.instances[0].lod.as_mut().unwrap();
        if let Some(a) = &mut lod.author {
            a.selected_levels.clear();
        } else {
            lod.hysteresis_ratio = Some(0.2);
        }
        assert!(shadow_update_classify::classify_shadow_relevance(&old, &new).must_invalidate);
        assert!(shadow_update_classify::classify_shadow_relevance(&new, &old).must_invalidate);
    }
    let mut v = source();
    v["instances"][0]["lod"]["selectedLevels"] = json!([0.0, 2.0]);
    assert!(accepts(v));
    assert!(serde_json::from_str::<deep_engine_native::contract::RenderLodProfile>(r#"{"strategy":"author-selected","revision":1,"revision":2,"levels":[],"selectedLevels":[]}"#).is_err());
}

fn source() -> Value {
    serde_json::from_slice::<Value>(include_bytes!(
        "fixtures/runtime-package-author-lod-v1.json"
    ))
    .unwrap()["payloads"]["scene.author-lod"]
        .clone()
}
fn accepts(v: Value) -> bool {
    serde_json::from_value::<RenderPacket>(v).is_ok_and(|p| validate_packet(&p).is_ok())
}

#[test]
fn shared_author_golden_preserves_every_selection_and_resident_geometry() {
    let loaded = parse_and_validate_runtime_package(include_bytes!(
        "fixtures/runtime-package-author-lod-v1.json"
    ))
    .unwrap();
    let packet = loaded.render_packet;
    let scene = prepare_scene(&packet).unwrap();
    let gpu = prepare_gpu_lod(&packet, &scene).unwrap();
    assert_eq!(scene.batches.len(), 7);
    for (i, batch) in scene.batches.iter().enumerate() {
        let id = &scene.instance_ids[batch.instance_start as usize];
        let profile = packet
            .instances
            .iter()
            .find(|x| &x.id == id)
            .unwrap()
            .lod
            .as_ref()
            .unwrap();
        let author = profile.author.as_ref().unwrap();
        let encoded = serde_json::to_value(profile).unwrap();
        assert_eq!(encoded["strategy"], "author-selected");
        for (level, draw) in gpu.batches[i].iter().enumerate() {
            assert!(draw.resident);
            assert_eq!(
                gpu.levels[draw.indirect_index as usize][0][3],
                u32::from(author.selected_levels.contains(&level))
            );
        }
    }
    assert!(gpu.objects.iter().all(|x| x[0][3] & 4 == 4));
}

#[test]
fn author_contract_rejects_invalid_limits_and_mixed_variants() {
    for (field, invalid) in [
        ("strategy", json!("unknown")),
        ("strategy", Value::Null),
        ("revision", json!(-1)),
        ("revision", json!(0.5)),
        ("revision", json!(9007199254740992u64)),
        ("selectedLevels", json!([1, 0])),
        ("selectedLevels", json!([1, 1])),
        ("selectedLevels", json!([3])),
        ("selectedLevels", json!([-1])),
        ("resident", json!(true)),
        ("hysteresisRatio", json!(0.1)),
    ] {
        let mut v = source();
        v["instances"][0]["lod"][field] = invalid;
        assert!(!accepts(v), "accepted {field}");
    }
    for (field, invalid) in [
        ("distance", json!(-1)),
        ("hysteresis", json!(1.01)),
        ("resident", json!(false)),
        ("geometry", json!("absent")),
    ] {
        let mut v = source();
        v["instances"][0]["lod"]["levels"][1][field] = invalid;
        assert!(!accepts(v), "accepted {field}");
    }
    let mut v = source();
    v["instances"][0]["lod"]["levels"] =
        json!([{ "geometry":"lod.high", "distance":0,"hysteresis":1 }]);
    v["instances"][0]["lod"]["selectedLevels"] = json!([]);
    assert!(accepts(v));
}
