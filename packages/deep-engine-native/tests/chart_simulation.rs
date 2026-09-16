use deep_engine_native::chart::simulation::{
    ChartSimFixture, ChartSimulationSource, parse_chart_sim_fixture,
};
use deep_engine_native::chart::{ChartRuntime, parse_chart_ir};
use serde_json::{Value, json};

fn runtime() -> ChartRuntime {
    ChartRuntime::new(
        parse_chart_ir(include_bytes!(
            "../../deep-engine/fixtures/chart-ir-v1.json"
        ))
        .unwrap(),
        640.0,
        360.0,
    )
    .unwrap()
}
fn fixture() -> ChartSimFixture {
    parse_chart_sim_fixture(include_bytes!(
        "../../deep-engine/fixtures/chart-sim-v1.json"
    ))
    .unwrap()
}
fn source(chart: &ChartRuntime) -> ChartSimulationSource {
    ChartSimulationSource::new(fixture(), chart).unwrap()
}
fn wire(frame: &deep_engine_native::chart::simulation::ChartSimFrame) -> Value {
    serde_json::to_value(frame.message()).unwrap()
}

#[test]
fn deterministic_clock_seed_and_bounded_window_follow_committed_ticks() {
    let mut chart = runtime();
    let mut sim = source(&chart);
    for (tick, label) in ["D", "E", "C", "D"].iter().enumerate() {
        let due = tick as u64 * 100;
        if due > 0 {
            assert!(
                sim.prepare(due - 1, chart.data_revision())
                    .unwrap()
                    .is_none()
            );
        }
        let frame = sim.prepare(due, chart.data_revision()).unwrap().unwrap();
        assert_eq!(frame.captured_at_ms, 1767225600000 + due);
        assert_eq!(wire(&frame)["datasets"][0]["rows"][0][0], *label);
        chart.apply_data_message(frame.message().clone()).unwrap();
        sim.commit(frame, chart.data_revision()).unwrap();
        assert_eq!(chart.data_revision(), tick as u64 + 1);
        assert_eq!(chart.source().datasets[0].rows.len(), 3);
        assert_eq!(chart.source().datasets[0].rows[2][0], *label);
    }
}

#[test]
fn rejected_candidate_retries_same_tick_and_does_not_consume_active_data() {
    let chart = runtime();
    let mut sim = source(&chart);
    let frame = sim.prepare(0, 0).unwrap().unwrap();
    let expected = wire(&frame);
    let mut gpu_candidate = chart.clone();
    gpu_candidate
        .apply_data_message(frame.message().clone())
        .unwrap();
    // 模拟 GPU stage 拒绝；候选丢弃，活动图表和生产游标均不可前进。
    drop(gpu_candidate);
    assert!(sim.commit(frame, chart.data_revision()).is_err());
    let retry = sim.prepare(10_000, 0).unwrap().unwrap();
    assert_eq!(wire(&retry), expected);
    assert_eq!(sim.next_due_ms().unwrap(), 0);
    assert_eq!(chart.data_revision(), 0);
}

#[test]
fn frames_from_a_replaced_source_and_cancelled_sources_are_rejected() {
    let chart = runtime();
    let old = source(&chart);
    let mut replacement = source(&chart);
    let late = old.prepare(0, 0).unwrap().unwrap();
    assert!(replacement.commit(late, 1).is_err());
    assert_eq!(replacement.next_due_ms().unwrap(), 0);
    let pending = replacement.prepare(0, 0).unwrap().unwrap();
    replacement.cancel();
    assert!(replacement.commit(pending, 1).is_err());
    assert!(replacement.prepare(u64::MAX, 0).unwrap().is_none());
}

#[test]
fn duplicate_prepared_frames_cannot_advance_the_clock_twice() {
    let chart = runtime();
    let mut sim = source(&chart);
    let first = sim.prepare(0, 0).unwrap().unwrap();
    let duplicate = sim.prepare(0, 0).unwrap().unwrap();
    sim.commit(first, 1).unwrap();
    assert!(sim.commit(duplicate, 1).is_err());
    assert_eq!(sim.next_due_ms().unwrap(), 100);
}

#[test]
fn delayed_wake_replays_each_tick_without_skipping_samples() {
    let chart = runtime();
    let mut sim = source(&chart);
    for revision in 0..5 {
        let frame = sim.prepare(10_000, revision).unwrap().unwrap();
        assert_eq!(frame.captured_at_ms, 1767225600000 + revision * 100);
        sim.commit(frame, revision + 1).unwrap();
    }
    assert_eq!(sim.next_due_ms().unwrap(), 500);
}

