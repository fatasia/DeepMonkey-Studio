use deep_engine_native::runtime_package::{
    parse_and_validate_runtime_package, runtime_content_sha256, runtime_package_sha256,
};
use serde_json::{Value, json};
fn golden() -> Value {
    serde_json::from_str(include_str!(
        "../../deep-engine/fixtures/dashboard-composition-v1.json"
    ))
    .unwrap()
}
fn root(p: &mut Value) -> &mut Value {
    let id = p["entrypoints"]["dashboard"].as_str().unwrap().to_owned();
    &mut p["payloads"][id]
}
fn rehash(p: &mut Value) {
    let hashes: Vec<_> = p["resources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let id = r["id"].as_str().unwrap();
            runtime_content_sha256(&p["payloads"][id])
        })
        .collect();
    for (r, h) in p["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(hashes)
    {
        r["contentHash"]["value"] = json!(h);
    }
    p["packageHash"]["value"] = json!(runtime_package_sha256(p).unwrap());
}
fn rejects(mut p: Value) {
    rehash(&mut p);
    assert!(parse_and_validate_runtime_package(&serde_json::to_vec(&p).unwrap()).is_err());
}
#[test]
fn loads_typescript_composition_golden_without_duplicate_content() {
    let p = golden();
    let loaded = parse_and_validate_runtime_package(&serde_json::to_vec(&p).unwrap()).unwrap();
    assert!(loaded.chart.is_none() && loaded.chart_sim.is_none() && loaded.deep2d.is_none());
    let d = loaded.dashboard.unwrap();
    assert_eq!(d.document.pages.len(), 2);
    assert_eq!(d.charts.len(), 2);
    assert_eq!(d.simulations.len(), 2);
    assert_eq!(d.deep2d.len(), 2);
    for n in d.document.pages.iter().flat_map(|p| &p.nodes) {
        if let Some(id) = &n.chart {
            assert!(d.charts.contains_key(id));
        }
        if let Some(id) = &n.deep2d {
            assert!(d.deep2d.contains_key(id));
        }
    }
}
#[test]
fn required_nullable_and_unknown_fields_are_strict() {
    for key in ["clip", "hitId", "deep2d", "chart", "chartSim"] {
        let mut p = golden();
        root(&mut p)["pages"][0]["nodes"][0]
            .as_object_mut()
            .unwrap()
            .remove(key);
        rejects(p);
    }
    for key in ["deep2d", "chart", "chartSim", "dashboard"] {
        let mut p = golden();
        p["entrypoints"].as_object_mut().unwrap().remove(key);
        rejects(p);
    }
    let mut p = golden();
    root(&mut p)["unknown"] = json!(true);
    rejects(p);
    let mut p = golden();
    p["entrypoints"]["camera"] = Value::Null;
    rejects(p);
}
#[test]
fn invalid_identity_geometry_order_and_content_fail() {
    for (key, value) in [
        ("revision", json!(0)),
        ("frame", json!([0, 0, 0, 100])),
        ("clip", json!([0, 0, -1, 2])),
        ("hitId", json!("other")),
        ("zOrder", json!(2147483648i64)),
        ("id", json!("node.invalid")),
    ] {
        let mut p = golden();
        root(&mut p)["pages"][0]["nodes"][0][key] = value;
        rejects(p);
    }
    let mut p = golden();
    root(&mut p)["pages"][0]["nodes"]
        .as_array_mut()
        .unwrap()
        .reverse();
    rejects(p);
    let mut p = golden();
    let n = &mut root(&mut p)["pages"][0]["nodes"][0];
    n["deep2d"] = Value::Null;
    n["chart"] = Value::Null;
    rejects(p);
    for (key, value) in [
        ("documentRevision", json!(9007199254740992u64)),
        ("documentId", json!("bad\u{0080}")),
        ("entryPageId", json!("missing")),
    ] {
        let mut p = golden();
        root(&mut p)[key] = value;
        rejects(p);
    }
}
#[test]
fn ownership_kind_missing_and_unreferenced_resources_fail() {
    let mut p = golden();
    let n = root(&mut p)["pages"][0]["nodes"][0].clone();
    root(&mut p)["pages"][1]["nodes"][0] = n;
    rejects(p);
    for id in ["missing", "dashboard.root"] {
        let mut p = golden();
        root(&mut p)["pages"][0]["nodes"][0]["deep2d"] = json!(id);
        rejects(p);
    }
    let mut p = golden();
    root(&mut p)["pages"][1]["nodes"] = json!([]);
    rejects(p);
    let mut p = golden();
    let nodes = root(&mut p)["pages"][0]["nodes"]
        .as_array()
        .unwrap()
        .clone();
    let chart_node = nodes
        .iter()
        .find(|n| n["chart"].is_string())
        .unwrap()
        .clone();
    let mut reused = chart_node;
    reused["id"] = json!(format!("node.{}", "f".repeat(64)));
    reused["hitId"] = Value::Null;
    root(&mut p)["pages"][1]["nodes"] = json!([reused]);
    rejects(p);
}
#[test]
fn chart_identity_and_sim_target_must_be_local() {
    let mut p = golden();
    let a = p["payloads"]["dashboard.chart.a"]["chart"]["id"].clone();
    p["payloads"]["dashboard.chart.b"]["chart"]["id"] = a;
    rejects(p);
    let mut p = golden();
    p["payloads"]["dashboard.sim.a"]["fixture"]["chartId"] = json!("wrong");
    rejects(p);
}
#[test]
fn old_versions_reject_dashboard_and_bad_hash_is_detected() {
    for version in 1..=4 {
        let mut p = golden();
        p["schemaVersion"] = json!(version);
        rejects(p);
    }
    let mut p = golden();
    root(&mut p)["documentId"] = json!("changed");
    assert!(parse_and_validate_runtime_package(&serde_json::to_vec(&p).unwrap()).is_err());
}

