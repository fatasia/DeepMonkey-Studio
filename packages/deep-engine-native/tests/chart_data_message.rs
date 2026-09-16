use deep_engine_native::chart::{ChartRuntime, parse_chart_data_update, parse_chart_ir};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_slice(include_bytes!(
        "../../deep-engine/fixtures/chart-data-update-v1.json"
    ))
    .unwrap()
}
fn message() -> Value {
    fixture()["steps"][0]["message"].clone()
}
fn runtime() -> ChartRuntime {
    ChartRuntime::new(
        parse_chart_ir(&serde_json::to_vec(&fixture()["source"]).unwrap()).unwrap(),
        640.0,
        360.0,
    )
    .unwrap()
}

#[test]
fn typescript_and_native_apply_the_same_versioned_source_updates() {
    let f = fixture();
    let mut chart = runtime();
    for step in f["steps"].as_array().unwrap() {
        let update =
            parse_chart_data_update(&serde_json::to_vec(&step["message"]).unwrap()).unwrap();
        let evidence = chart.apply_data_message(update).unwrap();
        assert_eq!(
            evidence.data_revision,
            step["expected"]["dataRevision"].as_u64().unwrap()
        );
        let expected =
            parse_chart_ir(&serde_json::to_vec(&step["expected"]["ir"]).unwrap()).unwrap();
        assert_eq!(chart.source(), &expected);
        assert!(evidence.geometry_rebuilt);
    }
}

#[test]
fn foreign_and_stale_messages_do_not_modify_the_active_chart() {
    let mut chart = runtime();
    let old = chart.clone();
    let mut foreign = message();
    foreign["chartId"] = json!("foreign");
    assert!(
        chart
            .apply_data_message(
                parse_chart_data_update(&serde_json::to_vec(&foreign).unwrap()).unwrap()
            )
            .is_err()
    );
    assert!(std::ptr::eq(chart.frame(), old.frame()));
    assert_eq!(chart.data_revision(), 0);
    chart
        .apply_data_message(
            parse_chart_data_update(&serde_json::to_vec(&message()).unwrap()).unwrap(),
        )
        .unwrap();
    let active = chart.clone();
    assert!(
        chart
            .apply_data_message(
                parse_chart_data_update(&serde_json::to_vec(&message()).unwrap()).unwrap()
            )
            .is_err()
    );
    assert!(std::ptr::eq(chart.frame(), active.frame()));
    assert_eq!(chart.data_revision(), 1);
}

#[test]
fn strict_fields_scalar_budgets_and_revision_fail_closed() {
    for (pointer, value) in [
        ("/schemaVersion", json!(2)),
        ("/chartId", json!("__proto__")),
        ("/dataRevision", json!(2)),
        ("/expectedDataRevision", json!(-1)),
        ("/dataRevision", json!(9007199254740992_u64)),
        ("/datasets/0/maxRows", json!(0)),
        ("/datasets/0/maxRows", json!(1.5)),
        ("/datasets/0/maxRows", json!(500001)),
        ("/datasets/0/kind", json!("unknown")),
        ("/datasets/0/rows", json!([[{"object":1}]])),
        ("/datasets/0/rows", json!([["😀".repeat(2049)]])),
        ("/datasets/0/rows", json!([vec![1; 65]])),
        ("/datasets", json!([])),
    ] {
        let mut v = message();
        *v.pointer_mut(pointer).unwrap() = value;
        assert!(
            parse_chart_data_update(&serde_json::to_vec(&v).unwrap()).is_err(),
            "accepted {pointer}"
        );
    }
    let mut v = message();
    v["unexpected"] = json!(true);
    assert!(parse_chart_data_update(&serde_json::to_vec(&v).unwrap()).is_err());
    let mut v = message();
    v["datasets"][0]["unexpected"] = json!(true);
    assert!(parse_chart_data_update(&serde_json::to_vec(&v).unwrap()).is_err());
    let mut v = message();
    let duplicate = v["datasets"][0].clone();
    v["datasets"].as_array_mut().unwrap().push(duplicate);
    assert!(parse_chart_data_update(&serde_json::to_vec(&v).unwrap()).is_err());
}

#[test]
fn integral_float_spellings_match_javascript_revision_and_row_identity() {
    let text = serde_json::to_string(&message())
        .unwrap()
        .replace("\"schemaVersion\":1", "\"schemaVersion\":1.0")
        .replace("\"dataRevision\":1", "\"dataRevision\":1e0")
        .replace("\"maxRows\":2", "\"maxRows\":2.0");
    let parsed = parse_chart_data_update(text.as_bytes()).unwrap();
    assert_eq!(parsed.data_revision, 1);
    let mut chart = runtime();
    let active = chart.clone();
    let mut v = message();
    v["datasets"][0] =
        json!({"kind":"replace", "datasetId":"main", "rows":chart.source().datasets[0].rows});
    v["datasets"][0]["rows"][0][1] = json!(1.0);
    let evidence = chart
        .apply_data_message(parse_chart_data_update(&serde_json::to_vec(&v).unwrap()).unwrap())
        .unwrap();
    assert!(evidence.changed_datasets.is_empty());
    assert!(std::ptr::eq(chart.frame(), active.frame()));
}

#[test]
fn oversized_and_malformed_wire_messages_are_rejected_before_dispatch() {
    assert!(parse_chart_data_update(b"not JSON").is_err());
    assert!(parse_chart_data_update(&vec![b' '; 16 * 1024 * 1024 + 1]).is_err());
}