#[test]
fn invalid_binding_clock_and_discarded_rows_fail_before_subscription() {
    let chart = runtime();
    let original = serde_json::to_value(fixture()).unwrap();
    for (key, value) in [
        ("schemaVersion", json!(2)),
        ("id", json!("__proto__")),
        ("chartId", json!("foreign")),
        ("datasetId", json!("unknown")),
        ("dimensions", json!(["wrong"])),
        ("rows", json!([])),
        ("intervalMs", json!(0)),
        ("intervalMs", json!(86400001)),
        ("maxRows", json!(0)),
        ("startTimeMs", json!(9007199254740992_u64)),
        ("maxRows", json!(500001)),
    ] {
        let mut value_json = original.clone();
        value_json[key] = value;
        let fixture = parse_chart_sim_fixture(&serde_json::to_vec(&value_json).unwrap()).unwrap();
        assert!(
            ChartSimulationSource::new(fixture, &chart).is_err(),
            "accepted {key}"
        );
    }
    let mut invalid = fixture();
    invalid.max_rows = 1;
    invalid.rows[0] = vec![json!({"bad": true})];
    assert!(ChartSimulationSource::new(invalid, &chart).is_err());
    assert_eq!(chart.data_revision(), 0);
}

#[test]
fn unsafe_clock_and_revision_exhaustion_do_not_advance_source() {
    let chart = runtime();
    let mut fixture = fixture();
    fixture.start_time_ms = 9007199254740991;
    let mut sim = ChartSimulationSource::new(fixture, &chart).unwrap();
    assert!(sim.prepare(0, 9007199254740991).is_err());
    let frame = sim.prepare(0, 0).unwrap().unwrap();
    sim.commit(frame, 1).unwrap();
    assert!(sim.prepare(100, 1).is_err());
    assert_eq!(sim.next_due_ms().unwrap(), 100);
}

#[test]
fn wire_parser_rejects_extra_fields_large_inputs_and_fractional_integers() {
    let mut value = serde_json::to_value(fixture()).unwrap();
    value["extra"] = json!(true);
    assert!(parse_chart_sim_fixture(&serde_json::to_vec(&value).unwrap()).is_err());
    value.as_object_mut().unwrap().remove("extra");
    value["seed"] = json!(1.5);
    assert!(parse_chart_sim_fixture(&serde_json::to_vec(&value).unwrap()).is_err());
    value["seed"] = json!(1.0);
    assert_eq!(
        parse_chart_sim_fixture(&serde_json::to_vec(&value).unwrap())
            .unwrap()
            .seed,
        1
    );
    assert!(parse_chart_sim_fixture(&vec![b' '; 16 * 1024 * 1024 + 1]).is_err());
    assert!(parse_chart_sim_fixture(b"bad JSON").is_err());
}

#[test]
fn native_replays_typescript_clock_messages_and_complete_chart_sources() {
    let golden: Value = serde_json::from_slice(include_bytes!(
        "../../deep-engine/fixtures/chart-sim-replay-v1.json"
    ))
    .unwrap();
    let mut chart = ChartRuntime::new(
        parse_chart_ir(&serde_json::to_vec(&golden["source"]).unwrap()).unwrap(),
        640.0,
        360.0,
    )
    .unwrap();
    let fixture =
        parse_chart_sim_fixture(&serde_json::to_vec(&golden["fixture"]).unwrap()).unwrap();
    let mut sim = ChartSimulationSource::new(fixture, &chart).unwrap();
    for step in golden["steps"].as_array().unwrap() {
        let frame = sim
            .prepare(step["elapsedMs"].as_u64().unwrap(), chart.data_revision())
            .unwrap()
            .unwrap();
        assert_eq!(frame.captured_at_ms, step["capturedAtMs"].as_u64().unwrap());
        assert_eq!(wire(&frame), step["message"]);
        chart.apply_data_message(frame.message().clone()).unwrap();
        sim.commit(frame, chart.data_revision()).unwrap();
        assert_eq!(
            chart.data_revision(),
            step["expected"]["dataRevision"].as_u64().unwrap()
        );
        assert_eq!(
            chart.source(),
            &parse_chart_ir(&serde_json::to_vec(&step["expected"]["ir"]).unwrap()).unwrap()
        );
    }
}