#[test]
fn dashboard_integer_numbers_accept_decimal_tokens() {
    let mut p = golden();
    let r = root(&mut p);
    r["schemaVersion"] = json!(1.0);
    r["revision"] = json!(1.0);
    r["documentRevision"] = json!(1.0);
    for page in r["pages"].as_array_mut().unwrap() {
        for node in page["nodes"].as_array_mut().unwrap() {
            node["revision"] = json!(1.0);
            let z = node["zOrder"].as_f64().unwrap();
            node["zOrder"] = json!(z);
        }
    }
    rehash(&mut p);
    parse_and_validate_runtime_package(&serde_json::to_vec(&p).unwrap()).unwrap();
}
#[test]
fn simulation_semantics_are_checked_before_host_loading() {
    for (field, value) in [
        ("intervalMs", json!(0)),
        ("maxRows", json!(0)),
        ("datasetId", json!("absent")),
        ("dimensions", json!(["wrong"])),
        ("schema", json!("wrong")),
    ] {
        let mut p = golden();
        p["payloads"]["dashboard.sim.a"]["fixture"][field] = value;
        rejects(p);
    }
}

#[test]
fn positive_tiny_frames_have_same_package_semantics_with_or_without_sim() {
    for with_sim in [true, false] {
        let mut p = golden();
        let nodes = root(&mut p)["pages"][0]["nodes"].as_array_mut().unwrap();
        let node = nodes.iter_mut().find(|n| n["chart"].is_string()).unwrap();
        node["frame"] = json!([0, 0, 1, 1]);
        if !with_sim {
            let sim = node["chartSim"].as_str().unwrap().to_owned();
            node["chartSim"] = Value::Null;
            p["payloads"].as_object_mut().unwrap().remove(&sim);
            p["resources"]
                .as_array_mut()
                .unwrap()
                .retain(|r| r["id"] != sim);
        }
        rehash(&mut p);
        parse_and_validate_runtime_package(&serde_json::to_vec(&p).unwrap()).unwrap();
    }
}
