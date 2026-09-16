use deep_engine_native::chart::{ChartIR, parse_chart_ir, validate_chart_ir};
use serde_json::{Value, json};

fn golden() -> Value {
    serde_json::from_str(include_str!("../../deep-engine/fixtures/chart-ir-v1.json")).unwrap()
}

#[test]
fn byte_reader_applies_budget_schema_and_semantics_before_returning() {
    let bytes = include_bytes!("../../deep-engine/fixtures/chart-ir-v1.json");
    assert!(parse_chart_ir(bytes).is_ok());
    assert!(parse_chart_ir(b"{").is_err());
    let mut source = golden();
    source["legend"]["position"] = json!("future");
    assert!(parse_chart_ir(&serde_json::to_vec(&source).unwrap()).is_err());
    source = golden();
    source["id"] = json!("constructor");
    assert!(parse_chart_ir(&serde_json::to_vec(&source).unwrap()).is_err());
    source = golden();
    source["series"][0]["label"] = json!("😀".repeat(2049));
    let error = parse_chart_ir(&serde_json::to_vec(&source).unwrap()).unwrap_err();
    assert_eq!(
        error.diagnostics[0].code,
        deep_engine_native::chart::ChartDiagnosticCode::BudgetExceeded
    );
}

#[test]
fn rejects_the_shared_ts_negative_corpus_from_valid_baselines() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../deep-engine/fixtures/chart-ir-v1-invalid.json"
    ))
    .unwrap();
    for case in cases {
        let mut source = golden();
        if let Some(index) = case["seriesOnly"].as_u64() {
            source["series"] = json!([source["series"][index as usize].clone()]);
            source["actions"] = json!([]);
        }
        if case["logY"].as_bool() == Some(true) {
            source["axes"][1]["scale"] = json!("log");
        }
        let baseline: ChartIR = serde_json::from_value(source.clone()).unwrap();
        assert!(
            validate_chart_ir(&baseline).valid,
            "baseline {}",
            case["name"]
        );
        let pointer = case["pointer"].as_str().unwrap();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        let target = source.pointer_mut(parent).unwrap();
        if let Some(object) = target.as_object_mut() {
            object.insert(key.into(), case["value"].clone());
        } else {
            target[key.parse::<usize>().unwrap()] = case["value"].clone();
        }
        let accepted =
            serde_json::from_value::<ChartIR>(source).is_ok_and(|ir| validate_chart_ir(&ir).valid);
        assert!(!accepted, "{}", case["name"]);
    }
}

#[test]
fn rejects_non_finite_one_sided_axis_limits_in_programmatic_ir() {
    let mut ir: ChartIR = serde_json::from_value(golden()).unwrap();
    ir.axes[0].min = Some(f64::NAN);
    assert!(!validate_chart_ir(&ir).valid);
    ir.axes[0].min = None;
    ir.axes[0].max = Some(f64::INFINITY);
    assert!(!validate_chart_ir(&ir).valid);
}

// JSON 数值采用 TS 的 double 语义，Rust 序列化的 10.0 与输入 10 等价。
fn numeric_semantics(value: Value) -> Value {
    match value {
        Value::Number(number) => json!(number.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.into_iter().map(numeric_semantics).collect()),
        Value::Object(items) => Value::Object(
            items
                .into_iter()
                .map(|(key, value)| (key, numeric_semantics(value)))
                .collect(),
        ),
        other => other,
    }
}

#[test]
fn preserves_the_actual_ts_compiled_six_series_and_interaction_golden() {
    let source = golden();
    let ir: ChartIR = serde_json::from_value(source.clone()).unwrap();
    assert!(validate_chart_ir(&ir).valid);
    assert_eq!(
        numeric_semantics(serde_json::to_value(&ir).unwrap()),
        numeric_semantics(source)
    );
    assert_eq!(ir.series.len(), 6);
    assert_eq!(ir.actions.len(), 5);
    assert_eq!(ir.data_zoom[0].start, 10.0);
    assert!(!ir.legend.visible);
}

#[test]
fn rejects_missing_compiled_fields_instead_of_restoring_author_defaults() {
    for key in [
        "legend",
        "tooltip",
        "dataZoom",
        "actions",
        "sourceSpecVersion",
    ] {
        let mut source = golden();
        source.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<ChartIR>(source).is_err(), "{key}");
    }
    for pointer in ["/axes/0", "/actions/0"] {
        let mut source = golden();
        source
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(if pointer.contains("axes") {
                "min"
            } else {
                "dataIndex"
            });
        assert!(
            serde_json::from_value::<ChartIR>(source).is_err(),
            "{pointer}"
        );
    }
}

#[test]
fn rejects_unknown_fields_at_every_contract_object_boundary() {
    for pointer in [
        "",
        "/datasets/0",
        "/axes/0",
        "/series/0",
        "/legend",
        "/tooltip",
        "/dataZoom/0",
        "/actions/0",
    ] {
        let mut source = golden();
        source
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("future".into(), json!(true));
        assert!(
            serde_json::from_value::<ChartIR>(source).is_err(),
            "{pointer}"
        );
    }
}

#[test]
fn validates_source_version_and_interaction_references_ranges_and_budgets() {
    for (pointer, value) in [
        ("/sourceSpecVersion", json!(2)),
        ("/dataZoom/0/start", json!(90)),
        ("/dataZoom/0/axisId", json!("missing")),
        ("/actions/0/seriesId", json!("missing")),
        ("/actions/1/dataIndex", json!(2)),
        ("/actions/4/end", json!(101)),
    ] {
        let mut source = golden();
        *source.pointer_mut(pointer).unwrap() = value;
        let ir: ChartIR = serde_json::from_value(source).unwrap();
        assert!(!validate_chart_ir(&ir).valid, "{pointer}");
    }
    let mut ir: ChartIR = serde_json::from_value(golden()).unwrap();
    ir.data_zoom.push(ir.data_zoom[0].clone());
    assert!(!validate_chart_ir(&ir).valid);
    ir.data_zoom.truncate(1);
    ir.actions = vec![ir.actions[0].clone(); 513];
    assert!(!validate_chart_ir(&ir).valid);
}
