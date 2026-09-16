use deep_engine_native::{
    chart::{parse_chart_ir, simulation::parse_chart_sim_fixture},
    runtime_package::parse_and_validate_runtime_package,
};

const DYNAMIC: &[u8] = include_bytes!("../../deep-engine/fixtures/chart-runtime-v1.json");
const STATIC: &[u8] = include_bytes!("../../deep-engine/fixtures/chart-runtime-static-v1.json");

#[test]
fn typescript_chart_package_decodes_frozen_ir_and_replay_fixture() {
    let package = parse_and_validate_runtime_package(DYNAMIC).unwrap();
    assert_eq!(package.package_id, "chart.main");
    assert!(package.render_packet.geometries.is_empty());
    assert!(package.render_packet.instances.is_empty());
    assert!(package.deep2d.is_none());
    let chart = package.chart.as_ref().expect("versioned chart entry");
    assert_eq!(chart.id, "chart-v1-golden");
    assert_eq!(chart.series.len(), 6);
    let fixture = package.chart_sim.as_ref().expect("offline replay entry");
    assert_eq!(fixture.chart_id, chart.id);
    assert!(fixture.interval_ms > 0);
    let static_package = parse_and_validate_runtime_package(STATIC).unwrap();
    assert!(static_package.chart.is_some());
    assert!(static_package.chart_sim.is_none());
}

#[test]
fn decoded_chart_payloads_feed_the_same_runtime_pipeline_as_the_standalone_cli() {
    let package = parse_and_validate_runtime_package(DYNAMIC).unwrap();
    let chart = package.chart.clone().unwrap();
    let fixture = package.chart_sim.clone().unwrap();
    let mut runtime = deep_engine_native::chart::ChartRuntime::new(chart, 640.0, 360.0).unwrap();
    let source =
        deep_engine_native::chart::simulation::ChartSimulationSource::new(fixture, &runtime)
            .unwrap();
    let frame = source
        .prepare(0, 0)
        .unwrap()
        .expect("first sim frame is due immediately");
    let revision = runtime.data_revision();
    assert!(runtime.apply_data_message(frame.message().clone()).is_ok());
    assert_ne!(runtime.data_revision(), revision);
}

#[test]
fn tampered_chart_payload_fails_package_validation() {
    for pointer in ["chart", "chartSim"] {
        let mut value: serde_json::Value = serde_json::from_slice(DYNAMIC).unwrap();
        let id = value["entrypoints"][pointer].as_str().unwrap().to_owned();
        let payload_key = if pointer == "chart" {
            "chart"
        } else {
            "fixture"
        };
        value["payloads"][&id][payload_key] = serde_json::json!({"broken":true});
        assert!(
            parse_and_validate_runtime_package(&serde_json::to_vec(&value).unwrap()).is_err(),
            "{pointer} tamper accepted"
        );
    }
    assert!(parse_and_validate_runtime_package(DYNAMIC).is_ok());
}

#[test]
fn v4_entrypoint_contract_is_enforced_on_the_same_file() {
    let mutate = |edit: &dyn Fn(&mut serde_json::Value)| {
        let mut value: serde_json::Value = serde_json::from_slice(DYNAMIC).unwrap();
        edit(&mut value);
        parse_and_validate_runtime_package(&serde_json::to_vec(&value).unwrap()).is_err()
    };
    // chart/chartSim 键缺失、chart 置空、chartSim 孤立、版本降级、入口 kind 错误均拒绝。
    assert!(mutate(&|v| {
        v["entrypoints"]["chart"] = serde_json::Value::Null;
    }));
    assert!(mutate(&|v| {
        let obj = v["entrypoints"].as_object_mut().unwrap();
        obj.remove("chartSim");
    }));
    assert!(mutate(&|v| {
        let obj = v["entrypoints"].as_object_mut().unwrap();
        obj.remove("chart");
    }));
    assert!(mutate(&|v| {
        v["schemaVersion"] = serde_json::json!(3);
    }));
    assert!(mutate(&|v| {
        v["schemaVersion"] = serde_json::json!(2);
    }));
    assert!(mutate(&|v| {
        v["entrypoints"]["deep2d"] = v["entrypoints"]["chart"].clone();
    }));
    // 静态包是合法 v4(chart 非空、chartSim 为 null 键)。
    assert!(parse_and_validate_runtime_package(STATIC).is_ok());
}

#[test]
fn chart_entry_alone_still_matches_shared_ir_fixture_semantics() {
    let package = parse_and_validate_runtime_package(DYNAMIC).unwrap();
    let bytes = serde_json::to_vec(&package.chart.as_ref().unwrap()).unwrap();
    let direct = parse_chart_ir(&bytes).unwrap();
    assert_eq!(direct.id, "chart-v1-golden");
    let sim_bytes = serde_json::to_vec(package.chart_sim.as_ref().unwrap()).unwrap();
    assert!(parse_chart_sim_fixture(&sim_bytes).is_ok());
}
